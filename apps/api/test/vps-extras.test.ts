import { MockHypervisorAdapter } from '@cloudpilot/hypervisor-sdk';
import { eq } from 'drizzle-orm';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { invoices, services, tenants } from '../src/db/schema';
import { attachConsoleProxy } from '../src/http/console-proxy';
import { ADMIN, buildWorld, makeReseller, orderInput, type World } from './helpers';

let w: World;
let bigProductId: string;
const mock = () => new MockHypervisorAdapter(w.mockStore, w.providerId);

beforeAll(async () => {
  w = await buildWorld();
  const big = await w.c.catalog.createProduct({ tenantId: w.tenantId, sku: 'VPS-4C8G', name: 'Linux VPS L', type: 'VPS_LINUX', status: 'ACTIVE', cpuCores: 4, memoryMb: 8192, diskGb: 120, ipv4Count: 1 });
  bigProductId = big.id;
  await w.c.catalog.upsertPlacement(w.tenantId, big.id, { locationId: w.locationId, providerId: w.providerId, node: 'mock-node-1', ipv4PoolId: w.v4PoolId, templateIds: [w.templateId] });
  await w.c.catalog.setPrice(w.tenantId, w.priceListId, big.id, 'MONTHLY', 90000n);
  const small = await w.c.catalog.createProduct({ tenantId: w.tenantId, sku: 'VPS-1C1G', name: 'Tiny', type: 'VPS_LINUX', status: 'ACTIVE', cpuCores: 1, memoryMb: 1024, diskGb: 20, ipv4Count: 1 });
  await w.c.catalog.upsertPlacement(w.tenantId, small.id, { locationId: w.locationId, providerId: w.providerId, node: 'mock-node-1', ipv4PoolId: w.v4PoolId, templateIds: [w.templateId] });
  await w.c.catalog.setPrice(w.tenantId, w.priceListId, small.id, 'MONTHLY', 20000n);
});
afterAll(async () => {
  await w.c.close();
});

async function activeResellerService(fund = 300000n) {
  const r = await makeReseller(w, { fundMinor: fund });
  const { order } = await w.c.orders.createResellerOrder(orderInput(w, r.id, `extras-${Math.random()}`));
  await w.q.runProvision(order.id);
  const [svc] = await w.c.db.select().from(services).where(eq(services.orderId, order.id));
  return { r, svc };
}

