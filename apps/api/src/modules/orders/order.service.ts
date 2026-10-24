import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../../db/client';
import { customers, invoices, orderEvents, orders, osTemplates, products, resellers, services } from '../../db/schema';
import { canonicalJson, encryptSecret, sha256Hex } from '../../common/crypto';
import { Conflict, DomainError, Invalid, NotFound, isUniqueViolation } from '../../common/errors';
import { audit, type AuditActor } from '../../common/audit';
import type { CatalogService } from '../catalog/catalog.service';
import type { IpamService } from '../ipam/ipam.service';
import type { LedgerService } from '../ledger/ledger.service';
import type { JobQueue } from '../jobs/queue';
import type { WebhookService } from '../webhooks/webhook.service';

type OrderStatus = (typeof orders.$inferSelect)['status'];
type Cycle = (typeof orders.$inferSelect)['cycle'];

/**
 * Allowed order state transitions. Anything else is a bug and is rejected.
 * PENDING_PAYMENT → PAID_OR_AUTHORIZED → QUEUED → PROVISIONING → CONFIGURING_NETWORK → VERIFYING → ACTIVE
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID_OR_AUTHORIZED', 'CANCELLED'],
  PAID_OR_AUTHORIZED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PROVISIONING', 'FAILED', 'CANCELLED'],
  PROVISIONING: ['CONFIGURING_NETWORK', 'PROVISIONING', 'FAILED', 'NEEDS_ATTENTION', 'QUEUED'],
  CONFIGURING_NETWORK: ['VERIFYING', 'CONFIGURING_NETWORK', 'PROVISIONING', 'FAILED', 'NEEDS_ATTENTION', 'QUEUED'],
  VERIFYING: ['ACTIVE', 'VERIFYING', 'PROVISIONING', 'FAILED', 'NEEDS_ATTENTION', 'QUEUED'],
  NEEDS_ATTENTION: ['QUEUED', 'FAILED', 'CANCELLED'],
  ACTIVE: [],
  FAILED: [],
  CANCELLED: [],
};

export async function transitionOrder(tx: Tx, orderId: string, to: OrderStatus, message: string, patch: Partial<typeof orders.$inferInsert> = {}) {
  const [cur] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).for('update');
  if (!cur) throw NotFound('Order');
  if (!ORDER_TRANSITIONS[cur.status].includes(to)) {
    throw Conflict('invalid_order_transition', `Order cannot move from ${cur.status} to ${to}`);
  }
  await tx.update(orders).set({ ...patch, status: to, updatedAt: new Date() }).where(eq(orders.id, orderId));
  await tx.insert(orderEvents).values({ orderId, status: to, message });
}

export interface CreateOrderInput {
  tenantId: string;
  resellerId: string;
  actor: AuditActor;
  source: 'API' | 'WHMCS' | 'PORTAL';
  /** Caller-chosen idempotency key, e.g. "whmcs:<site>:service:<id>". */
  idempotencyKey: string;
  productSku: string;
  locationCode: string;
  templateId: string;
  cycle: Cycle;
  hostname: string;
  ipv4Address?: string;
  ipReservationToken?: string;
  customer?: { externalRef: string; name: string; email?: string };
  retail?: { amountMinor: bigint; currency: string };
  password?: string;
  sshKeys?: string[];
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function addCycle(from: Date, cycle: Cycle): Date | null {
  const months = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, ONE_TIME: 0 }[cycle];
  if (!months) return null;
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); // Jan 31 + 1 month → Feb 28/29
  return d;
}

export interface CreateCustomerOrderInput {
  tenantId: string;
  customerId: string;
  actor: AuditActor;
  idempotencyKey: string;
  productSku: string;
  locationCode: string;
  templateId: string;
  cycle: Cycle;
  hostname: string;
  ipv4Address?: string;
  ipReservationToken?: string;
  password?: string;
  sshKeys?: string[];
}

