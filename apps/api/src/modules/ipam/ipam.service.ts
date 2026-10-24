import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database, DbOrTx, Tx } from '../../db/client';
import { ipAddresses, ipPools, locations } from '../../db/schema';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { cidrContains, enumerateHosts, normalizeIp, parseCidr } from '../../common/ip';
import { randomToken } from '../../common/crypto';

/**
 * IP address management.
 *
 * State machine:  AVAILABLE → RESERVED → ALLOCATED → QUARANTINED → (cooldown) → AVAILABLE
 *                 RESERVED → AVAILABLE (release/expiry)      * → RETIRED (admin)
 *
 * Double allocation is prevented by: a unique (tenant, address) index, single-statement
 * conditional UPDATEs with FOR UPDATE SKIP LOCKED, and CHECK constraints on each state.
 * Checkout reservations (no order yet) expire; reservations bound to an order do not —
 * they are released or allocated explicitly by the provisioning state machine.
 */

const MAX_IMPORT = 4096;

const reclaimable = sql`(
  ${ipAddresses.status} = 'AVAILABLE'
  or (${ipAddresses.status} = 'RESERVED' and ${ipAddresses.orderId} is null and ${ipAddresses.reservedUntil} < now())
  or (${ipAddresses.status} = 'QUARANTINED' and ${ipAddresses.quarantineUntil} < now())
)`;

async function setReason(tx: DbOrTx, reason: string) {
  await tx.execute(sql`select set_config('cloudpilot.ip_reason', ${reason}, true)`);
}

export interface CreatePoolInput {
  tenantId: string;
  locationId: string;
  name: string;
  cidr: string;
  gateway?: string;
  nameservers?: string[];
  vlanTag?: number;
  rangeStart?: string;
  rangeEnd?: string;
  exclude?: string[];
  customerSelectable?: boolean;
  quarantineHours?: number;
}

export class IpamService {
  constructor(private readonly db: Database) {}

  async createPool(input: CreatePoolInput) {
    let parsed;
    try {
      parsed = parseCidr(input.cidr);
    } catch (e) {
      throw Invalid((e as Error).message);
    }
    const [loc] = await this.db.select().from(locations).where(and(eq(locations.id, input.locationId), eq(locations.tenantId, input.tenantId)));
    if (!loc) throw NotFound('Location');
    const gateway = input.gateway ? normalizeIp(input.gateway) : undefined;
    if (gateway && !cidrContains(input.cidr, gateway)) throw Invalid(`Gateway ${gateway} is not inside ${input.cidr}`);

    let hosts: string[];
    try {
      hosts = enumerateHosts(input.cidr, {
        start: input.rangeStart,
        end: input.rangeEnd,
        exclude: [...(gateway ? [gateway] : []), ...(input.exclude ?? [])],
        limit: MAX_IMPORT,
      });
    } catch (e) {
      throw Invalid((e as Error).message);
    }

    return this.db.transaction(async (tx) => {
      const [pool] = await tx
        .insert(ipPools)
        .values({
          tenantId: input.tenantId,
          locationId: input.locationId,
          name: input.name,
          version: parsed.version,
          cidr: input.cidr.trim(),
          prefixLength: parsed.prefixLength,
          gateway,
          nameservers: input.nameservers ?? [],
          vlanTag: input.vlanTag,
          customerSelectable: input.customerSelectable ?? true,
          quarantineHours: input.quarantineHours ?? 72,
        })
        .returning();
      let inserted = 0;
      for (let i = 0; i < hosts.length; i += 500) {
        const rows = await tx
          .insert(ipAddresses)
          .values(hosts.slice(i, i + 500).map((address) => ({ tenantId: input.tenantId, poolId: pool.id, address })))
          .onConflictDoNothing()
          .returning({ id: ipAddresses.id });
        inserted += rows.length;
      }
      return { pool, imported: inserted, skippedExisting: hosts.length - inserted };
    });
  }

