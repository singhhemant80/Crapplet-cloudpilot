import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipAddresses } from '../src/db/schema';
import { cidrContains, enumerateHosts, normalizeIp, parseCidr } from '../src/common/ip';
import { buildWorld, type World } from './helpers';
import { dbError } from './db-error';

describe('ip math', () => {
  it('parses and enumerates IPv4 and IPv6', () => {
    expect(enumerateHosts('192.0.2.0/30', { limit: 10 })).toEqual(['192.0.2.1', '192.0.2.2']);
    expect(enumerateHosts('192.0.2.0/29', { limit: 10, exclude: ['192.0.2.1'] })).toHaveLength(5);
    expect(enumerateHosts('2001:db8::/120', { limit: 300, start: '2001:db8::10', end: '2001:db8::12' })).toEqual([
      '2001:db8::10',
      '2001:db8::11',
      '2001:db8::12',
    ]);
    expect(() => enumerateHosts('2001:db8::/64', { limit: 4096 })).toThrow(/limit/);
    expect(() => parseCidr('192.0.2.1/24')).toThrow(/host bits/);
    expect(normalizeIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('::ffff:c000:201');
    expect(cidrContains('10.0.0.0/8', '10.2.3.4')).toBe(true);
    expect(cidrContains('10.0.0.0/8', '11.0.0.1')).toBe(false);
  });
});

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await w.c.close();
});

describe('ipam reservations', () => {
  it('imports usable hosts excluding network, broadcast and gateway', async () => {
    const all = await w.c.ipam.listAddresses(w.tenantId, w.v4PoolId);
    expect(all).toHaveLength(13); // /28 = 16 − network − broadcast − gateway
    expect(all.map((a) => a.address)).not.toContain('203.0.113.1');
    expect(all[0].address).toBe('203.0.113.2');
  });

  it('only one of many concurrent requests for the same IP wins', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () =>
        w.c.ipam.reserve(w.c.db, { tenantId: w.tenantId, poolId: w.v4PoolId, address: '203.0.113.5', ttlMinutes: 10, reason: 'race test' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && /not available/.test(String(r.reason)))).toHaveLength(14);
  });

  it('auto-allocation hands out distinct addresses under concurrency and reports exhaustion', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () => w.c.ipam.reserve(w.c.db, { tenantId: w.tenantId, poolId: w.v4PoolId, ttlMinutes: 10, reason: 'bulk' })),
    );
    const won = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ address: string }>).value.address);
    expect(new Set(won).size).toBe(won.length);
    expect(won.length).toBe(12); // 13 minus the one reserved above
    expect(results.some((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'ip_pool_exhausted')).toBe(true);
  });

  it('expired checkout reservations are reclaimable; order-bound ones are not', async () => {
    await w.c.db.execute(sql`update ip_addresses set reserved_until = now() - interval '1 minute' where pool_id = ${w.v4PoolId} and address = '203.0.113.5'`);
    const r = await w.c.ipam.reserve(w.c.db, { tenantId: w.tenantId, poolId: w.v4PoolId, address: '203.0.113.5', ttlMinutes: 10, reason: 'reclaim' });
    expect(r.address).toBe('203.0.113.5');

    const orderId = crypto.randomUUID();
    await w.c.db.execute(sql`update ip_addresses set order_id = ${orderId}, reserved_until = now() - interval '1 minute' where address = '203.0.113.5' and pool_id = ${w.v4PoolId}`);
    await expect(
      w.c.ipam.reserve(w.c.db, { tenantId: w.tenantId, poolId: w.v4PoolId, address: '203.0.113.5', ttlMinutes: 10, reason: 'steal' }),
    ).rejects.toThrow(/not available/);
  });

  it('records every status transition in the allocation history', async () => {
    const hist = await w.c.ipam.history(w.tenantId, '203.0.113.5');
    expect(hist.rows.length).toBeGreaterThanOrEqual(2);
    expect(hist.rows.map((h) => h.reason)).toContain('race test');
  });

  it('database rejects an ALLOCATED address without a service', async () => {
    expect(await dbError(w.c.db.update(ipAddresses).set({ status: 'ALLOCATED', serviceId: null }).where(eq(ipAddresses.address, '203.0.113.6')))).toMatch(
      /ip_allocated_has_service_chk/,
    );
  });
});
