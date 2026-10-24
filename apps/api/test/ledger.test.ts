import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerAccounts, walletHolds } from '../src/db/schema';
import { InsufficientFundsError } from '../src/modules/ledger/ledger.service';
import { ADMIN, buildWorld, fundViaBankTransfer, makeReseller, type World } from './helpers';
import { dbError } from './db-error';

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await w.c.close();
});

const randomUuid = () => crypto.randomUUID();

describe('ledger database guarantees', () => {
  it('rejects direct balance writes', async () => {
    const r = await makeReseller(w);
    const accts = await w.c.ledger.resellerAccounts(w.c.db, w.tenantId, r.id, 'INR');
    expect(await dbError(w.c.db.update(ledgerAccounts).set({ balanceMinor: 1_000_000n }).where(eq(ledgerAccounts.id, accts.available.id)))).toMatch(
      /may only change by posting/,
    );
  });

  it('rejects unbalanced transactions at commit', async () => {
    const r = await makeReseller(w);
    const accts = await w.c.ledger.resellerAccounts(w.c.db, w.tenantId, r.id, 'INR');
    expect(
      await dbError(w.c.db.transaction(async (tx) => {
        const [t] = await tx.execute(sql`insert into ledger_transactions (tenant_id, type, currency, amount_minor, idempotency_key, source_type, source_id, actor_type)
          values (${w.tenantId}, 'ADJUSTMENT', 'INR', 100, ${'bad-' + randomUuid()}, 'test', 'x', 'system') returning id`).then((r) => r.rows);
        await tx.execute(sql`insert into ledger_entries (transaction_id, account_id, amount_minor, balance_after_minor) values (${t.id}, ${accts.available.id}, 100, 0)`);
      })),
    ).toMatch(/unbalanced/);
  });

  it('makes posted entries immutable', async () => {
    const r = await makeReseller(w, { fundMinor: 1000n });
    expect(await dbError(w.c.db.execute(sql`update ledger_entries set amount_minor = 1 where account_id in (select id from ledger_accounts where reseller_id = ${r.id})`))).toMatch(/append-only/);
    expect(await dbError(w.c.db.execute(sql`delete from ledger_transactions where reseller_id = ${r.id}`))).toMatch(/append-only/);
  });
});