  async listPools(tenantId: string) {
    const rows = await this.db.execute(sql`
      select p.*, l.code as location_code,
        count(a.*) filter (where a.status = 'AVAILABLE') as available,
        count(a.*) filter (where a.status = 'RESERVED') as reserved,
        count(a.*) filter (where a.status = 'ALLOCATED') as allocated,
        count(a.*) filter (where a.status = 'QUARANTINED') as quarantined,
        count(a.*) as total
      from ip_pools p join locations l on l.id = p.location_id
      left join ip_addresses a on a.pool_id = p.id
      where p.tenant_id = ${tenantId}
      group by p.id, l.code order by p.created_at`);
    return rows.rows;
  }

  async listAddresses(tenantId: string, poolId: string, status?: string, limit = 256) {
    const where = [eq(ipAddresses.tenantId, tenantId), eq(ipAddresses.poolId, poolId)];
    if (status) where.push(eq(ipAddresses.status, status as (typeof ipAddresses.$inferSelect)['status']));
    return this.db
      .select()
      .from(ipAddresses)
      .where(and(...where))
      .orderBy(sql`${ipAddresses.address}::inet`)
      .limit(limit);
  }

  /** Addresses a customer/reseller may pick at checkout. */
  async listSelectable(tenantId: string, poolId: string, limit = 50) {
    const [pool] = await this.db.select().from(ipPools).where(and(eq(ipPools.id, poolId), eq(ipPools.tenantId, tenantId)));
    if (!pool) throw NotFound('IP pool');
    if (!pool.customerSelectable) return [];
    return this.db
      .select({ address: ipAddresses.address })
      .from(ipAddresses)
      .where(and(eq(ipAddresses.poolId, poolId), reclaimable))
      .orderBy(sql`${ipAddresses.address}::inet`)
      .limit(Math.min(limit, 256));
  }

  /**
   * Atomically reserves one address. With `address`, only that address is eligible;
   * otherwise the lowest free address is taken (SKIP LOCKED avoids contention).
   */
  async reserve(
    tx: DbOrTx,
    p: { tenantId: string; poolId: string; address?: string; resellerId?: string | null; orderId?: string | null; ttlMinutes: number; reason: string },
  ) {
    const token = randomToken(24);
    const target = p.address ? normalizeIp(p.address) : undefined;
    // Own transaction (or savepoint) so the transaction-local history reason applies to this UPDATE.
    const res = await tx.transaction(async (t) => {
      await setReason(t, p.reason);
      return t.execute(sql`
      update ip_addresses set
        status = 'RESERVED',
        reservation_token = ${token},
        reserved_until = now() + make_interval(mins => ${p.ttlMinutes}),
        reserved_by_reseller_id = ${p.resellerId ?? null},
        order_id = ${p.orderId ?? null},
        service_id = null,
        quarantine_until = null
      where id = (
        select id from ip_addresses
         where tenant_id = ${p.tenantId} and pool_id = ${p.poolId}
           ${target ? sql`and address = ${target}` : sql``}
           and ${reclaimable}
         order by address::inet
         limit 1
         for update skip locked)
      returning id, address, reservation_token, reserved_until`);
    });
    const row = res.rows[0] as { id: string; address: string; reservation_token: string; reserved_until: Date } | undefined;
    if (!row) {
      throw target
        ? Conflict('ip_unavailable', `IP ${target} is not available`)
        : Conflict('ip_pool_exhausted', 'No free addresses in the IP pool');
    }
    return { id: row.id, address: row.address, token: row.reservation_token, reservedUntil: row.reserved_until };
  }

  /** Binds a checkout reservation (token) to an order; it then no longer expires. */
  async bindReservation(tx: Tx, p: { tenantId: string; token: string; orderId: string; resellerId: string | null; poolId: string }) {
    await setReason(tx, 'bound to order');
    const rows = await tx
      .update(ipAddresses)
      .set({ orderId: p.orderId })
      .where(
        and(
          eq(ipAddresses.tenantId, p.tenantId),
          eq(ipAddresses.reservationToken, p.token),
          eq(ipAddresses.poolId, p.poolId),
          eq(ipAddresses.status, 'RESERVED'),
          sql`${ipAddresses.orderId} is null`,
          sql`${ipAddresses.reservedUntil} > now()`,
          p.resellerId ? eq(ipAddresses.reservedByResellerId, p.resellerId) : sql`${ipAddresses.reservedByResellerId} is null`,
        ),
      )
      .returning();
    if (!rows[0]) throw Conflict('ip_reservation_invalid', 'IP reservation is invalid, expired, or belongs to someone else');
    return rows[0];
  }

