import type { InstanceRef, IpAssignment } from '@cloudpilot/hypervisor-sdk';
import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Database } from '../../db/client';
import { ipAddresses, ipPools, orders, osTemplates, productPlacements, products, services } from '../../db/schema';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../../common/crypto';
import { Conflict, DomainError, Invalid, NotFound } from '../../common/errors';
import { audit, type AuditActor } from '../../common/audit';
import type { CatalogService } from '../catalog/catalog.service';
import type { HypervisorService } from '../hypervisors/hypervisor.service';
import type { LedgerService } from '../ledger/ledger.service';
import type { JobQueue, ServiceOperation } from '../jobs/queue';

type Service = typeof services.$inferSelect;
type Scope = { resellerId?: string; customerId?: string };

const MAX_SNAPSHOTS = 3;
const SNAP_RE = /^[a-zA-Z][\w-]{1,39}$/;
const CONSOLE_TTL_S = 60;

/** Creates invoices for customer upgrades (implemented by BillingService). */
export interface UpgradeInvoicer {
  createUpgradeInvoice(p: { tenantId: string; customerId: string; serviceId: string; productId: string; description: string; unitMinor: bigint; hsnSac: string; taxRateBp: number; renewalMinor: bigint }): Promise<{ id: string; number: string | null }>;
}

/**
 * VPS self-service beyond power control:
 *  - OS reinstall (destroys the disk, keeps hostname and IPs)
 *  - Upgrades to a larger plan, prorated for the rest of the billing period
 *  - Snapshots (create / roll back / delete, capped per server)
 *  - Browser console via a single-use, 60-second token
 * Infrastructure work runs in the worker through ServiceOperation jobs.
 */
export class VpsExtrasService {
  private invoicer?: UpgradeInvoicer;
  setInvoicer(i: UpgradeInvoicer) {
    this.invoicer = i;
  }

  constructor(
    private readonly db: Database,
    private readonly hypervisors: HypervisorService,
    private readonly catalog: CatalogService,
    private readonly ledger: LedgerService,
    private readonly queue: JobQueue,
    private readonly redis: Redis,
    private readonly encryptionKey: string,
  ) {}

  private async service(tenantId: string, id: string, scope: Scope) {
    const where = [eq(services.id, id), eq(services.tenantId, tenantId)];
    if (scope.resellerId) where.push(eq(services.resellerId, scope.resellerId));
    if (scope.customerId) where.push(eq(services.customerId, scope.customerId));
    const [svc] = await this.db.select().from(services).where(and(...where));
    if (!svc) throw NotFound('Service');
    return svc;
  }

  private requireActive(svc: Service) {
    if (svc.status !== 'ACTIVE') throw Conflict('service_not_active', `Server is ${svc.status.toLowerCase()}`);
    if (!svc.providerId || !svc.externalVmId || !svc.node) throw new DomainError('service_not_provisioned', 'Server has no VM yet', 409);
  }

  private async adapter(svc: Service) {
    const provider = await this.hypervisors.getById(svc.providerId!);
    return { adapter: this.hypervisors.adapterFor(provider), ref: { node: svc.node!, id: svc.externalVmId! } as InstanceRef };
  }

