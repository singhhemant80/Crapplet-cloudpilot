import { MockHypervisorAdapter } from '@cloudpilot/hypervisor-sdk';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipAddresses, orders, services, walletHolds } from '../src/db/schema';
import { ADMIN, buildWorld, makeReseller, orderInput, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await w.c.close();
});

const mock = (world: World) => new MockHypervisorAdapter(world.mockStore, world.providerId);
const balances = (world: World, resellerId: string) => world.c.ledger.balances(world.c.db, world.tenantId, resellerId, 'INR');

describe('reseller VPS order → provisioning → ACTIVE', () => {
  it('reserves funds and IP, provisions, verifies, then captures and allocates', async () => {
    const r = await makeReseller(w, { fundMinor: 200000n });
    const { order, replayed } = await w.c.orders.createResellerOrder(orderInput(w, r.id, 'whmcs:site1:service:1001'));
    expect(replayed).toBe(false);
    expect(order.status).toBe('QUEUED');
    expect(order.encryptedSecret).toMatch(/^v1\./); // password stored encrypted only
    expect(await balances(w, r.id)).toMatchObject({ availableMinor: 150000n, reservedMinor: 50000n });
    const [ip] = await w.c.db.select().from(ipAddresses).where(eq(ipAddresses.orderId, order.id));
    expect(ip.status).toBe('RESERVED');

    const out = await w.q.runProvision(order.id);
    expect(out).toEqual({ result: 'active' });

    const detail = await w.c.orders.get(w.tenantId, order.id, r.id);
    expect(detail.status).toBe('ACTIVE');
    expect(detail.events.map((e) => e.status)).toEqual(
      expect.arrayContaining(['PAID_OR_AUTHORIZED', 'QUEUED', 'PROVISIONING', 'CONFIGURING_NETWORK', 'VERIFYING', 'ACTIVE']),
    );
    const [o] = await w.c.db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.encryptedSecret).toBeNull(); // secret wiped after activation
    expect(detail.service!.status).toBe('ACTIVE');
    expect(detail.service!.nextDueDate).not.toBeNull();
    expect(detail.ips).toEqual([{ address: ip.address, status: 'ALLOCATED', version: 4 }]);
    expect(await balances(w, r.id)).toMatchObject({ availableMinor: 150000n, reservedMinor: 0n });

    const vm = await mock(w).findInstanceByName(detail.service!.vmName);
    expect(vm).not.toBeNull();
    const st = await mock(w).getInstanceStatus(vm!);
    expect(st.power).toBe('running');
    expect(st.configuredIps).toEqual([ip.address]);
    expect((await w.c.ledger.reconcile(w.tenantId)).problems).toEqual([]);
  });

  it('duplicate callbacks with the same key return the same order and never double-charge', async () => {
    const r = await makeReseller(w, { fundMinor: 200000n });
    const input = orderInput(w, r.id, 'whmcs:site1:service:2002');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => w.c.orders.createResellerOrder(input)));
    const fulfilled = results.filter((x) => x.status === 'fulfilled') as PromiseFulfilledResult<{ order: { id: string } }>[];
    expect(fulfilled.length).toBe(10);
    expect(new Set(fulfilled.map((f) => f.value.order.id)).size).toBe(1);
    expect(await balances(w, r.id)).toMatchObject({ availableMinor: 150000n, reservedMinor: 50000n });

    // Provisioning job delivered twice: one VM, one capture.
    const id = fulfilled[0].value.order.id;
    await w.q.runProvision(id);
    expect(await w.q.runProvision(id)).toMatchObject({ result: 'skipped' });
    const [svc] = await w.c.db.select().from(services).where(eq(services.orderId, id));
    const vms = JSON.parse((await w.mockStore.get(`mockhv:${w.providerId}:vms`))!) as Record<string, { name: string }>;
    expect(Object.values(vms).filter((v) => v.name === svc.vmName)).toHaveLength(1);
    expect(await balances(w, r.id)).toMatchObject({ availableMinor: 150000n, reservedMinor: 0n });
  });

  it('rejects an idempotency key reused with a different payload', async () => {
    const r = await makeReseller(w, { fundMinor: 200000n });
    await w.c.orders.createResellerOrder(orderInput(w, r.id, 'k-reuse'));
    await expect(w.c.orders.createResellerOrder(orderInput(w, r.id, 'k-reuse', { hostname: 'other.example' }))).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    });
  });

  it('adopts a VM left behind by a crashed attempt instead of creating a second one', async () => {
    const r = await makeReseller(w, { fundMinor: 200000n });
    const { order } = await w.c.orders.createResellerOrder(orderInput(w, r.id, 'crash-1'));
    const [svc] = await w.c.db.select().from(services).where(eq(services.orderId, order.id));
    // Simulate: worker created the VM, then died before recording its id.
    await mock(w).createInstance({ name: svc.vmName, kind: 'vm', node: 'mock-node-1', templateId: '9000', cpuCores: 2, memoryMb: 4096, diskGb: 60, ips: [] });
    expect(await w.q.runProvision(order.id)).toEqual({ result: 'active' });
    const detail = await w.c.orders.get(w.tenantId, order.id);
    expect(detail.events.some((e) => /Adopted existing VM/.test(e.message))).toBe(true);
  });

  it('insufficient funds rejects the order without reserving anything', async () => {
    const r = await makeReseller(w, { fundMinor: 10000n });
    const freeBefore = (await w.c.ipam.listAddresses(w.tenantId, w.v4PoolId, 'AVAILABLE')).length;
    await expect(w.c.orders.createResellerOrder(orderInput(w, r.id, 'poor-1'))).rejects.toMatchObject({ code: 'insufficient_funds', httpStatus: 402 });
    expect(await w.c.db.select().from(orders).where(eq(orders.resellerId, r.id))).toHaveLength(0);
    expect((await w.c.ipam.listAddresses(w.tenantId, w.v4PoolId, 'AVAILABLE')).length).toBe(freeBefore);
  });

  it('honours a customer-selected IP and refuses one that is taken', async () => {
    const r = await makeReseller(w, { fundMinor: 200000n });
    const free = await w.c.ipam.listSelectable(w.tenantId, w.v4PoolId);
    const chosen = free[free.length - 1].address;
    const { order } = await w.c.orders.createResellerOrder(orderInput(w, r.id, 'pick-1', { ipv4Address: chosen }));
    expect((await w.c.orders.get(w.tenantId, order.id)).ips[0].address).toBe(chosen);
    await expect(w.c.orders.createResellerOrder(orderInput(w, r.id, 'pick-2', { ipv4Address: chosen }))).rejects.toMatchObject({ code: 'ip_unavailable' });
    // The failed order must not leave a hold behind (whole transaction rolled back).
    expect(await balances(w, r.id)).toMatchObject({ reservedMinor: 50000n });
  });

  it('enforces tenant isolation between resellers', async () => {
    const a = await makeReseller(w, { fundMinor: 200000n });
    const b = await makeReseller(w, { fundMinor: 200000n });
    const { order } = await w.c.orders.createResellerOrder(orderInput(w, a.id, 'iso-1'));
    await expect(w.c.orders.get(w.tenantId, order.id, b.id)).rejects.toMatchObject({ httpStatus: 404 });
    const [svc] = await w.c.db.select().from(services).where(eq(services.orderId, order.id));
    await expect(w.c.serviceOps.details(w.tenantId, svc.id, { resellerId: b.id })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(w.c.serviceOps.renew(w.tenantId, svc.id, b.id, 'inv-1', ADMIN)).rejects.toMatchObject({ httpStatus: 404 });
    // Same external key in another reseller is a different order.
    const other = await w.c.orders.createResellerOrder(orderInput(w, b.id, 'iso-1'));
    expect(other.order.id).not.toBe(order.id);
  });
});

