import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { ProviderError, UnsupportedOperationError, isRetryableStatus } from '../errors';
import type {
  Capability,
  ConnectionCheck,
  ConsoleSession,
  CreateInstanceSpec,
  HypervisorAdapter,
  InstanceRef,
  InstanceStatus,
  IpAssignment,
  MetricsSample,
  NetworkInfo,
  NodeInfo,
  ProviderConnectionConfig,
  StorageInfo,
  TaskRef,
  TaskStatus,
  TemplateInfo,
} from '../types';

/**
 * Proxmox VE adapter (QEMU/KVM virtual machines) using the official REST API
 * (`/api2/json`) and API-token authentication.
 *
 * Required credentials: { tokenId: 'cloudpilot@pve!automation', tokenSecret: '<uuid>' }
 *
 * Least-privilege role for the token (see docs/integrations/proxmox.md):
 *   VM.Allocate VM.Clone VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk
 *   VM.Config.Memory VM.Config.Network VM.Config.Options VM.Audit VM.PowerMgmt VM.Console
 *   VM.Snapshot VM.Monitor Datastore.AllocateSpace Datastore.Audit Sys.Audit SDN.Use
 *
 * LXC containers are NOT advertised yet; requesting kind 'lxc' throws
 * UnsupportedOperationError instead of pretending to work.
 */

export interface ProxmoxOptions {
  /** Disk device that gets resized after clone. Default: scsi0 */
  diskName?: string;
  /** Network device that is (re)configured. Default: net0 */
  netDevice?: string;
  /** Poll interval for task tracking. */
  taskPollMs?: number;
  /** Max time to wait for a single Proxmox task. */
  taskTimeoutMs?: number;
  /** Clone as full copy (default true; linked clones need template storage support). */
  fullClone?: boolean;
}

const CAPS: Capability[] = [
  'discovery.nodes',
  'discovery.storage',
  'discovery.networks',
  'discovery.templates',
  'instance.create',
  'instance.clone',
  'instance.delete',
  'instance.power',
  'instance.resize',
  'network.ipconfig',
  'network.vlan',
  'snapshot',
  'console.vnc',
  'metrics',
  'tasks',
];

type Json = Record<string, unknown>;

export class ProxmoxAdapter implements HypervisorAdapter {
  readonly providerType = 'proxmox';
  private readonly caps = new Set<Capability>(CAPS);
  private readonly base: string;
  private readonly authHeader: string;
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly opts: Required<ProxmoxOptions>;

