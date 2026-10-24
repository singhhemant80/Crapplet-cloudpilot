import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RazorpayGateway } from '../src/modules/payments/gateways';
import { hmacSha256Hex } from '../src/common/crypto';
import { ADMIN, buildWorld, makeReseller, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await w.c.close();
});

function sandboxEvent(orderId: string, amount: bigint, opts: { id?: string; type?: string; currency?: string } = {}) {
  const body = JSON.stringify({
    id: opts.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    type: opts.type ?? 'payment.captured',
    data: { orderId, paymentId: `pay_${Math.random().toString(36).slice(2)}`, amountMinor: amount.toString(), currency: opts.currency ?? 'INR' },
  });
  return { body, headers: { 'x-sandbox-signature': w.c.sandboxGateway!.sign(body) } };
}

describe('gateway top-ups', () => {
  it('credits exactly once even when the same webhook arrives many times concurrently', async () => {
    const r = await makeReseller(w);
    const { deposit } = await w.c.deposits.createGatewayTopup({ tenantId: w.tenantId, resellerId: r.id, gateway: 'sandbox', amountMinor: 75000n, source: 'API', actor: ADMIN });
    expect(deposit.status).toBe('AWAITING_PAYMENT');
    const ev = sandboxEvent(deposit.gatewayOrderId!, 75000n, { id: 'evt_dupe_1' });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => w.c.deposits.handleGatewayWebhook('sandbox', ev.body, ev.headers)));
    expect(results.every((x) => x.status === 'fulfilled')).toBe(true);
    // A *different* event id for the same payment also must not double credit.
    const ev2 = sandboxEvent(deposit.gatewayOrderId!, 75000n, { id: 'evt_dupe_2' });
    expect(await w.c.deposits.handleGatewayWebhook('sandbox', ev2.body, ev2.headers)).toEqual({ status: 'already_credited' });
    expect((await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR')).availableMinor).toBe(75000n);
  });

  it('rejects forged signatures and does not credit mismatched amounts', async () => {
    const r = await makeReseller(w);
    const { deposit } = await w.c.deposits.createGatewayTopup({ tenantId: w.tenantId, resellerId: r.id, gateway: 'sandbox', amountMinor: 50000n, source: 'PORTAL', actor: ADMIN });
    const forged = sandboxEvent(deposit.gatewayOrderId!, 50000n);
    await expect(w.c.deposits.handleGatewayWebhook('sandbox', forged.body, { 'x-sandbox-signature': 'ab'.repeat(32) })).rejects.toMatchObject({
      code: 'invalid_signature',
    });
    const short = sandboxEvent(deposit.gatewayOrderId!, 100n);
    expect((await w.c.deposits.handleGatewayWebhook('sandbox', short.body, short.headers)).status).toMatch(/amount_mismatch/);
    const wrongCur = sandboxEvent(deposit.gatewayOrderId!, 50000n, { currency: 'USD' });
    expect((await w.c.deposits.handleGatewayWebhook('sandbox', wrongCur.body, wrongCur.headers)).status).toMatch(/amount_mismatch/);
    expect((await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR')).availableMinor).toBe(0n);
  });

  it('top-up requests are idempotent on externalRef (WHMCS invoice)', async () => {
    const r = await makeReseller(w);
    const a = await w.c.deposits.createGatewayTopup({ tenantId: w.tenantId, resellerId: r.id, gateway: 'sandbox', amountMinor: 10000n, source: 'WHMCS', externalRef: 'inv-9', actor: ADMIN });
    const b = await w.c.deposits.createGatewayTopup({ tenantId: w.tenantId, resellerId: r.id, gateway: 'sandbox', amountMinor: 10000n, source: 'WHMCS', externalRef: 'inv-9', actor: ADMIN });
    expect(b.deposit.id).toBe(a.deposit.id);
    await expect(
      w.c.deposits.createGatewayTopup({ tenantId: w.tenantId, resellerId: r.id, gateway: 'sandbox', amountMinor: 99999n, source: 'WHMCS', externalRef: 'inv-9', actor: ADMIN }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });
});

describe('bank transfers', () => {
  it('never credits on submission; one bank reference can only be claimed once', async () => {
    const r = await makeReseller(w);
    const d = await w.c.deposits.submitBankTransfer({ tenantId: w.tenantId, resellerId: r.id, amountMinor: 500000n, bankReference: 'UTR998877665544', note: 'screenshot attached', source: 'PORTAL', actor: ADMIN });
    expect(d.status).toBe('UNDER_REVIEW');
    expect((await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR')).availableMinor).toBe(0n);
    const r2 = await makeReseller(w);
    await expect(
      w.c.deposits.submitBankTransfer({ tenantId: w.tenantId, resellerId: r2.id, amountMinor: 500000n, bankReference: 'utr998877665544', source: 'PORTAL', actor: ADMIN }),
    ).rejects.toMatchObject({ code: 'duplicate_reference' });
    // Admin credits the amount actually received.
    await w.c.deposits.approve({ tenantId: w.tenantId, depositId: d.id, receivedAmountMinor: 499000n, actor: ADMIN });
    expect((await w.c.ledger.balances(w.c.db, w.tenantId, r.id, 'INR')).availableMinor).toBe(499000n);
  });

  it('rejected deposits cannot be approved afterwards', async () => {
    const r = await makeReseller(w);
    const d = await w.c.deposits.submitBankTransfer({ tenantId: w.tenantId, resellerId: r.id, amountMinor: 1000n, bankReference: 'UTR000111222', source: 'PORTAL', actor: ADMIN });
    await w.c.deposits.reject({ tenantId: w.tenantId, depositId: d.id, reason: 'not received', actor: ADMIN });
    await expect(w.c.deposits.approve({ tenantId: w.tenantId, depositId: d.id, actor: ADMIN })).rejects.toMatchObject({ code: 'deposit_not_reviewable' });
  });
});

describe('razorpay adapter', () => {
  const gw = (fetchImpl: typeof fetch) => new RazorpayGateway('rzp_test_x', 'secret', 'whsecret', fetchImpl);
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 50000, currency: 'INR', status: 'captured' } } } });

  it('verifies HMAC signature over the raw body', async () => {
    const g = gw((async () => new Response(JSON.stringify({ id: 'pay_1', order_id: 'order_1', amount: 50000, currency: 'INR', status: 'captured' }))) as typeof fetch);
    expect(await g.verifyWebhook(body, { 'x-razorpay-signature': 'deadbeef' })).toBeNull();
    const ok = await g.verifyWebhook(body, { 'x-razorpay-signature': hmacSha256Hex('whsecret', body), 'x-razorpay-event-id': 'e1' });
    expect(ok).toMatchObject({ outcome: 'captured', amountMinor: 50000n, gatewayOrderId: 'order_1' });
  });

  it('does not credit when the server-side lookup disagrees with the webhook', async () => {
    const g = gw((async () => new Response(JSON.stringify({ id: 'pay_1', order_id: 'order_1', amount: 50000, currency: 'INR', status: 'refunded' }))) as typeof fetch);
    const ev = await g.verifyWebhook(body, { 'x-razorpay-signature': hmacSha256Hex('whsecret', body) });
    expect(ev?.outcome).toBe('ignored');
  });
});