describe('provisioning failure recovery', () => {
  it('permanent create failure: order FAILED, funds released, IP back in pool', async () => {
    const fw = await buildWorld({ failures: { failOn: ['create'] } });
    try {
      const r = await makeReseller(fw, { fundMinor: 100000n });
      const { order } = await fw.c.orders.createResellerOrder(orderInput(fw, r.id, 'fail-create'));
      const out = await fw.q.runProvision(order.id);
      expect(out.result).toBe('failed');
      const [o] = await fw.c.db.select().from(orders).where(eq(orders.id, order.id));
      expect(o.status).toBe('FAILED');
      expect(o.encryptedSecret).toBeNull();
      const [hold] = await fw.c.db.select().from(walletHolds).where(eq(walletHolds.orderId, order.id));
      expect(hold.status).toBe('RELEASED');
      expect(await balances(fw, r.id)).toMatchObject({ availableMinor: 100000n, reservedMinor: 0n });
      expect(await fw.c.db.select().from(ipAddresses).where(and(eq(ipAddresses.orderId, order.id)))).toHaveLength(0);
      expect((await fw.c.ledger.reconcile(fw.tenantId)).problems).toEqual([]);
    } finally {
      await fw.c.close();
    }
  });

  it('verification failure: partial VM is deleted before funds are released; never marked ACTIVE', async () => {
    const fw = await buildWorld({ failures: { guestIpMismatch: true } });
    try {
      const r = await makeReseller(fw, { fundMinor: 100000n });
      const { order } = await fw.c.orders.createResellerOrder(orderInput(fw, r.id, 'fail-verify'));
      const out = await fw.q.runProvision(order.id);
      expect(out.result).toBe('failed');
      const detail = await fw.c.orders.get(fw.tenantId, order.id);
      expect(detail.status).toBe('FAILED');
      expect(detail.service!.status).toBe('FAILED');
      expect(detail.events.some((e) => /removed partial VM/.test(e.message))).toBe(true);
      expect(await mock(fw).findInstanceByName(detail.service!.vmName)).toBeNull();
      expect(await balances(fw, r.id)).toMatchObject({ availableMinor: 100000n });
    } finally {
      await fw.c.close();
    }
  });

  it('when cleanup cannot be confirmed, the order is parked with funds and IP still held', async () => {
    const fw = await buildWorld({ failures: { guestIpMismatch: true, failOn: ['delete'] } });
    try {
      const r = await makeReseller(fw, { fundMinor: 100000n });
      const { order } = await fw.c.orders.createResellerOrder(orderInput(fw, r.id, 'fail-cleanup'));
      expect((await fw.q.runProvision(order.id)).result).toBe('needs_attention');
      const detail = await fw.c.orders.get(fw.tenantId, order.id);
      expect(detail.status).toBe('NEEDS_ATTENTION');
      expect(detail.ips[0].status).toBe('RESERVED');
      expect(await balances(fw, r.id)).toMatchObject({ reservedMinor: 50000n });
    } finally {
      await fw.c.close();
    }
  });
});