  /** Placement of the service (bridge, VLAN, allowed templates) via its order's location. */
  private async placement(svc: Service) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, svc.orderId));
    const [pl] = await this.db
      .select()
      .from(productPlacements)
      .where(and(eq(productPlacements.productId, svc.productId), eq(productPlacements.locationId, o.locationId)));
    return { order: o, placement: pl };
  }

  // ───────────────────────── reinstall

  async reinstallOptions(tenantId: string, serviceId: string, scope: Scope) {
    const svc = await this.service(tenantId, serviceId, scope);
    const { placement } = await this.placement(svc);
    if (!placement) return [];
    const tpls = await this.db.select().from(osTemplates).where(eq(osTemplates.providerId, placement.providerId));
    return tpls.filter((t) => placement.templateIds.includes(t.id) && t.enabled).map((t) => ({ id: t.id, name: t.name, osFamily: t.osFamily }));
  }

  async requestReinstall(p: { tenantId: string; serviceId: string; scope: Scope; templateId: string; password: string; actor: AuditActor }) {
    const svc = await this.service(p.tenantId, p.serviceId, p.scope);
    this.requireActive(svc);
    if (p.password.length < 12 || p.password.length > 128) throw Invalid('Choose a root password of 12–128 characters');
    const allowed = await this.reinstallOptions(p.tenantId, p.serviceId, p.scope);
    if (!allowed.some((t) => t.id === p.templateId)) throw Invalid('That operating system is not available for this server');
    await audit(this.db, { tenantId: p.tenantId, actor: p.actor, resellerId: svc.resellerId, action: 'service.reinstall.request', targetType: 'service', targetId: svc.id, metadata: { templateId: p.templateId } });
    return this.queue.runServiceOperation(
      { serviceId: svc.id, action: 'reinstall', actor: p.actor, params: { templateId: p.templateId, password: encryptSecret(p.password, this.encryptionKey) } },
      `reinstall-${svc.id}-${randomToken(6)}`,
      25_000,
    );
  }

  // ───────────────────────── upgrades

  /** Price to move to a bigger plan now, for the rest of the current billing period. */
  async upgradeQuote(tenantId: string, serviceId: string, scope: Scope, sku: string) {
    const svc = await this.service(tenantId, serviceId, scope);
    this.requireActive(svc);
    const target = await this.catalog.getProductBySku(tenantId, sku);
    if (target.id === svc.productId) throw Invalid('The server is already on this plan');
    if ((target.diskGb ?? 0) < svc.diskGb || (target.memoryMb ?? 0) < svc.memoryMb || (target.cpuCores ?? 0) < svc.cpuCores) {
      throw new DomainError('downgrade_not_supported', 'Only upgrades are possible: disks cannot shrink. Order a new server to move to a smaller plan.', 422);
    }
    const { order, placement: cur } = await this.placement(svc);
    const [targetPlacement] = await this.db
      .select()
      .from(productPlacements)
      .where(and(eq(productPlacements.productId, target.id), eq(productPlacements.locationId, order.locationId), eq(productPlacements.enabled, true)));
    if (!targetPlacement || targetPlacement.providerId !== cur?.providerId) {
      throw new DomainError('upgrade_not_available', 'That plan is not available on this server’s cluster', 422);
    }
    const newPrice = svc.resellerId
      ? (await this.catalog.resolveWholesale(this.db, tenantId, svc.resellerId, target.id, svc.cycle)).amountMinor
      : (await this.catalog.resolveRetail(this.db, tenantId, target.id, svc.cycle, svc.currency)).amountMinor;
    const diff = newPrice - svc.renewalMinor;
    // Fraction of the paid period still remaining, in basis points.
    let remainingBp = 10_000n;
    if (svc.nextDueDate && svc.cycle !== 'ONE_TIME') {
      const months = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 }[svc.cycle as 'MONTHLY'];
      const start = new Date(svc.nextDueDate);
      start.setUTCMonth(start.getUTCMonth() - months);
      const total = svc.nextDueDate.getTime() - start.getTime();
      const left = Math.max(0, svc.nextDueDate.getTime() - Date.now());
      remainingBp = BigInt(Math.round((left / total) * 10_000));
    }
    const charge = diff > 0n ? (diff * remainingBp + 5_000n) / 10_000n : 0n;
    return {
      from: { productId: svc.productId, renewalMinor: svc.renewalMinor },
      to: { productId: target.id, sku: target.sku, name: target.name, cpuCores: target.cpuCores, memoryMb: target.memoryMb, diskGb: target.diskGb, renewalMinor: newPrice, hsnSac: target.hsnSac, gstRateBp: target.gstRateBp },
      chargeMinor: charge,
      currency: svc.currency,
      remainingPercent: Number(remainingBp) / 100,
      nextDueDate: svc.nextDueDate,
    };
  }

  /** Every plan this server can move to now, each with its prorated price. */
  async upgradeOptions(tenantId: string, serviceId: string, scope: Scope) {
    const svc = await this.service(tenantId, serviceId, scope);
    const all = await this.catalog.listProducts(tenantId);
    const current = all.find((p) => p.id === svc.productId);
    const out = [];
    for (const p of all) {
      if (p.status !== 'ACTIVE' || p.id === svc.productId || p.type !== current?.type) continue;
      try {
        out.push(await this.upgradeQuote(tenantId, serviceId, scope, p.sku));
      } catch {
        // not an upgrade, not priced, or not on this cluster
      }
    }
    return out.sort((a, b) => Number(a.to.renewalMinor - b.to.renewalMinor));
  }

  /**
   * Resellers pay from the wallet immediately and the resize is queued. Customers get an
   * UPGRADE invoice; paying it queues the resize (BillingService.onPaid).
   */
  async requestUpgrade(p: { tenantId: string; serviceId: string; scope: Scope; sku: string; actor: AuditActor }) {
    const q = await this.upgradeQuote(p.tenantId, p.serviceId, p.scope, p.sku);
    const svc = await this.service(p.tenantId, p.serviceId, p.scope);
    if (svc.resellerId) {
      if (q.chargeMinor > 0n) {
        await this.db.transaction((tx) =>
          this.ledger.charge(tx, {
            tenantId: p.tenantId,
            resellerId: svc.resellerId!,
            amount: q.chargeMinor,
            currency: svc.currency,
            idempotencyKey: `upgrade:${svc.id}:${q.to.productId}:${svc.nextDueDate?.toISOString() ?? ''}`,
            sourceType: 'service_upgrade',
            sourceId: svc.id,
            actor: p.actor,
            memo: `Upgrade ${svc.hostname} to ${q.to.name} (prorated ${q.remainingPercent}%)`,
          }),
        );
      }
      const op = await this.queue.runServiceOperation(
        { serviceId: svc.id, action: 'upgrade', actor: p.actor, params: { productId: q.to.productId, renewalMinor: q.to.renewalMinor.toString() } },
        `upgrade-${svc.id}-${q.to.productId}`,
        25_000,
      );
      return { charged: q.chargeMinor, operation: op };
    }
    if (!this.invoicer || !svc.customerId) throw new DomainError('upgrade_not_available', 'Upgrades are not available for this service', 422);
    const inv = await this.invoicer.createUpgradeInvoice({
      tenantId: p.tenantId,
      customerId: svc.customerId,
      serviceId: svc.id,
      productId: q.to.productId,
      description: `Upgrade ${svc.hostname} to ${q.to.name} (${q.remainingPercent}% of the period remaining)`,
      unitMinor: q.chargeMinor,
      hsnSac: q.to.hsnSac,
      taxRateBp: q.to.gstRateBp,
      renewalMinor: q.to.renewalMinor,
    });
    return { invoiceId: inv.id, invoiceNumber: inv.number };
  }

  // ───────────────────────── snapshots

  async listSnapshots(tenantId: string, serviceId: string, scope: Scope) {
    const svc = await this.service(tenantId, serviceId, scope);
    if (!svc.externalVmId) return [];
    const { adapter, ref } = await this.adapter(svc);
    if (!adapter.capabilities().has('snapshot')) return [];
    return adapter.listSnapshots(ref);
  }

  async snapshotAction(p: { tenantId: string; serviceId: string; scope: Scope; action: 'snapshot_create' | 'snapshot_rollback' | 'snapshot_delete'; name: string; actor: AuditActor }) {
    const svc = await this.service(p.tenantId, p.serviceId, p.scope);
    this.requireActive(svc);
    if (!SNAP_RE.test(p.name)) throw Invalid('Snapshot names start with a letter and use letters, digits, - or _ (2–40 characters)');
    const { adapter } = await this.adapter(svc);
    if (!adapter.capabilities().has('snapshot')) throw new DomainError('unsupported_operation', 'This server’s hypervisor does not support snapshots', 501);
    if (p.action === 'snapshot_create' && (await this.listSnapshots(p.tenantId, p.serviceId, p.scope)).length >= MAX_SNAPSHOTS) {
      throw Conflict('snapshot_limit', `Each server can keep ${MAX_SNAPSHOTS} snapshots; delete one first`);
    }
    return this.queue.runServiceOperation({ serviceId: svc.id, action: p.action, actor: p.actor, params: { name: p.name } }, `${p.action}-${svc.id}-${p.name}-${randomToken(4)}`, 25_000);
  }

  // ───────────────────────── console

  /** Opens a provider console and returns a single-use token for the websocket proxy. */
  async openConsole(tenantId: string, serviceId: string, scope: Scope, actor: AuditActor) {
    const svc = await this.service(tenantId, serviceId, scope);
    this.requireActive(svc);
    const { adapter, ref } = await this.adapter(svc);
    if (!adapter.capabilities().has('console.vnc')) {
      throw new DomainError('console_unavailable', 'The browser console is not available for this server’s hypervisor', 501);
    }
    const session = await adapter.openConsole(ref);
    const token = randomToken(32);
    await this.redis.set(
      `console:${sha256Hex(token)}`,
      JSON.stringify({ providerId: svc.providerId, ref, session: { ...session, expiresAt: session.expiresAt.toISOString() } }),
      'EX',
      CONSOLE_TTL_S,
    );
    await audit(this.db, { tenantId, actor, resellerId: svc.resellerId, action: 'service.console', targetType: 'service', targetId: svc.id });
    // The VNC password is Proxmox's per-session ticket (as in Proxmox's own console); the API token never leaves the server.
    return { token, path: `/v1/console/ws?token=${token}`, password: session.ticket, expiresInSeconds: CONSOLE_TTL_S };
  }

  /** Redeems a console token exactly once and returns the upstream websocket target. */
  async redeemConsoleToken(token: string) {
    const raw = await this.redis.getdel(`console:${sha256Hex(token)}`);
    if (!raw) return null;
    const rec = JSON.parse(raw) as { providerId: string; ref: InstanceRef; session: { protocol: 'vnc'; ticket: string; port?: number; expiresAt: string } };
    const provider = await this.hypervisors.getById(rec.providerId);
    const adapter = this.hypervisors.adapterFor(provider);
    return adapter.consoleUpstream(rec.ref, { ...rec.session, expiresAt: new Date(rec.session.expiresAt) });
  }

  // ───────────────────────── worker-side execution

  private async ipAssignments(serviceId: string): Promise<{ ips: IpAssignment[]; nameservers: string[] }> {
    const rows = await this.db
      .select({ address: ipAddresses.address, pool: ipPools })
      .from(ipAddresses)
      .innerJoin(ipPools, eq(ipPools.id, ipAddresses.poolId))
      .where(and(eq(ipAddresses.serviceId, serviceId), eq(ipAddresses.status, 'ALLOCATED')));
    return {
      ips: rows.map((r) => ({ version: r.pool.version as 4 | 6, address: r.address, prefixLength: r.pool.prefixLength, gateway: r.pool.gateway ?? undefined })),
      nameservers: [...new Set(rows.flatMap((r) => r.pool.nameservers))],
    };
  }

  /** Runs an extras operation in the worker. Each branch converges if the job is retried. */
  async execute(op: ServiceOperation) {
    const [svc] = await this.db.select().from(services).where(eq(services.id, op.serviceId));
    if (!svc) throw NotFound('Service');
    const actor: AuditActor = { type: op.actor.type, id: op.actor.id };
    const { adapter, ref } = await this.adapter(svc);
    const params = op.params ?? {};

    switch (op.action) {
      case 'snapshot_create':
        await adapter.createSnapshot(ref, String(params.name), 'Created from CloudPilot');
        break;
      case 'snapshot_rollback':
        await adapter.rollbackSnapshot(ref, String(params.name));
        break;
      case 'snapshot_delete':
        await adapter.deleteSnapshot(ref, String(params.name));
        break;

      case 'reinstall': {
        const [tpl] = await this.db.select().from(osTemplates).where(eq(osTemplates.id, String(params.templateId)));
        if (!tpl) throw NotFound('Template');
        const { placement } = await this.placement(svc);
        const { ips, nameservers } = await this.ipAssignments(svc.id);
        await this.db.update(services).set({ status: 'PROVISIONING', updatedAt: new Date() }).where(eq(services.id, svc.id));
        try {
          // Remove the old VM (if this is a retry it may already be gone), then rebuild under the same name and IPs.
          const existing = await adapter.findInstanceByName(svc.vmName);
          if (existing && existing.id === svc.externalVmId) await adapter.deleteInstance(existing);
          const again = await adapter.findInstanceByName(svc.vmName);
          const newRef =
            again ??
            (await adapter.createInstance({
              name: svc.vmName,
              kind: 'vm',
              node: placement.node,
              templateId: tpl.externalId,
              cpuCores: svc.cpuCores,
              memoryMb: svc.memoryMb,
              diskGb: svc.diskGb,
              storage: placement.storage ?? undefined,
              bridge: placement.bridge,
              vlanTag: placement.vlanTag ?? undefined,
              ips,
              nameservers,
              username: svc.username,
              password: decryptSecret(String(params.password), this.encryptionKey),
              tags: ['cloudpilot', 'reinstall'],
            }));
          await adapter.configureNetwork(newRef, ips, { bridge: placement.bridge, vlanTag: placement.vlanTag ?? undefined, nameservers });
          if ((await adapter.getInstanceStatus(newRef)).power !== 'running') await adapter.start(newRef);
          await this.db.update(services).set({ status: 'ACTIVE', externalVmId: newRef.id, node: newRef.node, updatedAt: new Date() }).where(eq(services.id, svc.id));
          await audit(this.db, { tenantId: svc.tenantId, actor, resellerId: svc.resellerId, action: 'service.reinstall', targetType: 'service', targetId: svc.id, metadata: { template: tpl.name } });
          return { status: 'ACTIVE', template: tpl.name };
        } catch (err) {
          await this.db.update(services).set({ status: 'NEEDS_ATTENTION', updatedAt: new Date() }).where(eq(services.id, svc.id));
          throw err;
        }
      }

      case 'upgrade': {
        const [target] = await this.db.select().from(products).where(eq(products.id, String(params.productId)));
        if (!target) throw NotFound('Product');
        let renewal = params.renewalMinor !== undefined ? BigInt(String(params.renewalMinor)) : undefined;
        if (renewal === undefined) {
          renewal = svc.resellerId
            ? (await this.catalog.resolveWholesale(this.db, svc.tenantId, svc.resellerId, target.id, svc.cycle)).amountMinor
            : (await this.catalog.resolveRetail(this.db, svc.tenantId, target.id, svc.cycle, svc.currency)).amountMinor;
        }
        if (svc.productId !== target.id) {
          await this.db
            .update(services)
            .set({
              productId: target.id,
              cpuCores: target.cpuCores ?? svc.cpuCores,
              memoryMb: target.memoryMb ?? svc.memoryMb,
              diskGb: target.diskGb ?? svc.diskGb,
              renewalMinor: renewal,
              updatedAt: new Date(),
            })
            .where(eq(services.id, svc.id));
        }
        // CPU/RAM changes need a restart on most hypervisors; disks only grow.
        const st = await adapter.getInstanceStatus(ref);
        if (st.power === 'running') await adapter.shutdown(ref).catch(() => adapter.stop(ref));
        await adapter.resize(ref, { cpuCores: target.cpuCores ?? undefined, memoryMb: target.memoryMb ?? undefined, diskGb: target.diskGb ?? undefined });
        await adapter.start(ref);
        await audit(this.db, { tenantId: svc.tenantId, actor, resellerId: svc.resellerId, action: 'service.upgrade', targetType: 'service', targetId: svc.id, metadata: { to: target.sku } });
        return { status: 'ACTIVE', plan: target.name };
      }
      default:
        throw Invalid(`Unknown action ${op.action}`);
    }
    await audit(this.db, { tenantId: svc.tenantId, actor, resellerId: svc.resellerId, action: `service.${op.action}`, targetType: 'service', targetId: svc.id, metadata: { name: params.name } });
    return { status: svc.status, snapshot: params.name };
  }
}