  /** Releases an unbound checkout reservation owned by the caller. */
  async cancelReservation(p: { tenantId: string; token: string; resellerId: string | null }) {
    return this.db.transaction(async (tx) => {
      await setReason(tx, 'checkout reservation cancelled');
      const rows = await tx
        .update(ipAddresses)
        .set({ status: 'AVAILABLE', reservationToken: null, reservedUntil: null, reservedByResellerId: null })
        .where(
          and(
            eq(ipAddresses.tenantId, p.tenantId),
            eq(ipAddresses.reservationToken, p.token),
            eq(ipAddresses.status, 'RESERVED'),
            sql`${ipAddresses.orderId} is null`,
            p.resellerId ? eq(ipAddresses.reservedByResellerId, p.resellerId) : sql`true`,
          ),
        )
        .returning();
      return rows.length > 0;
    });
  }

  async addressesForOrder(tx: DbOrTx, orderId: string) {
    return tx
      .select({ address: ipAddresses.address, status: ipAddresses.status, pool: ipPools })
      .from(ipAddresses)
      .innerJoin(ipPools, eq(ipPools.id, ipAddresses.poolId))
      .where(eq(ipAddresses.orderId, orderId))
      .orderBy(asc(ipPools.version));
  }

  async addressesForService(tx: DbOrTx, serviceId: string) {
    return tx
      .select({ address: ipAddresses.address, status: ipAddresses.status, version: ipPools.version })
      .from(ipAddresses)
      .innerJoin(ipPools, eq(ipPools.id, ipAddresses.poolId))
      .where(eq(ipAddresses.serviceId, serviceId));
  }

  /** RESERVED(order) → ALLOCATED(service), after the VM network config has been verified. */
  async allocateForOrder(tx: Tx, orderId: string, serviceId: string) {
    await setReason(tx, 'allocated after verified provisioning');
    return tx
      .update(ipAddresses)
      .set({ status: 'ALLOCATED', serviceId, reservationToken: null, reservedUntil: null })
      .where(and(eq(ipAddresses.orderId, orderId), sql`${ipAddresses.status} in ('RESERVED','ALLOCATED')`))
      .returning();
  }

  /** RESERVED(order) → AVAILABLE, used when an order fails before any VM could hold the address. */
  async releaseForOrder(tx: Tx, orderId: string, reason: string) {
    await setReason(tx, reason);
    return tx
      .update(ipAddresses)
      .set({ status: 'AVAILABLE', orderId: null, reservationToken: null, reservedUntil: null, reservedByResellerId: null })
      .where(and(eq(ipAddresses.orderId, orderId), eq(ipAddresses.status, 'RESERVED')))
      .returning();
  }

  /** ALLOCATED → QUARANTINED for the pool's cooldown, so stale DNS/ARP don't hit a new tenant. */
  async quarantineForService(tx: Tx, serviceId: string, reason: string) {
    await setReason(tx, reason);
    return tx.execute(sql`
      update ip_addresses a set status = 'QUARANTINED',
        quarantine_until = now() + make_interval(hours => p.quarantine_hours),
        reservation_token = null, reserved_until = null
      from ip_pools p
      where p.id = a.pool_id and a.service_id = ${serviceId} and a.status = 'ALLOCATED'
      returning a.address`);
  }

  async history(tenantId: string, address: string) {
    return this.db.execute(sql`
      select e.* from ip_allocation_events e join ip_addresses a on a.id = e.ip_address_id
       where a.tenant_id = ${tenantId} and a.address = ${normalizeIp(address)} order by e.created_at desc limit 100`);
  }
}
