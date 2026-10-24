import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { deposits, paymentEvents, resellers } from '../../db/schema';
import { Conflict, DomainError, Invalid, NotFound, isUniqueViolation } from '../../common/errors';
import { audit, type AuditActor } from '../../common/audit';
import type { LedgerService } from '../ledger/ledger.service';
import type { WebhookService } from '../webhooks/webhook.service';
import type { PaymentGateway } from './gateways';

const MIN_DEPOSIT_MINOR = 100n; // 1.00 in major units
const MAX_DEPOSIT_MINOR = 10_000_000_00n; // 1 crore

/**
 * Wallet funding. Money is credited ONLY by:
 *   - a gateway webhook whose signature verifies (and, for Razorpay, a server-side payment lookup), or
 *   - an administrator approving a bank-transfer deposit after checking the bank statement.
 * Reseller-submitted references or screenshots never credit funds by themselves.
 */
export class DepositService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhookService,
    private readonly gateways: Map<string, PaymentGateway>,
    private readonly afterCommit: (deliveryIds: string[]) => Promise<void>,
  ) {}

  availableGateways() {
    return [...this.gateways.keys()];
  }

  private async activeReseller(tenantId: string, resellerId: string) {
    const [r] = await this.db.select().from(resellers).where(and(eq(resellers.id, resellerId), eq(resellers.tenantId, tenantId)));
    if (!r) throw NotFound('Reseller');
    if (r.status === 'SUSPENDED') throw new DomainError('reseller_inactive', 'Reseller is suspended', 403);
    return r;
  }

  private validateAmount(amount: bigint) {
    if (amount < MIN_DEPOSIT_MINOR || amount > MAX_DEPOSIT_MINOR) throw Invalid('Deposit amount is out of the allowed range');
  }

  async createGatewayTopup(p: {
    tenantId: string;
    resellerId: string;
    gateway: string;
    amountMinor: bigint;
    source: 'PORTAL' | 'API' | 'WHMCS';
    externalRef?: string;
    actor: AuditActor;
  }) {
    const gw = this.gateways.get(p.gateway);
    if (!gw) throw Invalid(`Payment gateway "${p.gateway}" is not configured`);
    const reseller = await this.activeReseller(p.tenantId, p.resellerId);
    this.validateAmount(p.amountMinor);
    if (p.externalRef) {
      const [existing] = await this.db.select().from(deposits).where(and(eq(deposits.resellerId, p.resellerId), eq(deposits.externalRef, p.externalRef)));
      if (existing) {
        if (existing.amountMinor !== p.amountMinor) throw Conflict('idempotency_key_reused', 'externalRef already used with a different amount');
        return { deposit: existing, replayed: true };
      }
    }
    const [deposit] = await this.db
      .insert(deposits)
      .values({
        tenantId: p.tenantId,
        resellerId: p.resellerId,
        method: 'GATEWAY',
        gateway: gw.name,
        amountMinor: p.amountMinor,
        currency: reseller.currency,
        status: 'AWAITING_PAYMENT',
        source: p.source,
        externalRef: p.externalRef,
      })
      .returning();
    const checkout = await gw.createCheckout({
      depositId: deposit.id,
      amountMinor: p.amountMinor,
      currency: reseller.currency,
      description: `Wallet top-up for ${reseller.name}`,
    });
    const [updated] = await this.db.update(deposits).set({ gatewayOrderId: checkout.gatewayOrderId }).where(eq(deposits.id, deposit.id)).returning();
    await audit(this.db, { tenantId: p.tenantId, actor: p.actor, resellerId: p.resellerId, action: 'deposit.create', targetType: 'deposit', targetId: deposit.id });
    return { deposit: updated, checkout, replayed: false };
  }

  async submitBankTransfer(p: {
    tenantId: string;
    resellerId: string;
    amountMinor: bigint;
    bankReference: string;
    note?: string;
    source: 'PORTAL' | 'API' | 'WHMCS';
    externalRef?: string;
    actor: AuditActor;
  }) {
    const reseller = await this.activeReseller(p.tenantId, p.resellerId);
    this.validateAmount(p.amountMinor);
    const ref = p.bankReference.trim().toUpperCase();
    if (!/^[A-Z0-9\-/]{6,40}$/.test(ref)) throw Invalid('Bank reference (UTR/transaction id) must be 6–40 alphanumeric characters');
    try {
      const [row] = await this.db
        .insert(deposits)
        .values({
          tenantId: p.tenantId,
          resellerId: p.resellerId,
          method: 'BANK_TRANSFER',
          amountMinor: p.amountMinor,
          currency: reseller.currency,
          status: 'UNDER_REVIEW',
          bankReference: ref,
          proofNote: p.note?.slice(0, 1000),
          source: p.source,
          externalRef: p.externalRef,
        })
        .returning();
      await audit(this.db, { tenantId: p.tenantId, actor: p.actor, resellerId: p.resellerId, action: 'deposit.bank_transfer.submit', targetType: 'deposit', targetId: row.id });
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw Conflict('duplicate_reference', 'This bank reference has already been submitted');
      throw err;
    }
  }

  /** Administrator confirms the transfer arrived; credits exactly once. */
  async approve(p: { tenantId: string; depositId: string; receivedAmountMinor?: bigint; actor: AuditActor }) {
    const ids = await this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(deposits).where(and(eq(deposits.id, p.depositId), eq(deposits.tenantId, p.tenantId))).for('update');
      if (!d) throw NotFound('Deposit');
      if (d.status === 'CREDITED') return [];
      if (d.method !== 'BANK_TRANSFER' || d.status !== 'UNDER_REVIEW') throw Conflict('deposit_not_reviewable', `Deposit is ${d.method}/${d.status}`);
      const amount = p.receivedAmountMinor ?? d.amountMinor;
      if (amount <= 0n) throw Invalid('Received amount must be positive');
      const { transaction } = await this.ledger.creditDeposit(tx, {
        tenantId: d.tenantId,
        resellerId: d.resellerId,
        depositId: d.id,
        amount,
        currency: d.currency,
        method: 'BANK_TRANSFER',
        actor: { type: p.actor.type, id: p.actor.id },
      });
      await tx
        .update(deposits)
        .set({ status: 'CREDITED', amountMinor: amount, reviewedById: p.actor.type === 'user' ? (p.actor.id ?? null) : null, reviewedAt: new Date(), ledgerTransactionId: transaction.id })
        .where(eq(deposits.id, d.id));
      await audit(tx, {
        tenantId: d.tenantId,
        actor: p.actor,
        resellerId: d.resellerId,
        action: 'deposit.approve',
        targetType: 'deposit',
        targetId: d.id,
        metadata: { claimedMinor: d.amountMinor.toString(), creditedMinor: amount.toString() },
      });
      return (await this.webhooks.emit(tx, {
        tenantId: d.tenantId,
        resellerId: d.resellerId,
        type: 'deposit.credited',
        data: { depositId: d.id, amountMinor: amount.toString(), currency: d.currency, externalRef: d.externalRef },
      })).deliveryIds;
    });
    await this.afterCommit(ids);
  }

  async reject(p: { tenantId: string; depositId: string; reason: string; actor: AuditActor }) {
    if (!p.reason.trim()) throw Invalid('A rejection reason is required');
    const ids = await this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(deposits).where(and(eq(deposits.id, p.depositId), eq(deposits.tenantId, p.tenantId))).for('update');
      if (!d) throw NotFound('Deposit');
      if (d.status !== 'UNDER_REVIEW' && d.status !== 'AWAITING_PAYMENT') throw Conflict('deposit_not_reviewable', `Deposit is ${d.status}`);
      await tx
        .update(deposits)
        .set({ status: 'REJECTED', rejectReason: p.reason, reviewedById: p.actor.type === 'user' ? (p.actor.id ?? null) : null, reviewedAt: new Date() })
        .where(eq(deposits.id, d.id));
      await audit(tx, { tenantId: d.tenantId, actor: p.actor, resellerId: d.resellerId, action: 'deposit.reject', targetType: 'deposit', targetId: d.id, metadata: { reason: p.reason } });
      return (await this.webhooks.emit(tx, {
        tenantId: d.tenantId,
        resellerId: d.resellerId,
        type: 'deposit.rejected',
        data: { depositId: d.id, reason: p.reason, externalRef: d.externalRef },
      })).deliveryIds;
    });
    await this.afterCommit(ids);
  }

  /**
   * Gateway webhook entry point. Signature first; then dedupe by gateway event id;
   * then credit under a row lock with amount/currency matching. Safe against
   * duplicate, replayed, reordered and concurrent deliveries.
   */
  async handleGatewayWebhook(gatewayName: string, rawBody: string, headers: Record<string, string | undefined>) {
    const gw = this.gateways.get(gatewayName);
    if (!gw) throw NotFound('Gateway');
    const ev = await gw.verifyWebhook(rawBody, headers);
    if (!ev) throw new DomainError('invalid_signature', 'Webhook signature verification failed', 400);

    try {
      await this.db.insert(paymentEvents).values({ gateway: gw.name, eventId: ev.eventId, signatureValid: true, payload: JSON.parse(rawBody) });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const [prev] = await this.db.select().from(paymentEvents).where(and(eq(paymentEvents.gateway, gw.name), eq(paymentEvents.eventId, ev.eventId)));
        if (prev?.processedAt) return { status: 'duplicate' as const };
        // Seen but not processed (earlier crash) — fall through and process idempotently.
      } else throw err;
    }

    const outcome = await this.db.transaction(async (tx) => {
      const [d] = await tx
        .select()
        .from(deposits)
        .where(and(eq(deposits.gateway, gw.name), eq(deposits.gatewayOrderId, ev.gatewayOrderId)))
        .for('update');
      let result: string;
      let deliveryIds: string[] = [];
      if (!d) result = 'unknown_order';
      else if (ev.outcome === 'ignored') result = 'ignored';
      else if (d.status === 'CREDITED') result = 'already_credited';
      else if (ev.outcome === 'failed') {
        if (d.status === 'AWAITING_PAYMENT') await tx.update(deposits).set({ status: 'FAILED', gatewayPaymentId: ev.gatewayPaymentId }).where(eq(deposits.id, d.id));
        result = 'marked_failed';
      } else if (ev.amountMinor !== d.amountMinor || ev.currency !== d.currency) {
        result = `amount_mismatch (expected ${d.amountMinor} ${d.currency}, got ${ev.amountMinor} ${ev.currency})`;
        await audit(tx, { tenantId: d.tenantId, actor: { type: 'system', id: gw.name }, resellerId: d.resellerId, action: 'deposit.amount_mismatch', targetType: 'deposit', targetId: d.id, metadata: { eventId: ev.eventId } });
      } else {
        const { transaction } = await this.ledger.creditDeposit(tx, {
          tenantId: d.tenantId,
          resellerId: d.resellerId,
          depositId: d.id,
          amount: d.amountMinor,
          currency: d.currency,
          method: 'GATEWAY',
          actor: { type: 'system', id: gw.name },
        });
        await tx
          .update(deposits)
          .set({ status: 'CREDITED', gatewayPaymentId: ev.gatewayPaymentId, ledgerTransactionId: transaction.id })
          .where(eq(deposits.id, d.id));
        deliveryIds = (await this.webhooks.emit(tx, {
          tenantId: d.tenantId,
          resellerId: d.resellerId,
          type: 'deposit.credited',
          data: { depositId: d.id, amountMinor: d.amountMinor.toString(), currency: d.currency, externalRef: d.externalRef },
        })).deliveryIds;
        result = 'credited';
      }
      await tx
        .update(paymentEvents)
        .set({ processedAt: new Date(), result })
        .where(and(eq(paymentEvents.gateway, gw.name), eq(paymentEvents.eventId, ev.eventId)));
      return { result, deliveryIds };
    });
    await this.afterCommit(outcome.deliveryIds);
    return { status: outcome.result };
  }

  async list(tenantId: string, opts: { resellerId?: string; status?: string } = {}) {
    const where = [eq(deposits.tenantId, tenantId)];
    if (opts.resellerId) where.push(eq(deposits.resellerId, opts.resellerId));
    if (opts.status) where.push(eq(deposits.status, opts.status as (typeof deposits.$inferSelect)['status']));
    return this.db
      .select({ deposit: deposits, resellerName: resellers.name })
      .from(deposits)
      .innerJoin(resellers, eq(resellers.id, deposits.resellerId))
      .where(and(...where))
      .orderBy(desc(deposits.createdAt))
      .limit(200);
  }

  async getForReseller(tenantId: string, resellerId: string, depositId: string) {
    const [d] = await this.db
      .select()
      .from(deposits)
      .where(and(eq(deposits.id, depositId), eq(deposits.tenantId, tenantId), eq(deposits.resellerId, resellerId)));
    if (!d) throw NotFound('Deposit');
    return d;
  }

  async findByGatewayOrder(gateway: string, gatewayOrderId: string) {
    const [d] = await this.db.select().from(deposits).where(and(eq(deposits.gateway, gateway), eq(deposits.gatewayOrderId, gatewayOrderId)));
    return d ?? null;
  }
}
