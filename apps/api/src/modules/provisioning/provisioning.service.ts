import { ProviderError, type HypervisorAdapter, type InstanceRef, type IpAssignment } from '@cloudpilot/hypervisor-sdk';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { orderEvents, orders, osTemplates, productPlacements, services } from '../../db/schema';
import { decryptSecret } from '../../common/crypto';
import { audit } from '../../common/audit';
import type { HypervisorService } from '../hypervisors/hypervisor.service';
import type { IpamService } from '../ipam/ipam.service';
import type { LedgerService } from '../ledger/ledger.service';
import type { WebhookService } from '../webhooks/webhook.service';
import { addCycle, transitionOrder } from '../orders/order.service';

const SYSTEM = { type: 'system' as const, id: 'provisioner' };

export interface ProvisioningConfig {
  encryptionKey: string;
  maxAttempts: number;
  verifyAttempts: number;
  verifyIntervalMs: number;
}

export type ProvisionOutcome =
  | { result: 'active' }
  | { result: 'skipped'; reason: string }
  | { result: 'failed'; reason: string }
  | { result: 'needs_attention'; reason: string };

/** Thrown to ask the queue to retry the job later with backoff. */
export class RetryLaterError extends Error {}

/**
 * VPS provisioning state machine, run by the worker:
 *
 *   QUEUED → PROVISIONING → CONFIGURING_NETWORK → VERIFYING → ACTIVE
 *
 * Idempotency: the VM's provider-side name (services.vm_name) is deterministic.
 * Every (re)run first looks the name up on the hypervisor, so a crash after
 * "create" but before we recorded the VM id can never produce a second VM.
 *
 * Money and IPs: funds stay HELD and IPs RESERVED until verification passes;
 * then capture + allocation happen in one DB transaction. On a permanent failure
 * the partially built VM is deleted and funds/IPs are released — or, if cleanup
 * cannot be confirmed, the order is parked in NEEDS_ATTENTION with everything still held.
 */
export class ProvisioningService {
  constructor(
    private readonly db: Database,
    private readonly hypervisors: HypervisorService,
    private readonly ipam: IpamService,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhookService,
    private readonly cfg: ProvisioningConfig,
    private readonly afterCommit: (deliveryIds: string[]) => Promise<void>,
  ) {}

  private async event(orderId: string, status: (typeof orders.$inferSelect)['status'], message: string) {
    await this.db.insert(orderEvents).values({ orderId, status, message });
  }

  async run(orderId: string): Promise<ProvisionOutcome> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return { result: 'skipped', reason: 'order not found' };
    if (!['QUEUED', 'PROVISIONING', 'CONFIGURING_NETWORK', 'VERIFYING'].includes(order.status)) {
      return { result: 'skipped', reason: `order is ${order.status}` }; // duplicate/late job
    }
    const [service] = await this.db.select().from(services).where(eq(services.orderId, orderId));
    const [placement] = await this.db
      .select()
      .from(productPlacements)
      .where(and(eq(productPlacements.productId, order.productId), eq(productPlacements.locationId, order.locationId)));
    const [template] = await this.db.select().from(osTemplates).where(eq(osTemplates.id, order.templateId));
    const provider = await this.hypervisors.getById(service.providerId!);
    const adapter = this.hypervisors.adapterFor(provider);

    const attempt = order.attempts + 1;
    await this.db.update(orders).set({ attempts: attempt }).where(eq(orders.id, orderId));