describe('service lifecycle', () => {
  it('renews exactly once per idempotency key, suspends, unsuspends and terminates', async () => {
    const r = await makeReseller(w, { fundMinor: 300000n });
    const { order } = await w.c.orders.createResellerOrder(orderInput(w, r.id, 'life-1'));
    await w.q.runProvision(order.id);
    const [svc] = await w.c.db.select().from(services).where(eq(services.orderId, order.id));

    const first = await w.c.serviceOps.renew(w.tenantId, svc.id, r.id, 'whmcs-invoice-77', ADMIN);
    const again = await w.c.serviceOps.renew(w.tenantId, svc.id, r.id, 'whmcs-invoice-77', ADMIN);
    expect(again.replayed).toBe(true);
    expect(again.renewal.id).toBe(first.renewal.id);
    expect((await balances(w, r.id)).availableMinor).toBe(300000n - 50000n - 50000n);
    const [afterRenew] = await w.c.db.select().from(services).where(eq(services.id, svc.id));
    expect(afterRenew.nextDueDate!.getTime()).toBeGreaterThan(svc.nextDueDate!.getTime());

    const op = (action: 'suspend' | 'unsuspend' | 'terminate' | 'stop') =>
      w.c.queue.runServiceOperation({ serviceId: svc.id, action, actor: ADMIN }, `${svc.id}-${action}`, 1000);
    expect((await op('suspend')).result).toEqual({ status: 'SUSPENDED' });
    const vm = (await mock(w).findInstanceByName(svc.vmName))!;
    expect((await mock(w).getInstanceStatus(vm)).power).toBe('stopped');
    expect((await op('stop')).error?.code).toBe('service_not_active'); // power ops blocked while suspended
    expect((await op('unsuspend')).result).toEqual({ status: 'ACTIVE' });
    expect((await mock(w).getInstanceStatus(vm)).power).toBe('running');
    expect((await op('terminate')).result).toEqual({ status: 'TERMINATED' });
    expect(await mock(w).findInstanceByName(svc.vmName)).toBeNull();
    const ips = await w.c.db.select().from(ipAddresses).where(eq(ipAddresses.serviceId, svc.id));
    expect(ips[0].status).toBe('QUARANTINED');
    await expect(w.c.serviceOps.renew(w.tenantId, svc.id, r.id, 'after-term', ADMIN)).rejects.toMatchObject({ code: 'service_not_renewable' });
  });

  it('manual-approval products wait for an administrator', async () => {
    const r = await makeReseller(w, { fundMinor: 200000n });
    const p = await w.c.catalog.createProduct({
      tenantId: w.tenantId, sku: 'VPS-MANUAL', name: 'Managed VPS', type: 'VPS_LINUX', status: 'ACTIVE',
      provisioning: 'MANUAL_APPROVAL', cpuCores: 4, memoryMb: 8192, diskGb: 100,
    });
    await w.c.catalog.upsertPlacement(w.tenantId, p.id, {
      locationId: w.locationId, providerId: w.providerId, node: 'mock-node-1', ipv4PoolId: w.v4PoolId, templateIds: [w.templateId],
    });
    await w.c.catalog.setPrice(w.tenantId, w.priceListId, p.id, 'MONTHLY', 90000n);
    const { order } = await w.c.orders.createResellerOrder({ ...orderInput(w, r.id, 'manual-1'), productSku: 'VPS-MANUAL' });
    expect(order.status).toBe('PAID_OR_AUTHORIZED');
    expect(w.q.provisionJobs).not.toContain(order.id);
    await w.c.orders.approve(w.tenantId, order.id, ADMIN);
    expect(await w.q.runProvision(order.id)).toEqual({ result: 'active' });
  });

  it('keeps the books balanced after everything above', async () => {
    expect((await w.c.ledger.reconcile(w.tenantId)).problems).toEqual([]);
  });
});