describe('wallet operations', () => {
  it('credits an approved bank deposit exactly once', async () => {
    const r = await makeReseller(w);
    const d = await fundViaBankTransfer(w, r.id, 250000n);
    await w.c.deposits.approve({ tenantId: w.tenantId, depositId: d.id, actor: ADMIN }); // second approval: no-op
    const b = await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR');
    expect(b.availableMinor).toBe(250000n);
  });

  it('prevents concurrent overspending (20 holds racing for funds that cover 5)', async () => {
    const r = await makeReseller(w, { fundMinor: 5000n });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        w.c.db.transaction((tx) =>
          w.c.ledger.hold(tx, { tenantId: w.tenantId, resellerId: r.id, orderId: randomUuid(), amount: 1000n, currency: 'INR', actor: ADMIN }),
        ),
      ),
    );
    const ok = results.filter((x) => x.status === 'fulfilled').length;
    const insufficient = results.filter((x) => x.status === 'rejected' && x.reason instanceof InsufficientFundsError).length;
    expect(ok).toBe(5);
    expect(insufficient).toBe(15);
    const b = await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR');
    expect(b.availableMinor).toBe(0n);
    expect(b.reservedMinor).toBe(5000n);
    expect((await w.c.ledger.reconcile(w.tenantId)).problems).toEqual([]);
  });

  it('draws credit only for CREDIT resellers, within limit, and repays credit first on deposit', async () => {
    const r = await makeReseller(w, { model: 'CREDIT', creditLimitMinor: 3000n, fundMinor: 1000n });
    const order1 = randomUuid();
    await w.c.db.transaction((tx) => w.c.ledger.hold(tx, { tenantId: w.tenantId, resellerId: r.id, orderId: order1, amount: 3500n, currency: 'INR', actor: ADMIN }));
    const [hold] = await w.c.db.select().from(walletHolds).where(eq(walletHolds.orderId, order1));
    expect(hold.cashMinor).toBe(1000n);
    expect(hold.creditMinor).toBe(2500n);
    await expect(
      w.c.db.transaction((tx) => w.c.ledger.hold(tx, { tenantId: w.tenantId, resellerId: r.id, orderId: randomUuid(), amount: 600n, currency: 'INR', actor: ADMIN })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    await w.c.db.transaction((tx) => w.c.ledger.capture(tx, order1, ADMIN));
    await fundViaBankTransfer(w, r.id, 4000n); // repays 2500 credit, 1500 to available
    const b = await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR');
    expect(b.creditUsedMinor).toBe(0n);
    expect(b.availableMinor).toBe(1500n);

    // Lowering the limit below drawn credit is refused.
    await w.c.db.transaction((tx) => w.c.ledger.hold(tx, { tenantId: w.tenantId, resellerId: r.id, orderId: randomUuid(), amount: 3500n, currency: 'INR', actor: ADMIN }));
    await expect(w.c.resellers.update(w.tenantId, r.id, { creditLimitMinor: 1000n }, ADMIN)).rejects.toThrow(/below the credit already drawn/);
  });

  it('prepaid resellers cannot go negative', async () => {
    const r = await makeReseller(w, { fundMinor: 100n });
    await expect(
      w.c.db.transaction((tx) => w.c.ledger.hold(tx, { tenantId: w.tenantId, resellerId: r.id, orderId: randomUuid(), amount: 101n, currency: 'INR', actor: ADMIN })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('release returns funds to their original sources; capture after release is refused', async () => {
    const r = await makeReseller(w, { model: 'CREDIT', creditLimitMinor: 1000n, fundMinor: 500n });
    const o = randomUuid();
    await w.c.db.transaction((tx) => w.c.ledger.hold(tx, { tenantId: w.tenantId, resellerId: r.id, orderId: o, amount: 1200n, currency: 'INR', actor: ADMIN }));
    await w.c.db.transaction((tx) => w.c.ledger.release(tx, o, ADMIN));
    await w.c.db.transaction((tx) => w.c.ledger.release(tx, o, ADMIN)); // idempotent
    const b = await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR');
    expect([b.availableMinor, b.creditUsedMinor, b.reservedMinor]).toEqual([500n, 0n, 0n]);
    await expect(w.c.db.transaction((tx) => w.c.ledger.capture(tx, o, ADMIN))).rejects.toThrow(/RELEASED/);
  });

  it('idempotency keys cannot be reused for a different posting', async () => {
    const r = await makeReseller(w, { fundMinor: 1000n });
    const key = `adj-${randomUuid()}`;
    await w.c.db.transaction((tx) => w.c.ledger.adjust(tx, { tenantId: w.tenantId, resellerId: r.id, amount: 100n, currency: 'INR', idempotencyKey: key, actor: ADMIN, memo: 'goodwill' }));
    const replay = await w.c.db.transaction((tx) => w.c.ledger.adjust(tx, { tenantId: w.tenantId, resellerId: r.id, amount: 100n, currency: 'INR', idempotencyKey: key, actor: ADMIN, memo: 'goodwill' }));
    expect(replay.created).toBe(false);
    await expect(
      w.c.db.transaction((tx) => w.c.ledger.adjust(tx, { tenantId: w.tenantId, resellerId: r.id, amount: 999n, currency: 'INR', idempotencyKey: key, actor: ADMIN, memo: 'x' })),
    ).rejects.toThrow(/already used/);
    expect((await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR')).availableMinor).toBe(1100n);
  });

  it('books stay balanced', async () => {
    const report = await w.c.ledger.reconcile(w.tenantId);
    expect(report.problems).toEqual([]);
  });
});