describe('upgrades', () => {
  it('reseller upgrade: prorated wallet charge, plan and VM resized; downgrades refused', async () => {
    const { r, svc } = await activeResellerService();
    // Half of a 30-day period left.
    await w.c.db.update(services).set({ nextDueDate: new Date(Date.now() + 15 * 86_400_000) }).where(eq(services.id, svc.id));
    const q = await w.c.extras.upgradeQuote(w.tenantId, svc.id, { resellerId: r.id }, 'VPS-4C8G');
    expect(q.to.renewalMinor).toBe(90000n);
    expect(Number(q.chargeMinor)).toBeGreaterThan(19000); // ≈ (900−500) × ~50%
    expect(Number(q.chargeMinor)).toBeLessThan(21000);
    const before = (await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR')).availableMinor;
    const res = await w.c.extras.requestUpgrade({ tenantId: w.tenantId, serviceId: svc.id, scope: { resellerId: r.id }, sku: 'VPS-4C8G', actor: ADMIN });
    expect('operation' in res && res.operation?.error).toBeFalsy();
    const after = (await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR')).availableMinor;
    expect(before - after).toBe(q.chargeMinor);
    const [up] = await w.c.db.select().from(services).where(eq(services.id, svc.id));
    expect([up.productId, up.cpuCores, up.memoryMb, up.diskGb, up.renewalMinor]).toEqual([bigProductId, 4, 8192, 120, 90000n]);
    const vm = await mock().getInstanceStatus({ node: up.node!, id: up.externalVmId! });
    expect([vm.cpuCores, vm.memoryMb, vm.power]).toEqual([4, 8192, 'running']);
    await expect(w.c.extras.upgradeQuote(w.tenantId, svc.id, { resellerId: r.id }, 'VPS-1C1G')).rejects.toMatchObject({ code: 'downgrade_not_supported' });
    // Another reseller cannot touch it.
    const other = await makeReseller(w);
    await expect(w.c.extras.upgradeQuote(w.tenantId, svc.id, { resellerId: other.id }, 'VPS-4C8G')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('customer upgrade: invoice first, resize after payment', async () => {
    const retail = await w.c.catalog.createPriceList(w.tenantId, 'Retail', 'INR', false, true);
    await w.c.catalog.setPrice(w.tenantId, retail.id, w.productId, 'MONTHLY', 60000n);
    await w.c.catalog.setPrice(w.tenantId, retail.id, bigProductId, 'MONTHLY', 100000n);
    const slug = (await w.c.db.select().from(tenants).where(eq(tenants.id, w.tenantId)))[0].slug;
    const reg = await w.c.auth.registerCustomer({ tenantSlug: slug, name: 'Up Grade', email: 'upgrade@example.in', password: 'customer-pass-123', country: 'IN', stateCode: '27' });
    const cust = reg.created ? reg.customerId : '';
    const { order, invoiceId } = await w.c.orders.createCustomerOrder({ tenantId: w.tenantId, customerId: cust, actor: ADMIN, idempotencyKey: 'up-1', productSku: 'VPS-2C4G', locationCode: 'IN-MUM-1', templateId: w.templateId, cycle: 'MONTHLY', hostname: 'up.example.in', password: 'Server-Pass-2026!' });
    await w.c.billing.recordManualPayment({ tenantId: w.tenantId, invoiceId: invoiceId!, amountMinor: (await w.c.billing.get(w.tenantId, invoiceId!)).totalMinor, reference: 'UTR-UP-1', actor: ADMIN });
    await w.q.runProvision(order.id);
    const [svc] = await w.c.db.select().from(services).where(eq(services.orderId, order.id));
    const res = await w.c.extras.requestUpgrade({ tenantId: w.tenantId, serviceId: svc.id, scope: { customerId: cust }, sku: 'VPS-4C8G', actor: ADMIN });
    expect('invoiceId' in res).toBe(true);
    expect((await w.c.db.select().from(services).where(eq(services.id, svc.id)))[0].cpuCores).toBe(2); // not before payment
    const [inv] = await w.c.db.select().from(invoices).where(eq(invoices.id, (res as { invoiceId: string }).invoiceId));
    expect(inv.kind).toBe('UPGRADE');
    await w.c.billing.recordManualPayment({ tenantId: w.tenantId, invoiceId: inv.id, amountMinor: inv.totalMinor, reference: 'UTR-UP-2', actor: ADMIN });
    const [up] = await w.c.db.select().from(services).where(eq(services.id, svc.id));
    expect([up.cpuCores, up.renewalMinor]).toEqual([4, 100000n]);
  });
});

describe('reinstall and snapshots', () => {
  it('reinstalls with a new OS, keeping name and IP', async () => {
    const { r, svc } = await activeResellerService();
    const opts = await w.c.extras.reinstallOptions(w.tenantId, svc.id, { resellerId: r.id });
    expect(opts.length).toBeGreaterThan(0);
    await expect(
      w.c.extras.requestReinstall({ tenantId: w.tenantId, serviceId: svc.id, scope: { resellerId: r.id }, templateId: crypto.randomUUID(), password: 'Reinstall-Pass-1', actor: ADMIN }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const res = await w.c.extras.requestReinstall({ tenantId: w.tenantId, serviceId: svc.id, scope: { resellerId: r.id }, templateId: opts[0].id, password: 'Reinstall-Pass-1', actor: ADMIN });
    expect(res.error).toBeUndefined();
    const [after] = await w.c.db.select().from(services).where(eq(services.id, svc.id));
    expect(after.status).toBe('ACTIVE');
    expect(after.externalVmId).not.toBe(svc.externalVmId); // a fresh VM
    const st = await mock().getInstanceStatus({ node: after.node!, id: after.externalVmId! });
    const ips = await w.c.ipam.addressesForService(w.c.db, svc.id);
    expect(st.configuredIps).toEqual(ips.map((i) => i.address));
    expect(st.name).toBe(svc.vmName);
  });

  it('snapshots: create, cap at 3, roll back, delete', async () => {
    const { r, svc } = await activeResellerService();
    const scope = { resellerId: r.id };
    for (const n of ['snap-a', 'snap-b', 'snap-c']) {
      expect((await w.c.extras.snapshotAction({ tenantId: w.tenantId, serviceId: svc.id, scope, action: 'snapshot_create', name: n, actor: ADMIN })).error).toBeUndefined();
    }
    await expect(w.c.extras.snapshotAction({ tenantId: w.tenantId, serviceId: svc.id, scope, action: 'snapshot_create', name: 'snap-d', actor: ADMIN })).rejects.toMatchObject({ code: 'snapshot_limit' });
    await expect(w.c.extras.snapshotAction({ tenantId: w.tenantId, serviceId: svc.id, scope, action: 'snapshot_create', name: '1bad name', actor: ADMIN })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await w.c.extras.snapshotAction({ tenantId: w.tenantId, serviceId: svc.id, scope, action: 'snapshot_rollback', name: 'snap-a', actor: ADMIN })).error).toBeUndefined();
    await w.c.extras.snapshotAction({ tenantId: w.tenantId, serviceId: svc.id, scope, action: 'snapshot_delete', name: 'snap-b', actor: ADMIN });
    expect((await w.c.extras.listSnapshots(w.tenantId, svc.id, scope)).map((s) => s.name)).toEqual(['snap-a', 'snap-c']);
  });

  it('console: refused on hypervisors without a console', async () => {
    const { r, svc } = await activeResellerService();
    await expect(w.c.extras.openConsole(w.tenantId, svc.id, { resellerId: r.id }, ADMIN)).rejects.toMatchObject({ code: 'console_unavailable' });
  });
});

describe('console websocket proxy', () => {
  it('relays frames both ways and accepts each token only once', async () => {
    const upstreamServer = createServer();
    const upstream = new WebSocketServer({ server: upstreamServer });
    let sawAuth = '';
    upstream.on('connection', (sock, req) => {
      sawAuth = String(req.headers.authorization);
      sock.on('message', (d) => sock.send(Buffer.from(`echo:${d.toString()}`)));
    });
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    const upPort = (upstreamServer.address() as { port: number }).port;

    const tokens = new Set(['good-token']);
    const proxyServer = createServer();
    attachConsoleProxy(proxyServer, async (t) =>
      tokens.delete(t) ? { url: `ws://127.0.0.1:${upPort}/vnc`, headers: { Authorization: 'PVEAPIToken=secret' }, rejectUnauthorized: true } : null,
    );
    await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r));
    const port = (proxyServer.address() as { port: number }).port;

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/console/ws?token=good-token`, ['binary']);
    const reply = await new Promise<string>((resolve, reject) => {
      client.on('open', () => client.send(Buffer.from('RFB 003.008')));
      client.on('message', (d) => resolve(d.toString()));
      client.on('error', reject);
    });
    expect(reply).toBe('echo:RFB 003.008');
    expect(sawAuth).toBe('PVEAPIToken=secret'); // credentials added server-side only
    client.close();

    const reused = await new Promise<string>((resolve) => {
      const c2 = new WebSocket(`ws://127.0.0.1:${port}/v1/console/ws?token=good-token`);
      c2.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      c2.on('open', () => resolve('opened'));
      c2.on('error', () => resolve('error'));
    });
    expect(reused).toBe('401');
    proxyServer.close();
    upstreamServer.close();
  });
});
