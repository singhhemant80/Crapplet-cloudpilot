import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryStateStore,
  MockHypervisorAdapter,
  ProviderError,
  ProxmoxAdapter,
  UnsupportedOperationError,
  type CreateInstanceSpec,
  type HypervisorAdapter,
} from '../src';
import { FakeProxmox } from './fake-proxmox';

const fake = new FakeProxmox();

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});

function proxmox(extra: Partial<{ ca: string; secret: string }> = {}) {
  const [tokenId, tokenSecret] = fake.token.split('=');
  return new ProxmoxAdapter({
    endpoint: `https://127.0.0.1:${fake.port}`,
    credentials: { tokenId, tokenSecret: extra.secret ?? tokenSecret },
    caCertificate: extra.ca ?? fake.ca,
    options: { taskPollMs: 5 },
  });
}

const spec = (name: string, templateId: string): CreateInstanceSpec => ({
  name,
  kind: 'vm',
  node: 'pve1',
  templateId,
  cpuCores: 2,
  memoryMb: 2048,
  diskGb: 40,
  bridge: 'vmbr0',
  vlanTag: 120,
  ips: [
    { version: 4, address: '203.0.113.10', prefixLength: 24, gateway: '203.0.113.1' },
    { version: 6, address: '2001:db8::10', prefixLength: 64, gateway: '2001:db8::1' },
  ],
  nameservers: ['1.1.1.1'],
  sshKeys: ['ssh-ed25519 AAAAC3Nza test@example'],
  username: 'cloud',
});

/** Behaviour every adapter must satisfy. */
function contract(name: string, make: () => HypervisorAdapter, templateId: string) {
  describe(`${name} adapter contract`, () => {
    it('reports capabilities and validates connection', async () => {
      const a = make();
      expect(a.capabilities().has('instance.create')).toBe(true);
      expect((await a.validateConnection()).ok).toBe(true);
    });

    it('discovers nodes, storage, bridges and templates', async () => {
      const a = make();
      expect((await a.listNodes()).length).toBeGreaterThan(0);
      expect((await a.listStorage()).some((s) => s.contentTypes.includes('images'))).toBe(true);
      expect((await a.listNetworks()).every((n) => n.id.startsWith('vmbr'))).toBe(true);
      expect((await a.listTemplates()).some((t) => t.id === templateId)).toBe(true);
    });

    it('creates, finds by name, powers, verifies IP config and deletes', async () => {
      const a = make();
      const vmName = `cp-${name}-contract-1`;
      const ref = await a.createInstance(spec(vmName, templateId));
      expect(await a.findInstanceByName(vmName)).toEqual(ref);
      await a.start(ref);
      const st = await a.getInstanceStatus(ref);
      expect(st.power).toBe('running');
      expect(st.configuredIps).toContain('203.0.113.10');
      await a.deleteInstance(ref);
      expect(await a.findInstanceByName(vmName)).toBeNull();
    });

    it('refuses to create a second instance with the same name', async () => {
      const a = make();
      const vmName = `cp-${name}-dupe`;
      await a.createInstance(spec(vmName, templateId));
      await expect(a.createInstance(spec(vmName, templateId))).rejects.toBeInstanceOf(ProviderError);
    });

    it('rejects unsupported resource kinds instead of simulating them', async () => {
      const a = make();
      if (a.capabilities().has('instance.create') && a.providerType === 'proxmox') {
        await expect(a.createInstance({ ...spec('cp-lxc', templateId), kind: 'lxc' })).rejects.toBeInstanceOf(UnsupportedOperationError);
      }
    });
  });
}

const memStore = new MemoryStateStore();
contract('mock', () => new MockHypervisorAdapter(memStore, 'test'), '9000');
contract('proxmox', () => proxmox(), '9000');

