import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx, Database, Tx } from '../../db/client';
import { ledgerAccounts, ledgerEntries, ledgerTransactions, resellers, walletHolds } from '../../db/schema';
import { Conflict, DomainError, NotFound } from '../../common/errors';

/**
 * Double-entry wallet ledger.
 *
 * Sign convention: every entry is signed and the entries of one transaction sum
 * to zero (enforced by a deferred DB constraint trigger). For reseller-owned
 * accounts a positive balance is money we owe the reseller. System accounts
 * (clearing, revenue, adjustments) carry the opposite side.
 *
 * Reseller accounts (per currency):
 *   RESELLER_AVAILABLE  spendable cash              min 0
 *   RESELLER_RESERVED   funds held for open orders  min 0
 *   RESELLER_CREDIT     drawn credit (≤ 0)          min −creditLimit
 *   RESELLER_PROMO      promotional credit          min 0  (not spendable on orders yet)
 *
 * Balances are never written directly: a DB trigger applies each inserted entry
 * to its account under a row lock, and the CHECK constraint rejects overspend.
 * All public methods must run inside a caller-supplied transaction.
 */

export type Actor = { type: 'user' | 'api_key' | 'system'; id?: string | null };

type ResellerAccountKind = 'RESELLER_AVAILABLE' | 'RESELLER_RESERVED' | 'RESELLER_CREDIT' | 'RESELLER_PROMO';
type SystemAccountKind =
  | 'SYSTEM_GATEWAY_CLEARING'
  | 'SYSTEM_BANK_CLEARING'
  | 'SYSTEM_REVENUE'
  | 'SYSTEM_ADJUSTMENTS'
  | 'SYSTEM_PROMO_EXPENSE';

export interface ResellerAccounts {
  available: typeof ledgerAccounts.$inferSelect;
  reserved: typeof ledgerAccounts.$inferSelect;
  credit: typeof ledgerAccounts.$inferSelect;
  promo: typeof ledgerAccounts.$inferSelect;
}

export interface PostInput {
  tenantId: string;
  resellerId: string | null;
  type: (typeof ledgerTransactions.$inferInsert)['type'];
  currency: string;
  idempotencyKey: string;
  sourceType: string;
  sourceId: string;
  actor: Actor;
  memo?: string;
  reversalOfId?: string;
  legs: Array<{ accountId: string; amount: bigint }>;
}

export class InsufficientFundsError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('insufficient_funds', 'Insufficient wallet balance or credit for this operation', 402, details);
  }
}

const RESELLER_KINDS: ResellerAccountKind[] = ['RESELLER_AVAILABLE', 'RESELLER_RESERVED', 'RESELLER_CREDIT', 'RESELLER_PROMO'];

export class LedgerService {
  constructor(private readonly db: Database) {}

  // ───────────────────────────────────────── accounts

