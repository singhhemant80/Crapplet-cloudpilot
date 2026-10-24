import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { products, serviceRenewals, services } from '../../db/schema';
import { Conflict, DomainError, NotFound } from '../../common/errors';
import { audit, type AuditActor } from '../../common/audit';
import type { HypervisorService } from '../hypervisors/hypervisor.service';
import type { IpamService } from '../ipam/ipam.service';
import type { LedgerService } from '../ledger/ledger.service';
import type { ServiceOperation } from '../jobs/queue';
import type { WebhookService } from '../webhooks/webhook.service';
import { addCycle } from '../orders/order.service';

type ServiceRow = typeof services.$inferSelect;

/**
 * Lifecycle operations on provisioned services. Infrastructure calls run in the
 * worker (see JobQueue.runServiceOperation); this class holds the logic both
 * for the worker and for synchronous reads/renewals in the API.
 */
export class ServiceOpsService {
  constructor(
    private readonly db: Database,
    private readonly hypervisors: HypervisorService,
    private readonly ipam: IpamService,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhookService,
    private readonly afterCommit: (deliveryIds: string[]) => Promise<void>,
  ) {}

  async get(tenantId: string, serviceId: string, scope: { resellerId?: string; customerId?: string } = {}) {
    const where = [eq(services.id, serviceId), eq(services.tenantId, tenantId)];
    if (scope.resellerId) where.push(eq(services.resellerId, scope.resellerId));
    if (scope.customerId) where.push(eq(services.customerId, scope.customerId));
    const [row] = await this.db.select().from(services).where(and(...where));
    if (!row) throw NotFound('Service');
    return row;
  }

  async details(tenantId: string, serviceId: string, scope: { resellerId?: string; customerId?: string } = {}) {
    const svc = await this.get(tenantId, serviceId, scope);
    const ips = await this.ipam.addressesForService(this.db, svc.id);
    const [product] = await this.db.select({ name: products.name, sku: products.sku }).from(products).where(eq(products.id, svc.productId));
    return { ...svc, product, ips };
  }

  async list(tenantId: string, scope: { resellerId?: string; customerId?: string; status?: string[] } = {}) {
    const where = [eq(services.tenantId, tenantId)];
    if (scope.resellerId) where.push(eq(services.resellerId, scope.resellerId));
    if (scope.customerId) where.push(eq(services.customerId, scope.customerId));
    if (scope.status?.length) where.push(inArray(services.status, scope.status as ServiceRow['status'][]));
    return this.db
      .select({
        id: services.id,
        orderId: services.orderId,
        status: services.status,
        hostname: services.hostname,
        cycle: services.cycle,
        nextDueDate: services.nextDueDate,
        renewalMinor: services.renewalMinor,
        currency: services.currency,
        cpuCores: services.cpuCores,
        memoryMb: services.memoryMb,
        diskGb: services.diskGb,
        resellerId: services.resellerId,
        productName: products.name,
        createdAt: services.createdAt,
      })
      .from(services)
      .innerJoin(products, eq(products.id, services.productId))
      .where(and(...where))
      .orderBy(desc(services.createdAt))
      .limit(500);
  }

  private adapterRef(svc: ServiceRow) {
    if (!svc.providerId || !svc.externalVmId || !svc.node) throw new DomainError('service_not_provisioned', 'Service has no VM yet', 409);
    return this.hypervisors.getById(svc.providerId).then((p) => ({
      adapter: this.hypervisors.adapterFor(p),
      ref: { node: svc.node!, id: svc.externalVmId! },
    }));
  }

  /** Executed by the worker. Every branch is idempotent so a retried job converges. */
  async execute(op: ServiceOperation) {
    const [svc] = await this.db.select().from(services).where(eq(services.id, op.serviceId));
    if (!svc) throw NotFound('Service');
    const actor: AuditActor = { type: op.actor.type, id: op.actor.id };

    switch (op.action) {
      case 'start':
      case 'stop':
      case 'shutdown':
      case 'reboot': {
        if (svc.status !== 'ACTIVE') throw Conflict('service_not_active', `Service is ${svc.status}`);
        const { adapter, ref } = await this.adapterRef(svc);
        await adapter[op.action](ref);
        await audit(this.db, { tenantId: svc.tenantId, actor, resellerId: svc.resellerId, action: `service.${op.action}`, targetType: 'service', targetId: svc.id });
        return { status: svc.status, power: (await adapter.getInstanceStatus(ref)).power };
      }
      case 'suspend': {
        if (svc.status === 'SUSPENDED') return { status: 'SUSPENDED' };
        if (svc.status !== 'ACTIVE') throw Conflict('service_not_active', `Service is ${svc.status}`);
        const { adapter, ref } = await this.adapterRef(svc);
        const st = await adapter.getInstanceStatus(ref);
        if (st.power === 'running') await adapter.stop(ref);
        return this.commitStatus(svc, 'SUSPENDED', 'service.suspended', actor, { suspendedReason: op.reason ?? 'suspended' });
      }
      case 'unsuspend': {
        if (svc.status === 'ACTIVE') return { status: 'ACTIVE' };
        if (svc.status !== 'SUSPENDED') throw Conflict('service_not_suspended', `Service is ${svc.status}`);
        const { adapter, ref } = await this.adapterRef(svc);
        const st = await adapter.getInstanceStatus(ref);
        if (st.power !== 'running') await adapter.start(ref);
        return this.commitStatus(svc, 'ACTIVE', 'service.unsuspended', actor, { suspendedReason: null });
      }
      case 'terminate': {
        if (svc.status === 'TERMINATED') return { status: 'TERMINATED' };
        if (!['ACTIVE', 'SUSPENDED'].includes(svc.status)) throw Conflict('service_not_terminable', `Service is ${svc.status}`);
        const { adapter, ref } = await this.adapterRef(svc);
        await adapter.deleteInstance(ref);
        if (await adapter.findInstanceByName(svc.vmName)) {
          throw new DomainError('termination_unconfirmed', 'Provider still reports the VM after deletion', 502);
        }
        return this.db.transaction(async (tx) => {
          await this.ipam.quarantineForService(tx, svc.id, 'service terminated');
          await tx
            .update(services)
            .set({ status: 'TERMINATED', terminatedAt: new Date(), updatedAt: new Date() })
            .where(eq(services.id, svc.id));
          const ev = await this.webhooks.emit(tx, {
            tenantId: svc.tenantId,
            resellerId: svc.resellerId,
            type: 'service.terminated',
            data: { serviceId: svc.id, orderId: svc.orderId },
          });
          await audit(tx, { tenantId: svc.tenantId, actor, resellerId: svc.resellerId, action: 'service.terminate', targetType: 'service', targetId: svc.id, metadata: { reason: op.reason } });
          return ev.deliveryIds;
        }).then(async (ids) => {
          await this.afterCommit(ids);
          return { status: 'TERMINATED' };
        });
      }
    }
  }

