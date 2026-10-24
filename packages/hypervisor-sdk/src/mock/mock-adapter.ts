import { ProviderError } from '../errors';
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
  StorageInfo,
  TemplateInfo,
} from '../types';

/**
 * Persistent key-value store for mock hypervisor state.
 * The API and worker run as separate processes, so dev/staging use a
 * Redis-backed store; unit tests use MemoryStateStore.
 */
export interface MockStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Atomic increment, used for id allocation. */
  incr(key: string): Promise<number>;
}

export class MemoryStateStore implements MockStateStore {
  private data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async incr(key: string) {
    const n = Number(this.data.get(key) ?? '0') + 1;
    this.data.set(key, String(n));
    return n;
  }
}

export interface MockFailureConfig {
  /** Operations that always fail. Used for failure-path testing. */
  failOn?: Array<'create' | 'network' | 'start' | 'verify' | 'delete'>;
  /** If true, the guest never reports the configured IP (verification failure). */
  guestIpMismatch?: boolean;
}

interface MockVm {
  id: string;
  node: string;
  name: string;
  power: 'running' | 'stopped';
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  ips: IpAssignment[];
  createdAt: string;
  snapshots: string[];
}

const ALL_CAPS: Capability[] = [
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

/**
 * Deterministic mock hypervisor for development and automated tests.
 * Clearly labelled as "mock" in the UI; it never touches real infrastructure.
 */
export class MockHypervisorAdapter implements HypervisorAdapter {
  readonly providerType = 'mock';
  private readonly caps = new Set<Capability>(ALL_CAPS);

  constructor(
    private readonly store: MockStateStore,
    private readonly namespace: string,
    private readonly failures: MockFailureConfig = {},
  ) {}

  capabilities(): ReadonlySet<Capability> {
    return this.caps;
  }

  private key(k: string) {
    return `mockhv:${this.namespace}:${k}`;
  }

  private async loadVms(): Promise<Record<string, MockVm>> {
    const raw = await this.store.get(this.key('vms'));
    return raw ? (JSON.parse(raw) as Record<string, MockVm>) : {};
  }

  private async saveVms(vms: Record<string, MockVm>) {
    await this.store.set(this.key('vms'), JSON.stringify(vms));
  }

  private async mustGet(ref: InstanceRef): Promise<[Record<string, MockVm>, MockVm]> {
    const vms = await this.loadVms();
    const vm = vms[ref.id];
    if (!vm) throw new ProviderError(`VM ${ref.id} not found`, false, 404);
    return [vms, vm];
  }

  private fail(op: NonNullable<MockFailureConfig['failOn']>[number]) {
    if (this.failures.failOn?.includes(op)) {
      throw new ProviderError(`Mock provider injected failure on "${op}"`, false, 500);
    }
  }

  async validateConnection(): Promise<ConnectionCheck> {
    return { ok: true, version: 'mock-1.0', message: 'Mock hypervisor (no real infrastructure)' };
  }

  async listNodes(): Promise<NodeInfo[]> {
    return [
      { name: 'mock-node-1', status: 'online', cpuCores: 64, cpuUsage: 0.12, memoryTotalBytes: 256 * 2 ** 30, memoryUsedBytes: 40 * 2 ** 30 },
      { name: 'mock-node-2', status: 'online', cpuCores: 64, cpuUsage: 0.31, memoryTotalBytes: 256 * 2 ** 30, memoryUsedBytes: 90 * 2 ** 30 },
    ];
  }

  async listStorage(node?: string): Promise<StorageInfo[]> {
    const nodes = node ? [node] : ['mock-node-1', 'mock-node-2'];
    return nodes.flatMap((n) => [
      { node: n, id: 'local-lvm', type: 'lvmthin', contentTypes: ['images', 'rootdir'], totalBytes: 2e12, usedBytes: 4e11, active: true, shared: false },
      { node: n, id: 'ceph-rbd', type: 'rbd', contentTypes: ['images'], totalBytes: 2e13, usedBytes: 6e12, active: true, shared: true },
    ]);
  }

  async listNetworks(node?: string): Promise<NetworkInfo[]> {
    const nodes = node ? [node] : ['mock-node-1', 'mock-node-2'];
    return nodes.map((n) => ({ node: n, id: 'vmbr0', type: 'bridge', vlanAware: true, active: true }));
  }

  async listTemplates(): Promise<TemplateInfo[]> {
    return [
      { id: '9000', node: 'mock-node-1', name: 'ubuntu-24.04-cloudinit', kind: 'vm', cloudInit: true },
      { id: '9001', node: 'mock-node-1', name: 'debian-12-cloudinit', kind: 'vm', cloudInit: true },
      { id: '9002', node: 'mock-node-1', name: 'almalinux-9-cloudinit', kind: 'vm', cloudInit: true },
    ];
  }

  async findInstanceByName(name: string): Promise<InstanceRef | null> {
    const vms = await this.loadVms();
    const vm = Object.values(vms).find((v) => v.name === name);
    return vm ? { node: vm.node, id: vm.id } : null;
  }

  async createInstance(spec: CreateInstanceSpec): Promise<InstanceRef> {
    this.fail('create');
    const existing = await this.findInstanceByName(spec.name);
    if (existing) throw new ProviderError(`Instance named ${spec.name} already exists`, false, 409);
    const id = spec.preferredId ?? String(100 + (await this.store.incr(this.key('nextid'))));
    const vms = await this.loadVms();
    if (vms[id]) throw new ProviderError(`VM id ${id} already in use`, false, 409);
    vms[id] = {
      id,
      node: spec.node,
      name: spec.name,
      power: 'stopped',
      cpuCores: spec.cpuCores,
      memoryMb: spec.memoryMb,
      diskGb: spec.diskGb,
      ips: spec.ips,
      createdAt: new Date().toISOString(),
      snapshots: [],
    };
    await this.saveVms(vms);
    return { node: spec.node, id };
  }

  async getInstanceStatus(ref: InstanceRef): Promise<InstanceStatus> {
    this.fail('verify');
    const [, vm] = await this.mustGet(ref);
    const configured = vm.ips.map((i) => i.address);
    return {
      ref,
      name: vm.name,
      power: vm.power,
      cpuCores: vm.cpuCores,
      memoryMb: vm.memoryMb,
      configuredIps: configured,
      guestIps: vm.power === 'running' ? (this.failures.guestIpMismatch ? ['10.255.255.1'] : configured) : undefined,
    };
  }

  private async setPower(ref: InstanceRef, power: MockVm['power']) {
    const [vms, vm] = await this.mustGet(ref);
    vm.power = power;
    await this.saveVms(vms);
  }

  async start(ref: InstanceRef) {
    this.fail('start');
    await this.setPower(ref, 'running');
  }
  async stop(ref: InstanceRef) {
    await this.setPower(ref, 'stopped');
  }
  async shutdown(ref: InstanceRef) {
    await this.setPower(ref, 'stopped');
  }
  async reboot(ref: InstanceRef) {
    await this.setPower(ref, 'running');
  }

  async deleteInstance(ref: InstanceRef) {
    this.fail('delete');
    const vms = await this.loadVms();
    if (!vms[ref.id]) return; // delete is idempotent
    delete vms[ref.id];
    await this.saveVms(vms);
  }

  async configureNetwork(ref: InstanceRef, ips: IpAssignment[]) {
    this.fail('network');
    const [vms, vm] = await this.mustGet(ref);
    vm.ips = ips;
    await this.saveVms(vms);
  }

  async resize(ref: InstanceRef, spec: { cpuCores?: number; memoryMb?: number; diskGb?: number }) {
    const [vms, vm] = await this.mustGet(ref);
    if (spec.diskGb !== undefined && spec.diskGb < vm.diskGb) {
      throw new ProviderError('Disk shrinking is not supported', false, 400);
    }
    Object.assign(vm, Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== undefined)));
    await this.saveVms(vms);
  }

  async createSnapshot(ref: InstanceRef, name: string) {
    const [vms, vm] = await this.mustGet(ref);
    vm.snapshots.push(name);
    await this.saveVms(vms);
  }

  async openConsole(ref: InstanceRef): Promise<ConsoleSession> {
    await this.mustGet(ref);
    return { protocol: 'vnc', ticket: `mock-ticket-${ref.id}`, port: 5900, expiresAt: new Date(Date.now() + 60_000) };
  }

  async getMetrics(ref: InstanceRef, timeframe: 'hour' | 'day' | 'week'): Promise<MetricsSample[]> {
    const [, vm] = await this.mustGet(ref);
    const points = 30;
    const span = { hour: 3600, day: 86400, week: 604800 }[timeframe] * 1000;
    // Deterministic synthetic series derived from the VM id; labelled mock in UI.
    const seed = Number(vm.id) || 1;
    return Array.from({ length: points }, (_, i) => ({
      at: new Date(Date.now() - span + (span / points) * i),
      cpu: vm.power === 'running' ? 0.1 + 0.05 * Math.sin((i + seed) / 3) : 0,
      memoryUsedBytes: vm.power === 'running' ? vm.memoryMb * 0.4 * 2 ** 20 : 0,
    }));
  }
}