    let ref: InstanceRef | null = service.externalVmId ? { node: service.node!, id: service.externalVmId } : null;
    try {
      // ── PROVISIONING: create the VM, or adopt the one a previous attempt created.
      await this.db.transaction((tx) => transitionOrder(tx, orderId, 'PROVISIONING', `Provisioning attempt ${attempt}`));
      await this.db.update(services).set({ status: 'PROVISIONING', updatedAt: new Date() }).where(eq(services.id, service.id));

      const ips = await this.ipAssignments(orderId);
      const existing = await adapter.findInstanceByName(service.vmName);
      if (existing) {
        ref = existing;
        await this.event(orderId, 'PROVISIONING', `Adopted existing VM ${existing.id} on ${existing.node} from a previous attempt`);
      } else {
        const password = order.encryptedSecret ? decryptSecret(order.encryptedSecret, this.cfg.encryptionKey) : undefined;
        ref = await adapter.createInstance({
          name: service.vmName,
          kind: 'vm',
          node: placement.node,
          templateId: template.externalId,
          cpuCores: service.cpuCores,
          memoryMb: service.memoryMb,
          diskGb: service.diskGb,
          storage: placement.storage ?? undefined,
          bridge: placement.bridge,
          vlanTag: placement.vlanTag ?? undefined,
          ips,
          nameservers: await this.nameservers(orderId),
          sshKeys: order.sshKeys,
          username: service.username,
          password,
          tags: ['cloudpilot', `order-${order.number}`],
        });
        await this.event(orderId, 'PROVISIONING', `Created VM ${ref.id} on ${ref.node}`);
      }
      await this.db.update(services).set({ externalVmId: ref.id, node: ref.node, updatedAt: new Date() }).where(eq(services.id, service.id));

      // ── CONFIGURING_NETWORK
      await this.db.transaction((tx) => transitionOrder(tx, orderId, 'CONFIGURING_NETWORK', 'Applying network configuration'));
      await adapter.configureNetwork(ref, ips, {
        bridge: placement.bridge,
        vlanTag: placement.vlanTag ?? undefined,
        nameservers: await this.nameservers(orderId),
      });
      const status = await adapter.getInstanceStatus(ref);
      if (status.power !== 'running') await adapter.start(ref);

      // ── VERIFYING
      await this.db.transaction((tx) => transitionOrder(tx, orderId, 'VERIFYING', 'Verifying power state and IP configuration'));
      const verification = await this.verify(adapter, ref, ips);

      // ── ACTIVE: capture funds, allocate IPs, activate service — atomically.
      const deliveryIds = await this.db.transaction(async (tx) => {
        await this.ipam.allocateForOrder(tx, orderId, service.id);
        if (order.wholesaleMinor + order.setupFeeMinor > 0n) await this.ledger.capture(tx, orderId, SYSTEM);
        const now = new Date();
        await tx
          .update(services)
          .set({ status: 'ACTIVE', nextDueDate: addCycle(now, order.cycle), updatedAt: now })
          .where(eq(services.id, service.id));
        await transitionOrder(tx, orderId, 'ACTIVE', `Service active (${verification})`, { encryptedSecret: null, failureReason: null });
        const ev = await this.webhooks.emit(tx, {
          tenantId: order.tenantId,
          resellerId: order.resellerId,
          type: 'service.activated',
          data: {
            orderId,
            serviceId: service.id,
            externalKey: order.idempotencyKey,
            hostname: service.hostname,
            ips: ips.map((i) => i.address),
            username: service.username,
          },
        });
        await audit(tx, { tenantId: order.tenantId, actor: SYSTEM, resellerId: order.resellerId, action: 'service.activate', targetType: 'service', targetId: service.id });
        return ev.deliveryIds;
      });
      await this.afterCommit(deliveryIds);
      return { result: 'active' };
    } catch (err) {
      return this.handleFailure(orderId, attempt, adapter, service.vmName, err);
    }
  }

  private async ipAssignments(orderId: string): Promise<IpAssignment[]> {
    const rows = await this.ipam.addressesForOrder(this.db, orderId);
    return rows.map((r) => ({
      version: r.pool.version as 4 | 6,
      address: r.address,
      prefixLength: r.pool.prefixLength,
      gateway: r.pool.gateway ?? undefined,
    }));
  }

  private async nameservers(orderId: string) {
    const rows = await this.ipam.addressesForOrder(this.db, orderId);
    return [...new Set(rows.flatMap((r) => r.pool.nameservers))];
  }

  /**
   * Verification requires the VM to be running and the provider config to carry every assigned IP.
   * When a guest agent reports addresses, the primary IPv4 must also appear inside the guest.
   */
  private async verify(adapter: HypervisorAdapter, ref: InstanceRef, ips: IpAssignment[]): Promise<string> {
    let last = 'not checked';
    for (let i = 0; i < this.cfg.verifyAttempts; i++) {
      const st = await adapter.getInstanceStatus(ref);
      const missing = ips.filter((ip) => !(st.configuredIps ?? []).includes(ip.address));
      if (st.power !== 'running') last = `power state is ${st.power}`;
      else if (missing.length) last = `provider config missing ${missing.map((m) => m.address).join(', ')}`;
      else if (st.guestIps) {
        const v4 = ips.find((ip) => ip.version === 4);
        if (!v4 || st.guestIps.includes(v4.address)) return 'verified via guest agent';
        last = `guest reports ${st.guestIps.join(', ') || 'no addresses'}, expected ${v4.address}`;
      } else return 'verified via provider config; guest agent not available';
      await new Promise((r) => setTimeout(r, this.cfg.verifyIntervalMs));
    }
    throw new ProviderError(`Verification failed: ${last}`, false);
  }

  private async handleFailure(orderId: string, attempt: number, adapter: HypervisorAdapter, vmName: string, err: unknown): Promise<ProvisionOutcome> {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof ProviderError ? err.retryable : false;
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId));

    if (retryable && attempt < this.cfg.maxAttempts) {
      await this.event(orderId, order.status, `Attempt ${attempt} failed (will retry): ${message}`);
      throw new RetryLaterError(message);
    }

    // Permanent failure: try to remove any partially built VM before releasing money/IPs.
    let vmGone = false;
    let cleanupNote = '';
    try {
      const leftover = await adapter.findInstanceByName(vmName);
      if (leftover) {
        await adapter.deleteInstance(leftover);
        vmGone = (await adapter.findInstanceByName(vmName)) === null;
        cleanupNote = vmGone ? `; removed partial VM ${leftover.id}` : '; partial VM still present';
      } else vmGone = true;
    } catch (cleanupErr) {
      cleanupNote = `; cleanup failed: ${(cleanupErr as Error).message}`;
    }

    if (!vmGone) {
      await this.db.transaction(async (tx) => {
        await transitionOrder(tx, orderId, 'NEEDS_ATTENTION', `Provisioning failed${cleanupNote}. Funds and IPs remain held: ${message}`, {
          failureReason: message,
        });
        await tx.update(services).set({ status: 'NEEDS_ATTENTION', updatedAt: new Date() }).where(eq(services.orderId, orderId));
      });
      return { result: 'needs_attention', reason: message };
    }

    const deliveryIds = await this.db.transaction(async (tx) => {
      await this.ipam.releaseForOrder(tx, orderId, 'provisioning failed');
      if (order.wholesaleMinor + order.setupFeeMinor > 0n) await this.ledger.release(tx, orderId, SYSTEM);
      await transitionOrder(tx, orderId, 'FAILED', `Provisioning failed${cleanupNote}; funds and IPs released: ${message}`, {
        failureReason: message,
        encryptedSecret: null,
      });
      await tx.update(services).set({ status: 'FAILED', updatedAt: new Date() }).where(eq(services.orderId, orderId));
      const ev = await this.webhooks.emit(tx, {
        tenantId: order.tenantId,
        resellerId: order.resellerId,
        type: 'order.failed',
        data: { orderId, externalKey: order.idempotencyKey, reason: message },
      });
      return ev.deliveryIds;
    });
    await this.afterCommit(deliveryIds);
    return { result: 'failed', reason: message };
  }
}