  private async commitStatus(
    svc: ServiceRow,
    status: ServiceRow['status'],
    event: 'service.suspended' | 'service.unsuspended',
    actor: AuditActor,
    patch: Partial<typeof services.$inferInsert>,
  ) {
    const ids = await this.db.transaction(async (tx) => {
      await tx.update(services).set({ ...patch, status, updatedAt: new Date() }).where(eq(services.id, svc.id));
      await audit(tx, { tenantId: svc.tenantId, actor, resellerId: svc.resellerId, action: event, targetType: 'service', targetId: svc.id });
      return (await this.webhooks.emit(tx, { tenantId: svc.tenantId, resellerId: svc.resellerId, type: event, data: { serviceId: svc.id } }))
        .deliveryIds;
    });
    await this.afterCommit(ids);
    return { status };
  }

  /**
   * Renews one billing period by charging the reseller wallet. The idempotency key
   * (e.g. the WHMCS invoice id) guarantees one charge per renewal even if the
   * caller retries or WHMCS fires its hook twice.
   */
  async renew(tenantId: string, serviceId: string, resellerId: string, idempotencyKey: string, actor: AuditActor) {
    if (!idempotencyKey) throw new DomainError('invalid_request', 'idempotencyKey is required', 422);
    const res = await this.db.transaction(async (tx) => {
      const [svc] = await tx
        .select()
        .from(services)
        .where(and(eq(services.id, serviceId), eq(services.tenantId, tenantId), eq(services.resellerId, resellerId)))
        .for('update');
      if (!svc) throw NotFound('Service');
      const [prior] = await tx
        .select()
        .from(serviceRenewals)
        .where(and(eq(serviceRenewals.serviceId, svc.id), eq(serviceRenewals.idempotencyKey, idempotencyKey)));
      if (prior) return { renewal: prior, replayed: true, deliveryIds: [] as string[] };
      if (!['ACTIVE', 'SUSPENDED'].includes(svc.status)) throw Conflict('service_not_renewable', `Service is ${svc.status}`);
      if (svc.cycle === 'ONE_TIME') throw Conflict('service_not_renewable', 'One-time services do not renew');

      const periodStart = svc.nextDueDate ?? new Date();
      const periodEnd = addCycle(periodStart, svc.cycle)!;
      const { transaction } = await this.ledger.charge(tx, {
        tenantId,
        resellerId,
        amount: svc.renewalMinor,
        currency: svc.currency,
        idempotencyKey: `renewal:${svc.id}:${idempotencyKey}`,
        sourceType: 'service_renewal',
        sourceId: svc.id,
        actor,
        memo: `Renewal ${periodStart.toISOString().slice(0, 10)} → ${periodEnd.toISOString().slice(0, 10)}`,
      });
      const [renewal] = await tx
        .insert(serviceRenewals)
        .values({ serviceId: svc.id, idempotencyKey, periodStart, periodEnd, amountMinor: svc.renewalMinor, ledgerTransactionId: transaction.id })
        .returning();
      await tx.update(services).set({ nextDueDate: periodEnd, updatedAt: new Date() }).where(eq(services.id, svc.id));
      await audit(tx, { tenantId, actor, resellerId, action: 'service.renew', targetType: 'service', targetId: svc.id, metadata: { idempotencyKey } });
      const ev = await this.webhooks.emit(tx, {
        tenantId,
        resellerId,
        type: 'service.renewed',
        data: { serviceId: svc.id, periodEnd: periodEnd.toISOString(), amountMinor: svc.renewalMinor.toString() },
      });
      return { renewal, replayed: false, deliveryIds: ev.deliveryIds };
    });
    await this.afterCommit(res.deliveryIds);
    return { renewal: res.renewal, replayed: res.replayed };
  }

  async metrics(tenantId: string, serviceId: string, scope: { resellerId?: string; customerId?: string }, timeframe: 'hour' | 'day' | 'week') {
    const svc = await this.get(tenantId, serviceId, scope);
    const { adapter, ref } = await this.adapterRef(svc);
    return adapter.getMetrics(ref, timeframe);
  }

  async liveStatus(tenantId: string, serviceId: string, scope: { resellerId?: string; customerId?: string }) {
    const svc = await this.get(tenantId, serviceId, scope);
    const { adapter, ref } = await this.adapterRef(svc);
    const st = await adapter.getInstanceStatus(ref);
    return { power: st.power, uptimeSeconds: st.uptimeSeconds, providerType: adapter.providerType };
  }
}