/** Minimal surface of BillingService needed here (set after construction to avoid a cycle). */
export interface OrderInvoicing {
  createInvoice(tx: Tx, p: {
    tenantId: string; customerId: string; kind: 'NEW_ORDER'; orderId: string; dueDate: Date;
    lines: Array<{ description: string; unitMinor: bigint; hsnSac?: string | null; taxRateBp: number; productId?: string | null }>;
  }): Promise<{ id: string; number: string | null; totalMinor: bigint; status: string }>;
}

export class OrderService {
  private invoicing?: OrderInvoicing;
  private paymentWindowHours = 48;
  setInvoicing(i: OrderInvoicing, paymentWindowHours = 48) {
    this.invoicing = i;
    this.paymentWindowHours = paymentWindowHours;
  }

  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly ipam: IpamService,
    private readonly catalog: CatalogService,
    private readonly webhooks: WebhookService,
    private readonly queue: JobQueue,
    private readonly cfg: { encryptionKey: string; ipReservationMinutes: number },
  ) {}

  /**
   * Validates, prices, reserves funds and IPs, and queues provisioning — all in one
   * DB transaction. Safe to call repeatedly with the same idempotency key: replays
   * return the original order; a key reused with a different payload is rejected.
   */
  async createResellerOrder(input: CreateOrderInput): Promise<{ order: typeof orders.$inferSelect; replayed: boolean }> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw Invalid('idempotencyKey is required (max 200 chars)');
    if (!HOSTNAME_RE.test(input.hostname)) throw Invalid('hostname is not a valid DNS name');
    if (input.password !== undefined && (input.password.length < 12 || input.password.length > 128)) {
      throw Invalid('password must be 12–128 characters');
    }
    const requestHash = sha256Hex(
      canonicalJson({
        productSku: input.productSku,
        locationCode: input.locationCode,
        templateId: input.templateId,
        cycle: input.cycle,
        hostname: input.hostname,
        ipv4Address: input.ipv4Address,
        ipReservationToken: input.ipReservationToken,
        customer: input.customer?.externalRef,
      }),
    );

    const replay = await this.findByKey(input.tenantId, input.resellerId, input.idempotencyKey);
    if (replay) return this.checkReplay(replay, requestHash);

    let created: typeof orders.$inferSelect;
    let deliveryIds: string[] = [];
    try {
      ({ created, deliveryIds } = await this.db.transaction(async (tx) => this.createInTx(tx, input, requestHash)));
    } catch (err) {
      // A concurrent duplicate won the race on the unique (tenant, reseller, key) index.
      if (isUniqueViolation(err)) {
        const winner = await this.findByKey(input.tenantId, input.resellerId, input.idempotencyKey);
        if (winner) return this.checkReplay(winner, requestHash);
      }
      throw err;
    }
    if (created.status === 'QUEUED') await this.queue.enqueueProvision(created.id);
    for (const id of deliveryIds) await this.queue.enqueueWebhookDelivery(id);
    return { order: created, replayed: false };
  }

  private checkReplay(existing: typeof orders.$inferSelect, requestHash: string) {
    if (existing.requestHash !== requestHash) {
      throw Conflict('idempotency_key_reused', 'This idempotency key was already used for a different order', { orderId: existing.id });
    }
    return { order: existing, replayed: true };
  }

  private async findByKey(tenantId: string, resellerId: string, key: string) {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.resellerId, resellerId), eq(orders.idempotencyKey, key)));
    return row ?? null;
  }

  private async createInTx(tx: Tx, input: CreateOrderInput, requestHash: string) {
    const [reseller] = await tx
      .select()
      .from(resellers)
      .where(and(eq(resellers.id, input.resellerId), eq(resellers.tenantId, input.tenantId)));
    if (!reseller) throw NotFound('Reseller');
    if (reseller.status !== 'ACTIVE') throw new DomainError('reseller_inactive', `Reseller account is ${reseller.status}`, 403);
    if (reseller.model === 'COMMISSION') {
      throw new DomainError('model_not_supported', 'Commission resellers cannot place wholesale orders', 403);
    }

    const product = await this.catalog.getProductBySku(input.tenantId, input.productSku);
    const loc = await tx.execute(sql`select id from locations where tenant_id = ${input.tenantId} and code = ${input.locationCode}`);
    const locationId = loc.rows[0]?.id as string | undefined;
    if (!locationId) throw NotFound(`Location ${input.locationCode}`);
    const placement = await this.catalog.placementFor(tx, product.id, locationId);
    if (!placement) throw new DomainError('location_not_available', 'Product is not offered in this location', 422);
    if (!placement.templateIds.includes(input.templateId)) throw Invalid('Template is not offered for this product/location');
    const [template] = await tx.select().from(osTemplates).where(eq(osTemplates.id, input.templateId));
    if (!template?.enabled) throw Invalid('Template is disabled');

    const price = await this.catalog.resolveWholesale(tx, input.tenantId, input.resellerId, product.id, input.cycle);
    const total = price.amountMinor + price.setupFeeMinor;

    let customerId: string | null = null;
    if (input.customer) {
      const [c] = await tx
        .insert(customers)
        .values({
          tenantId: input.tenantId,
          resellerId: input.resellerId,
          externalRef: input.customer.externalRef,
          name: input.customer.name,
          email: input.customer.email,
          ownership: 'RESELLER_OWNED',
        })
        .onConflictDoUpdate({ target: [customers.resellerId, customers.externalRef], set: { name: input.customer.name, email: input.customer.email } })
        .returning();
      customerId = c.id;
    }

    const manual = product.provisioning === 'MANUAL_APPROVAL';
    const [order] = await tx
      .insert(orders)
      .values({
        tenantId: input.tenantId,
        resellerId: input.resellerId,
        customerId,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        productId: product.id,
        locationId,
        templateId: input.templateId,
        cycle: input.cycle,
        hostname: input.hostname.toLowerCase(),
        status: 'PAID_OR_AUTHORIZED',
        currency: price.currency,
        wholesaleMinor: price.amountMinor,
        setupFeeMinor: price.setupFeeMinor,
        retailMinor: input.retail?.amountMinor,
        retailCurrency: input.retail?.currency,
        encryptedSecret: input.password ? encryptSecret(input.password, this.cfg.encryptionKey) : null,
        sshKeys: input.sshKeys ?? [],
      })
      .returning();
    await tx.insert(orderEvents).values({ orderId: order.id, status: 'PAID_OR_AUTHORIZED', message: `Order received via ${input.source}` });

    // Settlement policy: hold at order time, capture on verified activation, release on failure.
    if (total > 0n) {
      await this.ledger.hold(tx, {
        tenantId: input.tenantId,
        resellerId: input.resellerId,
        orderId: order.id,
        amount: total,
        currency: price.currency,
        actor: { type: input.actor.type, id: input.actor.id },
      });
    }

    // IP reservations, bound to this order (they do not expire while the order is in flight).
    if (product.ipv4Count > 0) {
      if (!placement.ipv4PoolId) throw new DomainError('placement_misconfigured', 'No IPv4 pool configured for this location', 500);
      if (input.ipReservationToken) {
        await this.ipam.bindReservation(tx, {
          tenantId: input.tenantId,
          token: input.ipReservationToken,
          orderId: order.id,
          resellerId: input.resellerId,
          poolId: placement.ipv4PoolId,
        });
      } else {
        await this.ipam.reserve(tx, {
          tenantId: input.tenantId,
          poolId: placement.ipv4PoolId,
          address: input.ipv4Address,
          resellerId: input.resellerId,
          orderId: order.id,
          ttlMinutes: this.cfg.ipReservationMinutes,
          reason: `reserved for order ${order.number}`,
        });
      }
    }
    if (product.ipv6Count > 0) {
      if (!placement.ipv6PoolId) throw new DomainError('placement_misconfigured', 'No IPv6 pool configured for this location', 500);
      await this.ipam.reserve(tx, {
        tenantId: input.tenantId,
        poolId: placement.ipv6PoolId,
        resellerId: input.resellerId,
        orderId: order.id,
        ttlMinutes: this.cfg.ipReservationMinutes,
        reason: `reserved for order ${order.number}`,
      });
    }

    await tx.insert(services).values({
      tenantId: input.tenantId,
      resellerId: input.resellerId,
      customerId,
      orderId: order.id,
      productId: product.id,
      providerId: placement.providerId,
      node: placement.node,
      status: 'PENDING',
      hostname: order.hostname,
      vmName: `cp-${order.number}`,
      cpuCores: product.cpuCores ?? 1,
      memoryMb: product.memoryMb ?? 1024,
      diskGb: product.diskGb ?? 10,
      cycle: input.cycle,
      renewalMinor: price.amountMinor,
      currency: price.currency,
    });

    if (!manual) await transitionOrder(tx, order.id, 'QUEUED', 'Funds and IP reserved; queued for provisioning');
    else await tx.insert(orderEvents).values({ orderId: order.id, status: 'PAID_OR_AUTHORIZED', message: 'Awaiting manual approval' });

    const { deliveryIds } = await this.webhooks.emit(tx, {
      tenantId: input.tenantId,
      resellerId: input.resellerId,
      type: 'order.created',
      data: { orderId: order.id, number: order.number, externalKey: input.idempotencyKey, status: manual ? 'PAID_OR_AUTHORIZED' : 'QUEUED' },
    });
    await audit(tx, {
      tenantId: input.tenantId,
      actor: input.actor,
      resellerId: input.resellerId,
      action: 'order.create',
      targetType: 'order',
      targetId: order.id,
      metadata: { sku: input.productSku, cycle: input.cycle, wholesaleMinor: total.toString() },
    });
    const [final] = await tx.select().from(orders).where(eq(orders.id, order.id));
    return { created: final, deliveryIds };
  }

  /**
   * Store checkout for a direct customer: order PENDING_PAYMENT + IP held for the order +
   * NEW_ORDER invoice, in one transaction. Provisioning starts when the invoice is paid
   * (BillingService.onPaid). Unpaid orders expire and release the IP (billing automation).
   */
  async createCustomerOrder(input: CreateCustomerOrderInput) {
    if (!this.invoicing) throw new Error('Invoicing not configured');
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw Invalid('idempotencyKey is required');
    if (!HOSTNAME_RE.test(input.hostname)) throw Invalid('Hostname must be a valid name like server1.example.com');
    if (!input.password || input.password.length < 12 || input.password.length > 128) throw Invalid('Choose a root password of 12–128 characters');
    const key = `customer:${input.customerId}:${input.idempotencyKey}`;
    const requestHash = sha256Hex(canonicalJson({ ...input, password: undefined, actor: undefined, idempotencyKey: undefined }));
    const [prior] = await this.db.select().from(orders).where(and(eq(orders.tenantId, input.tenantId), isNull(orders.resellerId), eq(orders.idempotencyKey, key)));
    if (prior) {
      if (prior.requestHash !== requestHash) throw Conflict('idempotency_key_reused', 'This checkout was already submitted with different details');
      const [inv] = await this.db.select().from(invoices).where(eq(invoices.orderId, prior.id));
      return { order: prior, invoiceId: inv?.id ?? null, replayed: true };
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [cust] = await tx.select().from(customers).where(and(eq(customers.id, input.customerId), eq(customers.tenantId, input.tenantId)));
        if (!cust) throw NotFound('Customer');
        const { product, locationId, placement } = await this.resolvePlacement(tx, input.tenantId, input.productSku, input.locationCode, input.templateId);
        const cur = (await tx.execute(sql`select coalesce(settings->'billing'->>'currency', 'INR') as c from tenants where id = ${input.tenantId}`)).rows[0].c as string;
        const price = await this.catalog.resolveRetail(tx, input.tenantId, product.id, input.cycle, cur);
        const [order] = await tx
          .insert(orders)
          .values({
            tenantId: input.tenantId,
            resellerId: null,
            customerId: cust.id,
            source: 'PORTAL',
            idempotencyKey: key,
            requestHash,
            productId: product.id,
            locationId,
            templateId: input.templateId,
            cycle: input.cycle,
            hostname: input.hostname.toLowerCase(),
            status: 'PENDING_PAYMENT',
            currency: price.currency,
            wholesaleMinor: price.amountMinor,
            setupFeeMinor: price.setupFeeMinor,
            encryptedSecret: encryptSecret(input.password!, this.cfg.encryptionKey),
            sshKeys: input.sshKeys ?? [],
          })
          .returning();
        await tx.insert(orderEvents).values({ orderId: order.id, status: 'PENDING_PAYMENT', message: 'Order placed in the store; waiting for payment' });
        await this.reserveIps(tx, { tenantId: input.tenantId, orderId: order.id, orderNumber: order.number, product, placement, resellerId: null, ipv4Address: input.ipv4Address, token: input.ipReservationToken });
        await tx.insert(services).values({
          tenantId: input.tenantId,
          customerId: cust.id,
          orderId: order.id,
          productId: product.id,
          providerId: placement.providerId,
          node: placement.node,
          status: 'PENDING',
          hostname: order.hostname,
          vmName: `cp-${order.number}`,
          cpuCores: product.cpuCores ?? 1,
          memoryMb: product.memoryMb ?? 1024,
          diskGb: product.diskGb ?? 10,
          cycle: input.cycle,
          renewalMinor: price.amountMinor,
          currency: price.currency,
        });
        const lines = [
          { description: `${product.name} — ${order.hostname} (${input.cycle.toLowerCase().replace('_', '-')})`, unitMinor: price.amountMinor, hsnSac: product.hsnSac, taxRateBp: product.gstRateBp, productId: product.id },
        ];
        if (price.setupFeeMinor > 0n) lines.push({ description: `Setup fee — ${product.name}`, unitMinor: price.setupFeeMinor, hsnSac: product.hsnSac, taxRateBp: product.gstRateBp, productId: product.id });
        const invoice = await this.invoicing!.createInvoice(tx, {
          tenantId: input.tenantId,
          customerId: cust.id,
          kind: 'NEW_ORDER',
          orderId: order.id,
          dueDate: new Date(Date.now() + this.paymentWindowHours * 3_600_000),
          lines,
        });
        await audit(tx, { tenantId: input.tenantId, actor: input.actor, action: 'order.create', targetType: 'order', targetId: order.id, metadata: { sku: input.productSku, invoice: invoice.number } });
        const [final] = await tx.select().from(orders).where(eq(orders.id, order.id));
        return { order: final, invoiceId: invoice.id, replayed: false };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const [winner] = await this.db.select().from(orders).where(and(eq(orders.tenantId, input.tenantId), isNull(orders.resellerId), eq(orders.idempotencyKey, key)));
        if (winner) {
          const [inv] = await this.db.select().from(invoices).where(eq(invoices.orderId, winner.id));
          return { order: winner, invoiceId: inv?.id ?? null, replayed: true };
        }
      }
      throw err;
    }
  }

  private async resolvePlacement(tx: Tx, tenantId: string, sku: string, locationCode: string, templateId: string) {
    const product = await this.catalog.getProductBySku(tenantId, sku);
    const loc = await tx.execute(sql`select id from locations where tenant_id = ${tenantId} and code = ${locationCode}`);
    const locationId = loc.rows[0]?.id as string | undefined;
    if (!locationId) throw NotFound(`Location ${locationCode}`);
    const placement = await this.catalog.placementFor(tx, product.id, locationId);
    if (!placement) throw new DomainError('location_not_available', 'Product is not offered in this location', 422);
    if (!placement.templateIds.includes(templateId)) throw Invalid('Template is not offered for this product/location');
    const [template] = await tx.select().from(osTemplates).where(eq(osTemplates.id, templateId));
    if (!template?.enabled) throw Invalid('Template is disabled');
    return { product, locationId, placement, template };
  }

  private async reserveIps(
    tx: Tx,
    p: {
      tenantId: string; orderId: string; orderNumber: number; resellerId: string | null; ipv4Address?: string; token?: string;
      product: { ipv4Count: number; ipv6Count: number };
      placement: { ipv4PoolId: string | null; ipv6PoolId: string | null };
    },
  ) {
    if (p.product.ipv4Count > 0) {
      if (!p.placement.ipv4PoolId) throw new DomainError('placement_misconfigured', 'No IPv4 pool configured for this location', 500);
      if (p.token) {
        await this.ipam.bindReservation(tx, { tenantId: p.tenantId, token: p.token, orderId: p.orderId, resellerId: p.resellerId, poolId: p.placement.ipv4PoolId });
      } else {
        await this.ipam.reserve(tx, { tenantId: p.tenantId, poolId: p.placement.ipv4PoolId, address: p.ipv4Address, resellerId: p.resellerId, orderId: p.orderId, ttlMinutes: this.cfg.ipReservationMinutes, reason: `reserved for order ${p.orderNumber}` });
      }
    }
    if (p.product.ipv6Count > 0) {
      if (!p.placement.ipv6PoolId) throw new DomainError('placement_misconfigured', 'No IPv6 pool configured for this location', 500);
      await this.ipam.reserve(tx, { tenantId: p.tenantId, poolId: p.placement.ipv6PoolId, resellerId: p.resellerId, orderId: p.orderId, ttlMinutes: this.cfg.ipReservationMinutes, reason: `reserved for order ${p.orderNumber}` });
    }
  }

  /** Admin approval for MANUAL_APPROVAL products. */
  async approve(tenantId: string, orderId: string, actor: AuditActor) {
    await this.db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
      if (!o) throw NotFound('Order');
      await transitionOrder(tx, orderId, 'QUEUED', 'Approved by administrator');
      await audit(tx, { tenantId, actor, action: 'order.approve', targetType: 'order', targetId: orderId, resellerId: o.resellerId });
    });
    await this.queue.enqueueProvision(orderId);
  }

  /** Re-queues an order parked in NEEDS_ATTENTION after an operator fixed the cause. */
  async retry(tenantId: string, orderId: string, actor: AuditActor) {
    await this.db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
      if (!o) throw NotFound('Order');
      await transitionOrder(tx, orderId, 'QUEUED', 'Retry requested by administrator', { attempts: 0 });
      await audit(tx, { tenantId, actor, action: 'order.retry', targetType: 'order', targetId: orderId, resellerId: o.resellerId });
    });
    await this.queue.enqueueProvision(orderId);
  }

  async get(tenantId: string, orderId: string, resellerId?: string) {
    const where = [eq(orders.id, orderId), eq(orders.tenantId, tenantId)];
    if (resellerId) where.push(eq(orders.resellerId, resellerId));
    const row = await this.db.query.orders.findFirst({
      where: and(...where),
      with: { events: { orderBy: (e, { asc }) => [asc(e.createdAt)] }, service: true, product: true },
    });
    if (!row) throw NotFound('Order');
    const { encryptedSecret: _s, requestHash: _h, ...pub } = row;
    const ips = await this.ipam.addressesForOrder(this.db, orderId);
    return { ...pub, ips: ips.map((i) => ({ address: i.address, status: i.status, version: i.pool.version })) };
  }

  async getByKey(tenantId: string, resellerId: string, key: string) {
    const o = await this.findByKey(tenantId, resellerId, key);
    if (!o) throw NotFound('Order');
    return this.get(tenantId, o.id, resellerId);
  }

  async list(tenantId: string, opts: { resellerId?: string; customerId?: string; status?: string[]; limit?: number } = {}) {
    const where = [eq(orders.tenantId, tenantId)];
    if (opts.resellerId) where.push(eq(orders.resellerId, opts.resellerId));
    if (opts.customerId) where.push(eq(orders.customerId, opts.customerId));
    if (opts.status?.length) where.push(inArray(orders.status, opts.status as OrderStatus[]));
    return this.db
      .select({
        id: orders.id,
        number: orders.number,
        status: orders.status,
        source: orders.source,
        hostname: orders.hostname,
        cycle: orders.cycle,
        currency: orders.currency,
        wholesaleMinor: orders.wholesaleMinor,
        setupFeeMinor: orders.setupFeeMinor,
        retailMinor: orders.retailMinor,
        retailCurrency: orders.retailCurrency,
        failureReason: orders.failureReason,
        resellerId: orders.resellerId,
        productName: products.name,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(products, eq(products.id, orders.productId))
      .where(and(...where))
      .orderBy(desc(orders.createdAt))
      .limit(Math.min(opts.limit ?? 100, 500));
  }
}
