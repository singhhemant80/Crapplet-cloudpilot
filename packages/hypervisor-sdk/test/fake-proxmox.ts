import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Minimal in-process emulation of the Proxmox VE REST API, served over real TLS
 * with a throwaway self-signed certificate. Used for adapter contract tests.
 * It models the request/response shapes the adapter relies on; it is NOT a
 * substitute for validating against a live cluster.
 */
export interface FakeVm {
  vmid: number;
  node: string;
  name: string;
  template: 0 | 1;
  status: 'running' | 'stopped';
  config: Record<string, string>;
  snapshots?: string[];
}

export class FakeProxmox {
  server!: Server;
  port = 0;
  ca = '';
  readonly token = 'cloudpilot@pve!automation=11111111-2222-3333-4444-555555555555';
  vms = new Map<number, FakeVm>();
  tasks = new Map<string, { ok: boolean }>();
  requests: Array<{ method: string; path: string; body: URLSearchParams }> = [];
  failClone = false;
  nextId = 100;

  constructor() {
    this.vms.set(9000, {
      vmid: 9000,
      node: 'pve1',
      name: 'ubuntu-2404-ci',
      template: 1,
      status: 'stopped',
      config: { scsi0: 'local-lvm:base-9000-disk-0,size=3584M', net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0' },
    });
  }

  private task(node: string, ok = true) {
    const id = `UPID:${node}:0000${this.tasks.size}:task:`;
    this.tasks.set(id, { ok });
    return id;
  }

  async start() {
    const dir = mkdtempSync(join(tmpdir(), 'fakepve-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    this.ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
    this.server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: this.ca }, (req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const url = new URL(req.url!, 'https://localhost');
        const body = new URLSearchParams(req.method === 'GET' || req.method === 'DELETE' ? url.search : raw);
        this.requests.push({ method: req.method!, path: url.pathname, body });
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(status < 300 ? { data } : { errors: data, data: null }));
        };
        if (req.headers.authorization !== `PVEAPIToken=${this.token}`) return send(401, 'authentication failure');
        try {
          this.route(req.method!, url.pathname.replace('/api2/json', ''), body, send);
        } catch (e) {
          send(500, (e as Error).message);
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop() {
    await new Promise((r) => this.server.close(r));
  }

  private route(method: string, path: string, body: URLSearchParams, send: (s: number, d: unknown) => void) {
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/version') return send(200, { version: '8.3.2', release: '8.3' });
    if (method === 'GET' && path === '/nodes')
      return send(200, [{ node: 'pve1', status: 'online', maxcpu: 32, cpu: 0.1, maxmem: 2 ** 37, mem: 2 ** 34, uptime: 1000 }]);
    if (method === 'GET' && (m = /^\/nodes\/(\w+)\/storage$/.exec(path)))
      return send(200, [{ storage: 'local-lvm', type: 'lvmthin', content: 'images,rootdir', total: 1e12, used: 1e11, active: 1, shared: 0 }]);
    if (method === 'GET' && (m = /^\/nodes\/(\w+)\/network$/.exec(path)))
      return send(200, [
        { iface: 'vmbr0', type: 'bridge', bridge_vlan_aware: 1, active: 1 },
        { iface: 'eno1', type: 'eth', active: 1 },
      ]);
    if (method === 'GET' && path === '/cluster/resources')
      return send(200, [...this.vms.values()].map((v) => ({ vmid: v.vmid, node: v.node, name: v.name, template: v.template, type: 'qemu', status: v.status })));
    if (method === 'GET' && path === '/cluster/nextid') {
      while (this.vms.has(this.nextId)) this.nextId++;
      return send(200, String(this.nextId));
    }
    if (method === 'GET' && (m = /^\/nodes\/(\w+)\/tasks\/([^/]+)\/status$/.exec(path))) {
      const t = this.tasks.get(decodeURIComponent(m[2]));
      if (!t) return send(404, 'no such task');
      return send(200, { status: 'stopped', exitstatus: t.ok ? 'OK' : 'clone failed: storage full' });
    }
    if ((m = /^\/nodes\/(\w+)\/qemu\/(\d+)(\/.*)?$/.exec(path))) {
      const [, node, idStr, sub = ''] = m;
      const vmid = Number(idStr);
      const vm = this.vms.get(vmid);
      if (method === 'POST' && sub === '/clone') {
        if (!vm || vm.template !== 1) return send(400, 'not a template');
        const newid = Number(body.get('newid'));
        if (this.vms.has(newid)) return send(500, `VM ${newid} already exists`);
        if (!this.failClone) {
          this.vms.set(newid, {
            vmid: newid,
            node: body.get('target') ?? node,
            name: body.get('name')!,
            template: 0,
            status: 'stopped',
            config: { ...vm.config },
          });
        }
        return send(200, this.task(node, !this.failClone));
      }
      if (!vm) return send(500, `Configuration file 'nodes/${node}/qemu-server/${vmid}.conf' does not exist`);
      if (method === 'PUT' && sub === '/config') {
        for (const [k, v] of body) vm.config[k] = v;
        return send(200, null);
      }
      if (method === 'GET' && sub === '/config') return send(200, vm.config);
      if (method === 'PUT' && sub === '/resize') {
        vm.config.scsi0 = vm.config.scsi0.replace(/size=[^,]+/, `size=${body.get('size')}`);
        return send(200, null);
      }
      if (method === 'GET' && sub === '/status/current')
        return send(200, { status: vm.status, name: vm.name, cpus: Number(vm.config.cores ?? 1), maxmem: Number(vm.config.memory ?? 512) * 2 ** 20, agent: 0 });
      if (method === 'POST' && (m = /^\/status\/(start|stop|shutdown|reboot)$/.exec(sub))) {
        vm.status = m[1] === 'stop' || m[1] === 'shutdown' ? 'stopped' : 'running';
        return send(200, this.task(node));
      }
      if (method === 'DELETE' && sub === '') {
        if (vm.status === 'running') return send(500, 'VM is running');
        this.vms.delete(vmid);
        return send(200, this.task(node));
      }
      if (method === 'POST' && sub === '/snapshot') {
        (vm.snapshots ??= []).push(body.get('snapname')!);
        return send(200, this.task(node));
      }
      if (method === 'GET' && sub === '/snapshot')
        return send(200, [...(vm.snapshots ?? []).map((n) => ({ name: n, snaptime: 1700000000 })), { name: 'current', running: 1 }]);
      if ((m = /^\/snapshot\/([\w-]+)(\/rollback)?$/.exec(sub))) {
        if (!(vm.snapshots ?? []).includes(m[1])) return send(500, `snapshot '${m[1]}' does not exist`);
        if (method === 'DELETE') vm.snapshots = vm.snapshots!.filter((x) => x !== m![1]);
        return send(200, this.task(node));
      }
      if (method === 'POST' && sub === '/vncproxy') return send(200, { ticket: 'PVEVNC:abc', port: '5901' });
      if (method === 'GET' && sub === '/rrddata') return send(200, [{ time: 1700000000, cpu: 0.2, mem: 1e9 }]);
    }
    send(501, `fake proxmox: unhandled ${method} ${path}`);
  }
}