describe('proxmox adapter specifics', () => {
  it('sends cloud-init, VLAN-tagged NIC and grows the disk', async () => {
    const a = proxmox();
    const ref = await a.createInstance(spec('cp-detail', '9000'));
    const vm = fake.vms.get(Number(ref.id))!;
    expect(vm.config.ipconfig0).toBe('ip=203.0.113.10/24,gw=203.0.113.1,ip6=2001:db8::10/64,gw6=2001:db8::1');
    expect(vm.config.net0).toBe('virtio,bridge=vmbr0,tag=120');
    expect(vm.config.scsi0).toContain('size=40G');
    expect(decodeURIComponent(vm.config.sshkeys)).toContain('ssh-ed25519');
  });

  it('preserves the NIC MAC when reconfiguring network', async () => {
    const a = proxmox();
    const ref = await a.createInstance(spec('cp-mac', '9000'));
    fake.vms.get(Number(ref.id))!.config.net0 = 'virtio=BC:24:11:AA:BB:CC,bridge=vmbr0';
    await a.configureNetwork(ref, [{ version: 4, address: '203.0.113.20', prefixLength: 24 }], { vlanTag: 200 });
    expect(fake.vms.get(Number(ref.id))!.config.net0).toBe('virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,tag=200');
  });

  it('surfaces failed clone tasks as ProviderError (never success)', async () => {
    fake.failClone = true;
    try {
      await expect(proxmox().createInstance(spec('cp-failclone', '9000'))).rejects.toThrow(/storage full/);
    } finally {
      fake.failClone = false;
    }
  });

  it('fails authentication with a wrong secret', async () => {
    const r = await proxmox({ secret: 'wrong' }).validateConnection();
    expect(r.ok).toBe(false);
  });

  it('rejects an untrusted TLS certificate when no CA is given', async () => {
    const r = await proxmox({ ca: '-' }).validateConnection().catch((e) => ({ ok: false, message: String(e) }));
    expect(r.ok).toBe(false);
  });

  it('rejects non-https endpoints and malformed token ids', () => {
    expect(() => new ProxmoxAdapter({ endpoint: 'http://x:8006', credentials: { tokenId: 'a@pve!b', tokenSecret: 's' } })).toThrow();
    expect(() => new ProxmoxAdapter({ endpoint: 'https://x:8006', credentials: { tokenId: 'root', tokenSecret: 's' } })).toThrow();
  });
});

describe('snapshots and console', () => {
  for (const [name, make] of [
    ['mock', () => new MockHypervisorAdapter(new MemoryStateStore(), 'snap')],
    ['proxmox', () => proxmox()],
  ] as const) {
    it(`${name}: creates, lists, rolls back and deletes snapshots`, async () => {
      const a = make();
      const ref = await a.createInstance(spec(`cp-snap-${name}`, '9000'));
      await a.createSnapshot(ref, 'before-upgrade');
      expect((await a.listSnapshots(ref)).map((s) => s.name)).toEqual(['before-upgrade']);
      await a.rollbackSnapshot(ref, 'before-upgrade');
      await a.deleteSnapshot(ref, 'before-upgrade');
      expect(await a.listSnapshots(ref)).toEqual([]);
      await expect(a.rollbackSnapshot(ref, 'missing-one')).rejects.toBeInstanceOf(ProviderError);
    });
  }

  it('proxmox: builds an authenticated wss console upstream; mock does not offer a console', async () => {
    const a = proxmox();
    const ref = await a.createInstance(spec('cp-console', '9000'));
    const session = await a.openConsole(ref);
    const up = a.consoleUpstream(ref, session);
    expect(up.url).toMatch(new RegExp(`^wss://127.0.0.1:${fake.port}/api2/json/nodes/pve1/qemu/\\d+/vncwebsocket\\?port=5901&vncticket=PVEVNC`));
    expect(up.headers.Authorization).toMatch(/^PVEAPIToken=/);
    expect(up.rejectUnauthorized).toBe(true);
    const m = new MockHypervisorAdapter(new MemoryStateStore(), 'c');
    expect(m.capabilities().has('console.vnc')).toBe(false);
    expect(() => m.consoleUpstream()).toThrow(UnsupportedOperationError);
  });
});

describe('mock failure injection', () => {
  it('throws on injected create failure', async () => {
    const a = new MockHypervisorAdapter(new MemoryStateStore(), 'f', { failOn: ['create'] });
    await expect(a.createInstance(spec('x', '9000'))).rejects.toBeInstanceOf(ProviderError);
  });
});