  constructor(config: ProviderConnectionConfig, private readonly log: (msg: string) => void = () => {}) {
    const { tokenId, tokenSecret } = config.credentials;
    if (!tokenId || !tokenSecret) throw new ProviderError('Proxmox requires tokenId and tokenSecret', false);
    if (!/^[^@\s]+@[^!\s]+![\w.-]+$/.test(tokenId)) {
      throw new ProviderError('tokenId must look like user@realm!tokenname', false);
    }
    const url = new URL(config.endpoint);
    if (url.protocol !== 'https:') throw new ProviderError('Proxmox endpoint must use https', false);
    this.base = `${url.origin}/api2/json`;
    this.authHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`;
    if (config.allowInsecureTls) this.log('WARNING: TLS verification disabled for Proxmox endpoint (development only)');
    this.dispatcher = new Agent({
      connect: {
        ca: config.caCertificate || undefined,
        rejectUnauthorized: !config.allowInsecureTls,
      },
    });
    this.timeoutMs = config.timeoutMs ?? 30_000;
    const o = (config.options ?? {}) as ProxmoxOptions;
    this.opts = {
      diskName: o.diskName ?? 'scsi0',
      netDevice: o.netDevice ?? 'net0',
      taskPollMs: o.taskPollMs ?? 1000,
      taskTimeoutMs: o.taskTimeoutMs ?? 10 * 60_000,
      fullClone: o.fullClone ?? true,
    };
  }

  capabilities(): ReadonlySet<Capability> {
    return this.caps;
  }

  // ---------------------------------------------------------------- HTTP

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params?: Json): Promise<T> {
    let url = `${this.base}${path}`;
    let body: string | undefined;
    const headers: Record<string, string> = { Authorization: this.authHeader, Accept: 'application/json' };
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined || v === null) continue;
      form.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    if (method === 'GET' || method === 'DELETE') {
      const qs = form.toString();
      if (qs) url += `?${qs}`;
    } else {
      body = form.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    let res;
    try {
      res = await undiciFetch(url, {
        method,
        headers,
        body,
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`Proxmox request failed: ${(err as Error).message}`, true);
    }
    const text = await res.text();
    let parsed: { data?: unknown; errors?: unknown; message?: string } = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const detail = parsed.errors ?? parsed.message ?? res.statusText;
      throw new ProviderError(
        `Proxmox ${method} ${path} → ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
        isRetryableStatus(res.status),
        res.status,
        detail,
      );
    }
    return parsed.data as T;
  }

  private qemu(ref: InstanceRef, sub = '') {
    if (!/^[\w.-]+$/.test(ref.node) || !/^\d+$/.test(ref.id)) throw new ProviderError('Invalid instance reference', false);
    return `/nodes/${encodeURIComponent(ref.node)}/qemu/${ref.id}${sub}`;
  }

  // ---------------------------------------------------------------- tasks

  async getTaskStatus(task: TaskRef): Promise<TaskStatus> {
    const s = await this.request<{ status: string; exitstatus?: string }>(
      'GET',
      `/nodes/${encodeURIComponent(task.node)}/tasks/${encodeURIComponent(task.id)}/status`,
    );
    if (s.status !== 'stopped') return { done: false, ok: false };
    return { done: true, ok: s.exitstatus === 'OK', message: s.exitstatus };
  }

  async waitForTask(task: TaskRef): Promise<void> {
    const deadline = Date.now() + this.opts.taskTimeoutMs;
    while (Date.now() < deadline) {
      const s = await this.getTaskStatus(task);
      if (s.done) {
        if (!s.ok) throw new ProviderError(`Proxmox task ${task.id} failed: ${s.message ?? 'unknown'}`, false, undefined, s.message);
        return;
      }
      await new Promise((r) => setTimeout(r, this.opts.taskPollMs));
    }
    // A timed-out task may still complete; caller must reconcile, not assume failure.
    throw new ProviderError(`Timed out waiting for Proxmox task ${task.id}`, true);
  }

  private async runTask(node: string, method: 'POST' | 'DELETE', path: string, params?: Json) {
    const upid = await this.request<string>(method, path, params);
    if (typeof upid === 'string' && upid.startsWith('UPID:')) await this.waitForTask({ node, id: upid });
  }

  // ---------------------------------------------------------------- discovery

  async validateConnection(): Promise<ConnectionCheck> {
    try {
      const v = await this.request<{ version: string; release?: string }>('GET', '/version');
      await this.request('GET', '/nodes'); // proves the token can see the cluster
      return { ok: true, version: v.version };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async listNodes(): Promise<NodeInfo[]> {
    const nodes = await this.request<Array<Json>>('GET', '/nodes');
    return nodes.map((n) => ({
      name: String(n.node),
      status: n.status === 'online' ? 'online' : n.status === 'offline' ? 'offline' : 'unknown',
      cpuCores: n.maxcpu as number | undefined,
      cpuUsage: n.cpu as number | undefined,
      memoryTotalBytes: n.maxmem as number | undefined,
      memoryUsedBytes: n.mem as number | undefined,
      uptimeSeconds: n.uptime as number | undefined,
    }));
  }

  private async nodeNames(node?: string) {
    return node ? [node] : (await this.listNodes()).filter((n) => n.status === 'online').map((n) => n.name);
  }

  async listStorage(node?: string): Promise<StorageInfo[]> {
    const out: StorageInfo[] = [];
    for (const n of await this.nodeNames(node)) {
      const rows = await this.request<Array<Json>>('GET', `/nodes/${encodeURIComponent(n)}/storage`);
      for (const s of rows) {
        out.push({
          node: n,
          id: String(s.storage),
          type: String(s.type),
          contentTypes: String(s.content ?? '').split(',').filter(Boolean),
          totalBytes: s.total as number | undefined,
          usedBytes: s.used as number | undefined,
          active: s.active === 1 || s.active === true,
          shared: s.shared === 1 || s.shared === true,
        });
      }
    }
    return out;
  }

  async listNetworks(node?: string): Promise<NetworkInfo[]> {
    const out: NetworkInfo[] = [];
    for (const n of await this.nodeNames(node)) {
      const rows = await this.request<Array<Json>>('GET', `/nodes/${encodeURIComponent(n)}/network`);
      for (const r of rows) {
        if (r.type !== 'bridge' && r.type !== 'OVSBridge') continue;
        out.push({
          node: n,
          id: String(r.iface),
          type: String(r.type),
          vlanAware: r.bridge_vlan_aware === 1 || r.bridge_vlan_aware === true,
          active: r.active === 1 || r.active === true,
          cidr: r.cidr as string | undefined,
        });
      }
    }
    return out;
  }

  async listTemplates(): Promise<TemplateInfo[]> {
    const rows = await this.request<Array<Json>>('GET', '/cluster/resources', { type: 'vm' });
    return rows
      .filter((r) => r.template === 1 && r.type === 'qemu')
      .map((r) => ({ id: String(r.vmid), node: String(r.node), name: String(r.name ?? r.vmid), kind: 'vm' as const }));
  }

  async findInstanceByName(name: string): Promise<InstanceRef | null> {
    const rows = await this.request<Array<Json>>('GET', '/cluster/resources', { type: 'vm' });
    const matches = rows.filter((r) => r.name === name && r.template !== 1);
    if (matches.length > 1) throw new ProviderError(`Multiple VMs named ${name}; manual intervention required`, false, 409);
    return matches[0] ? { node: String(matches[0].node), id: String(matches[0].vmid) } : null;
  }

  // ---------------------------------------------------------------- lifecycle

  private ipConfigString(ip: IpAssignment) {
    return ip.version === 4
      ? `ip=${ip.address}/${ip.prefixLength}${ip.gateway ? `,gw=${ip.gateway}` : ''}`
      : `ip6=${ip.address}/${ip.prefixLength}${ip.gateway ? `,gw6=${ip.gateway}` : ''}`;
  }

  /** Proxmox maps ipconfigN to netN; we put v4 and v6 on the same interface (ipconfig0). */
  private ipConfigParams(ips: IpAssignment[]): Json {
    const v4 = ips.find((i) => i.version === 4);
    const v6 = ips.find((i) => i.version === 6);
    const parts = [v4 && this.ipConfigString(v4), v6 && this.ipConfigString(v6)].filter(Boolean);
    return parts.length ? { ipconfig0: parts.join(',') } : {};
  }

  private static parseSizeGb(diskSpec: string | undefined): number | undefined {
    const m = /size=(\d+(?:\.\d+)?)([KMGT])/.exec(diskSpec ?? '');
    if (!m) return undefined;
    const factor = { K: 1 / 1024 / 1024, M: 1 / 1024, G: 1, T: 1024 }[m[2] as 'K' | 'M' | 'G' | 'T'];
    return Number(m[1]) * factor;
  }

  async createInstance(spec: CreateInstanceSpec): Promise<InstanceRef> {
    if (spec.kind !== 'vm') throw new UnsupportedOperationError(this.providerType, `create ${spec.kind}`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(spec.name)) throw new ProviderError('Invalid VM name for Proxmox', false);
    // Names are our idempotency handle: never create a second VM with the same name.
    if (await this.findInstanceByName(spec.name)) {
      throw new ProviderError(`Instance named ${spec.name} already exists`, false, 409);
    }

    const templates = await this.listTemplates();
    const tpl = templates.find((t) => t.id === spec.templateId);
    if (!tpl) throw new ProviderError(`Template ${spec.templateId} not found`, false, 404);

    const newid = spec.preferredId ?? String(await this.request<string | number>('GET', '/cluster/nextid'));
    await this.runTask(tpl.node, 'POST', `/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.id}/clone`, {
      newid,
      name: spec.name,
      full: this.opts.fullClone,
      storage: this.opts.fullClone ? spec.storage : undefined,
      target: spec.node !== tpl.node ? spec.node : undefined,
    });
    const ref: InstanceRef = { node: spec.node, id: newid };

    const net = [`virtio`, `bridge=${spec.bridge ?? 'vmbr0'}`];
    if (spec.vlanTag) net.push(`tag=${spec.vlanTag}`);
    await this.request('PUT', this.qemu(ref, '/config'), {
      cores: spec.cpuCores,
      memory: spec.memoryMb,
      [this.opts.netDevice]: net.join(','),
      ...this.ipConfigParams(spec.ips),
      nameserver: spec.nameservers?.join(' '),
      ciuser: spec.username,
      cipassword: spec.password,
      // Proxmox expects sshkeys URL-encoded inside the form value.
      sshkeys: spec.sshKeys?.length ? encodeURIComponent(spec.sshKeys.join('\n')) : undefined,
      tags: spec.tags?.length ? spec.tags.map((t) => t.replace(/[^\w-]/g, '')).join(';') : undefined,
    });

    const cfg = await this.request<Json>('GET', this.qemu(ref, '/config'));
    const current = ProxmoxAdapter.parseSizeGb(cfg[this.opts.diskName] as string | undefined);
    if (current !== undefined && spec.diskGb > current) {
      await this.request('PUT', this.qemu(ref, '/resize'), { disk: this.opts.diskName, size: `${spec.diskGb}G` });
    }
    return ref;
  }

  async getInstanceStatus(ref: InstanceRef): Promise<InstanceStatus> {
    const s = await this.request<Json>('GET', this.qemu(ref, '/status/current'));
    const cfg = await this.request<Json>('GET', this.qemu(ref, '/config'));
    const configuredIps = String(cfg.ipconfig0 ?? '')
      .split(',')
      .map((p) => /^ip6?=([^/]+)\//.exec(p)?.[1])
      .filter((x): x is string => Boolean(x));

    let guestIps: string[] | undefined;
    if (s.status === 'running' && s.agent === 1) {
      try {
        const r = await this.request<{ result: Array<{ 'ip-addresses'?: Array<{ 'ip-address': string }> }> }>(
          'GET',
          this.qemu(ref, '/agent/network-get-interfaces'),
        );
        guestIps = r.result.flatMap((i) => (i['ip-addresses'] ?? []).map((a) => a['ip-address']));
      } catch {
        guestIps = undefined; // agent not yet up — caller decides
      }
    }
    return {
      ref,
      name: String(s.name ?? ''),
      power: s.status === 'running' ? 'running' : s.status === 'stopped' ? 'stopped' : s.status === 'paused' ? 'paused' : 'unknown',
      cpuCores: s.cpus as number | undefined,
      memoryMb: typeof s.maxmem === 'number' ? Math.round(s.maxmem / 2 ** 20) : undefined,
      uptimeSeconds: s.uptime as number | undefined,
      configuredIps,
      guestIps,
      locked: Boolean(s.lock),
    };
  }

  async start(ref: InstanceRef) {
    await this.runTask(ref.node, 'POST', this.qemu(ref, '/status/start'));
  }
  async stop(ref: InstanceRef) {
    await this.runTask(ref.node, 'POST', this.qemu(ref, '/status/stop'));
  }
  async shutdown(ref: InstanceRef) {
    await this.runTask(ref.node, 'POST', this.qemu(ref, '/status/shutdown'), { timeout: 120 });
  }
  async reboot(ref: InstanceRef) {
    await this.runTask(ref.node, 'POST', this.qemu(ref, '/status/reboot'));
  }

  async deleteInstance(ref: InstanceRef) {
    let status: InstanceStatus;
    try {
      status = await this.getInstanceStatus(ref);
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 404 || err.status === 500) && /does not exist/i.test(err.message)) return;
      throw err;
    }
    if (status.power === 'running') await this.stop(ref);
    await this.runTask(ref.node, 'DELETE', this.qemu(ref), { purge: 1, 'destroy-unreferenced-disks': 1 });
  }

  async configureNetwork(ref: InstanceRef, ips: IpAssignment[], opts: { bridge?: string; vlanTag?: number; nameservers?: string[] } = {}) {
    const cfg = await this.request<Json>('GET', this.qemu(ref, '/config'));
    const params: Json = { ...this.ipConfigParams(ips) };
    if (opts.nameservers?.length) params.nameserver = opts.nameservers.join(' ');
    if (opts.bridge || opts.vlanTag !== undefined) {
      // Preserve the existing NIC model + MAC (e.g. "virtio=BC:24:11:..").
      const parts = String(cfg[this.opts.netDevice] ?? 'virtio').split(',');
      const model = parts[0];
      const rest = parts.slice(1).filter((p) => !p.startsWith('bridge=') && !p.startsWith('tag='));
      const net = [model, `bridge=${opts.bridge ?? (/bridge=([^,]+)/.exec(String(cfg[this.opts.netDevice]))?.[1] ?? 'vmbr0')}`, ...rest];
      if (opts.vlanTag) net.push(`tag=${opts.vlanTag}`);
      params[this.opts.netDevice] = net.join(',');
    }
    await this.request('PUT', this.qemu(ref, '/config'), params);
  }

  async resize(ref: InstanceRef, spec: { cpuCores?: number; memoryMb?: number; diskGb?: number }) {
    if (spec.cpuCores || spec.memoryMb) {
      await this.request('PUT', this.qemu(ref, '/config'), { cores: spec.cpuCores, memory: spec.memoryMb });
    }
    if (spec.diskGb) {
      const cfg = await this.request<Json>('GET', this.qemu(ref, '/config'));
      const current = ProxmoxAdapter.parseSizeGb(cfg[this.opts.diskName] as string | undefined) ?? 0;
      if (spec.diskGb < current) throw new ProviderError('Disk shrinking is not supported by Proxmox', false, 400);
      if (spec.diskGb > current) await this.request('PUT', this.qemu(ref, '/resize'), { disk: this.opts.diskName, size: `${spec.diskGb}G` });
    }
  }

  async createSnapshot(ref: InstanceRef, name: string, description?: string) {
    if (!/^[a-zA-Z][\w-]{1,39}$/.test(name)) throw new ProviderError('Invalid snapshot name', false);
    await this.runTask(ref.node, 'POST', this.qemu(ref, '/snapshot'), { snapname: name, description });
  }

  async openConsole(ref: InstanceRef): Promise<ConsoleSession> {
    const r = await this.request<{ ticket: string; port: string | number }>('POST', this.qemu(ref, '/vncproxy'), { websocket: 1 });
    return { protocol: 'vnc', ticket: r.ticket, port: Number(r.port), expiresAt: new Date(Date.now() + 2 * 60 * 60_000) };
  }

  async getMetrics(ref: InstanceRef, timeframe: 'hour' | 'day' | 'week'): Promise<MetricsSample[]> {
    const rows = await this.request<Array<Json>>('GET', this.qemu(ref, '/rrddata'), { timeframe, cf: 'AVERAGE' });
    return rows
      .filter((r) => typeof r.time === 'number')
      .map((r) => ({
        at: new Date((r.time as number) * 1000),
        cpu: r.cpu as number | undefined,
        memoryUsedBytes: r.mem as number | undefined,
        netInBytes: r.netin as number | undefined,
        netOutBytes: r.netout as number | undefined,
        diskReadBytes: r.diskread as number | undefined,
        diskWriteBytes: r.diskwrite as number | undefined,
      }));
  }
}