  async systemAccount(tx: DbOrTx, tenantId: string, kind: SystemAccountKind, currency: string) {
    const code = `system:${kind}`;
    await tx
      .insert(ledgerAccounts)
      .values({ tenantId, code, kind, currency, resellerId: null, minBalanceMinor: null })
      .onConflictDoNothing();
    const [acct] = await tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.code, code), eq(ledgerAccounts.currency, currency)));
    return acct;
  }

  /** Opens (if needed) and returns the reseller's accounts. With `lock`, rows are locked FOR UPDATE in id order. */
  async resellerAccounts(tx: DbOrTx, tenantId: string, resellerId: string, currency: string, lock = false): Promise<ResellerAccounts> {
    const [reseller] = await tx.select().from(resellers).where(and(eq(resellers.id, resellerId), eq(resellers.tenantId, tenantId)));
    if (!reseller) throw NotFound('Reseller');
    const creditMin = reseller.model === 'CREDIT' ? -reseller.creditLimitMinor : 0n;
    await tx
      .insert(ledgerAccounts)
      .values(
        RESELLER_KINDS.map((kind) => ({
          tenantId,
          resellerId,
          currency,
          kind,
          code: `reseller:${resellerId}:${kind}`,
          minBalanceMinor: kind === 'RESELLER_CREDIT' ? creditMin : 0n,
        })),
      )
      .onConflictDoNothing();

    const q = tx
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, tenantId),
          eq(ledgerAccounts.resellerId, resellerId),
          eq(ledgerAccounts.currency, currency),
          inArray(ledgerAccounts.kind, RESELLER_KINDS),
        ),
      )
      .orderBy(asc(ledgerAccounts.id));
    const rows = lock ? await q.for('update') : await q;
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    return {
      available: by.RESELLER_AVAILABLE,
      reserved: by.RESELLER_RESERVED,
      credit: by.RESELLER_CREDIT,
      promo: by.RESELLER_PROMO,
    };
  }

  /** Applies a reseller's credit limit to its credit account. Fails if current drawn credit exceeds the new limit. */
  async syncCreditLimit(tx: Tx, tenantId: string, resellerId: string, currency: string) {
    const [reseller] = await tx.select().from(resellers).where(eq(resellers.id, resellerId));
    const accts = await this.resellerAccounts(tx, tenantId, resellerId, currency, true);
    const min = reseller.model === 'CREDIT' ? -reseller.creditLimitMinor : 0n;
    if (accts.credit.balanceMinor < min) {
      throw Conflict('credit_limit_below_usage', 'New credit limit is below the credit already drawn', {
        drawn: (-accts.credit.balanceMinor).toString(),
      });
    }
    await tx.update(ledgerAccounts).set({ minBalanceMinor: min }).where(eq(ledgerAccounts.id, accts.credit.id));
  }

  // ───────────────────────────────────────── posting

  /**
   * Posts a balanced transaction exactly once per idempotency key.
   * Returns `created: false` (and the original transaction) on a replay with identical
   * type/amount; a key reused for a different posting is a hard conflict.
   */
  async post(tx: Tx, input: PostInput) {
    const legs = input.legs.filter((l) => l.amount !== 0n);
    const sum = legs.reduce((a, l) => a + l.amount, 0n);
    if (legs.length < 2 || sum !== 0n) throw new Error(`Unbalanced ledger posting (${legs.length} legs, sum ${sum})`);
    const amount = legs.reduce((a, l) => a + (l.amount > 0n ? l.amount : 0n), 0n);

    const [inserted] = await tx
      .insert(ledgerTransactions)
      .values({
        tenantId: input.tenantId,
        resellerId: input.resellerId,
        type: input.type,
        currency: input.currency,
        amountMinor: amount,
        idempotencyKey: input.idempotencyKey,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
        memo: input.memo ?? '',
        reversalOfId: input.reversalOfId,
      })
      .onConflictDoNothing({ target: [ledgerTransactions.tenantId, ledgerTransactions.idempotencyKey] })
      .returning();

    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(ledgerTransactions)
        .where(and(eq(ledgerTransactions.tenantId, input.tenantId), eq(ledgerTransactions.idempotencyKey, input.idempotencyKey)));
      if (existing.type !== input.type || existing.amountMinor !== amount || existing.currency !== input.currency) {
        throw Conflict('idempotency_key_reused', `Idempotency key ${input.idempotencyKey} was already used for a different posting`);
      }
      return { transaction: existing, created: false };
    }

    // Insert in account-id order to keep row-lock acquisition order deterministic (deadlock avoidance).
    const ordered = [...legs].sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
    for (const leg of ordered) {
      await tx.insert(ledgerEntries).values({
        transactionId: inserted.id,
        accountId: leg.accountId,
        amountMinor: leg.amount,
        balanceAfterMinor: 0n, // overwritten by trigger
      });
    }
    return { transaction: inserted, created: true };
  }

  // ───────────────────────────────────────── wallet operations

  /** Credits a verified deposit. Outstanding drawn credit is repaid first. */
  async creditDeposit(
    tx: Tx,
    p: { tenantId: string; resellerId: string; depositId: string; amount: bigint; currency: string; method: 'GATEWAY' | 'BANK_TRANSFER' | 'MANUAL_ADJUSTMENT'; actor: Actor },
  ) {
    const clearingKind: SystemAccountKind =
      p.method === 'GATEWAY' ? 'SYSTEM_GATEWAY_CLEARING' : p.method === 'BANK_TRANSFER' ? 'SYSTEM_BANK_CLEARING' : 'SYSTEM_ADJUSTMENTS';
    const clearing = await this.systemAccount(tx, p.tenantId, clearingKind, p.currency);
    const accts = await this.resellerAccounts(tx, p.tenantId, p.resellerId, p.currency, true);
    const drawn = accts.credit.balanceMinor < 0n ? -accts.credit.balanceMinor : 0n;
    const repay = drawn < p.amount ? drawn : p.amount;
    return this.post(tx, {
      tenantId: p.tenantId,
      resellerId: p.resellerId,
      type: 'DEPOSIT',
      currency: p.currency,
      idempotencyKey: `deposit:${p.depositId}`,
      sourceType: 'deposit',
      sourceId: p.depositId,
      actor: p.actor,
      memo: repay > 0n ? `Deposit (repaid ${repay} of drawn credit)` : 'Deposit',
      legs: [
        { accountId: clearing.id, amount: -p.amount },
        { accountId: accts.credit.id, amount: repay },
        { accountId: accts.available.id, amount: p.amount - repay },
      ],
    });
  }

  /** Splits a spend between cash and (for CREDIT resellers) the credit line, or throws InsufficientFunds. */
  private async splitSpend(tx: Tx, tenantId: string, resellerId: string, currency: string, amount: bigint) {
    const accts = await this.resellerAccounts(tx, tenantId, resellerId, currency, true);
    const cashAvail = accts.available.balanceMinor > 0n ? accts.available.balanceMinor : 0n;
    const cash = cashAvail < amount ? cashAvail : amount;
    const credit = amount - cash;
    const creditHeadroom = accts.credit.balanceMinor - (accts.credit.minBalanceMinor ?? 0n);
    if (credit > creditHeadroom) {
      throw new InsufficientFundsError({
        required: amount.toString(),
        available: cashAvail.toString(),
        creditHeadroom: creditHeadroom.toString(),
        currency,
      });
    }
    return { accts, cash, credit };
  }

  /** Reserves funds for an order. Exactly one hold per order (unique order_id). */
  async hold(tx: Tx, p: { tenantId: string; resellerId: string; orderId: string; amount: bigint; currency: string; actor: Actor }) {
    const [existing] = await tx.select().from(walletHolds).where(eq(walletHolds.orderId, p.orderId));
    if (existing) return existing;
    if (p.amount <= 0n) throw new Error('Hold amount must be positive');
    const { accts, cash, credit } = await this.splitSpend(tx, p.tenantId, p.resellerId, p.currency, p.amount);
    const { transaction } = await this.post(tx, {
      tenantId: p.tenantId,
      resellerId: p.resellerId,
      type: 'HOLD',
      currency: p.currency,
      idempotencyKey: `hold:${p.orderId}`,
      sourceType: 'order',
      sourceId: p.orderId,
      actor: p.actor,
      memo: 'Funds reserved for order',
      legs: [
        { accountId: accts.available.id, amount: -cash },
        { accountId: accts.credit.id, amount: -credit },
        { accountId: accts.reserved.id, amount: p.amount },
      ],
    });
    const [hold] = await tx
      .insert(walletHolds)
      .values({
        tenantId: p.tenantId,
        resellerId: p.resellerId,
        orderId: p.orderId,
        currency: p.currency,
        amountMinor: p.amount,
        cashMinor: cash,
        creditMinor: credit,
      })
      .returning();
    void transaction;
    return hold;
  }

  private async lockHold(tx: Tx, orderId: string) {
    const [hold] = await tx.select().from(walletHolds).where(eq(walletHolds.orderId, orderId)).for('update');
    if (!hold) throw NotFound('Wallet hold');
    return hold;
  }

  /** Converts a hold into revenue once the service is verified ACTIVE. Idempotent. */
  async capture(tx: Tx, orderId: string, actor: Actor) {
    const hold = await this.lockHold(tx, orderId);
    if (hold.status === 'CAPTURED') return hold;
    if (hold.status !== 'HELD') throw Conflict('hold_not_capturable', `Hold is ${hold.status}`);
    const accts = await this.resellerAccounts(tx, hold.tenantId, hold.resellerId, hold.currency, true);
    const revenue = await this.systemAccount(tx, hold.tenantId, 'SYSTEM_REVENUE', hold.currency);
    await this.post(tx, {
      tenantId: hold.tenantId,
      resellerId: hold.resellerId,
      type: 'CAPTURE',
      currency: hold.currency,
      idempotencyKey: `capture:${orderId}`,
      sourceType: 'order',
      sourceId: orderId,
      actor,
      memo: 'Order activated — charge captured',
      legs: [
        { accountId: accts.reserved.id, amount: -hold.amountMinor },
        { accountId: revenue.id, amount: hold.amountMinor },
      ],
    });
    const [updated] = await tx
      .update(walletHolds)
      .set({ status: 'CAPTURED', settledAt: new Date() })
      .where(eq(walletHolds.id, hold.id))
      .returning();
    return updated;
  }

  /** Returns held funds to their original sources (cash and/or credit). Idempotent. */
  async release(tx: Tx, orderId: string, actor: Actor, memo = 'Order failed or cancelled — funds released') {
    const hold = await this.lockHold(tx, orderId);
    if (hold.status === 'RELEASED') return hold;
    if (hold.status !== 'HELD') throw Conflict('hold_not_releasable', `Hold is ${hold.status}; issue a refund instead`);
    const accts = await this.resellerAccounts(tx, hold.tenantId, hold.resellerId, hold.currency, true);
    await this.post(tx, {
      tenantId: hold.tenantId,
      resellerId: hold.resellerId,
      type: 'RELEASE',
      currency: hold.currency,
      idempotencyKey: `release:${orderId}`,
      sourceType: 'order',
      sourceId: orderId,
      actor,
      memo,
      legs: [
        { accountId: accts.reserved.id, amount: -hold.amountMinor },
        { accountId: accts.available.id, amount: hold.cashMinor },
        { accountId: accts.credit.id, amount: hold.creditMinor },
      ],
    });
    const [updated] = await tx
      .update(walletHolds)
      .set({ status: 'RELEASED', settledAt: new Date() })
      .where(eq(walletHolds.id, hold.id))
      .returning();
    return updated;
  }

  /** Immediate charge (renewals, add-ons). */
  async charge(
    tx: Tx,
    p: { tenantId: string; resellerId: string; amount: bigint; currency: string; idempotencyKey: string; sourceType: string; sourceId: string; actor: Actor; memo: string },
  ) {
    const { accts, cash, credit } = await this.splitSpend(tx, p.tenantId, p.resellerId, p.currency, p.amount);
    const revenue = await this.systemAccount(tx, p.tenantId, 'SYSTEM_REVENUE', p.currency);
    return this.post(tx, {
      tenantId: p.tenantId,
      resellerId: p.resellerId,
      type: 'CHARGE',
      currency: p.currency,
      idempotencyKey: p.idempotencyKey,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
      actor: p.actor,
      memo: p.memo,
      legs: [
        { accountId: accts.available.id, amount: -cash },
        { accountId: accts.credit.id, amount: -credit },
        { accountId: revenue.id, amount: p.amount },
      ],
    });
  }

  /** Administrator adjustment (positive credits, negative debits the available balance). Requires a memo. */
  async adjust(
    tx: Tx,
    p: { tenantId: string; resellerId: string; amount: bigint; currency: string; idempotencyKey: string; actor: Actor; memo: string },
  ) {
    if (!p.memo.trim()) throw new DomainError('memo_required', 'Adjustments require a reason');
    const accts = await this.resellerAccounts(tx, p.tenantId, p.resellerId, p.currency, true);
    const adj = await this.systemAccount(tx, p.tenantId, 'SYSTEM_ADJUSTMENTS', p.currency);
    try {
      return await this.post(tx, {
        tenantId: p.tenantId,
        resellerId: p.resellerId,
        type: 'ADJUSTMENT',
        currency: p.currency,
        idempotencyKey: p.idempotencyKey,
        sourceType: 'adjustment',
        sourceId: p.idempotencyKey,
        actor: p.actor,
        memo: p.memo,
        legs: [
          { accountId: accts.available.id, amount: p.amount },
          { accountId: adj.id, amount: -p.amount },
        ],
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23514') throw new InsufficientFundsError({ required: (-p.amount).toString() });
      throw err;
    }
  }

  // ───────────────────────────────────────── reads

  async balances(tx: DbOrTx, tenantId: string, resellerId: string, currency: string) {
    const a = await this.resellerAccounts(tx, tenantId, resellerId, currency);
    const creditLimit = a.credit.minBalanceMinor !== null ? -a.credit.minBalanceMinor : 0n;
    return {
      currency,
      availableMinor: a.available.balanceMinor,
      reservedMinor: a.reserved.balanceMinor,
      promoMinor: a.promo.balanceMinor,
      creditLimitMinor: creditLimit,
      creditUsedMinor: -a.credit.balanceMinor,
      spendableMinor: a.available.balanceMinor + creditLimit + a.credit.balanceMinor,
    };
  }

  /**
   * Reconciliation report: account balances vs. entry sums, unbalanced transactions,
   * and open holds vs. reserved balances. An empty `problems` array means the books balance.
   */
  async reconcile(tenantId: string) {
    const problems: string[] = [];
    const drift = await this.db.execute(sql`
      select a.id, a.code, a.balance_minor, coalesce(sum(e.amount_minor), 0) as entry_sum
        from ledger_accounts a left join ledger_entries e on e.account_id = a.id
       where a.tenant_id = ${tenantId}
       group by a.id having a.balance_minor <> coalesce(sum(e.amount_minor), 0)`);
    for (const r of drift.rows) problems.push(`account ${r.code} balance ${r.balance_minor} != entries ${r.entry_sum}`);

    const unbalanced = await this.db.execute(sql`
      select t.id, sum(e.amount_minor) as s from ledger_transactions t join ledger_entries e on e.transaction_id = t.id
       where t.tenant_id = ${tenantId} group by t.id having sum(e.amount_minor) <> 0`);
    for (const r of unbalanced.rows) problems.push(`transaction ${r.id} sums to ${r.s}`);

    const holds = await this.db.execute(sql`
      select a.reseller_id, a.currency, a.balance_minor,
             coalesce((select sum(h.amount_minor) from wallet_holds h
                        where h.reseller_id = a.reseller_id and h.currency = a.currency and h.status = 'HELD'), 0) as held
        from ledger_accounts a
       where a.tenant_id = ${tenantId} and a.kind = 'RESELLER_RESERVED'`);
    for (const r of holds.rows) {
      if (String(r.balance_minor) !== String(r.held)) problems.push(`reseller ${r.reseller_id} reserved ${r.balance_minor} != open holds ${r.held}`);
    }
    const total = await this.db.execute(sql`
      select coalesce(sum(balance_minor),0) as s from ledger_accounts where tenant_id = ${tenantId}`);
    if (String(total.rows[0].s) !== '0') problems.push(`trial balance is ${total.rows[0].s}, expected 0`);
    return { ok: problems.length === 0, problems, checkedAt: new Date() };
  }
}
