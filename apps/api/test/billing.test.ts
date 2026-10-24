import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customers, emailMessages, invoices, ipAddresses, orders, services, tenants } from '../src/db/schema';
import { computeTax, financialYear, invoiceNumber, pct } from '../src/modules/billing/gst';
import { amountInWords } from '../src/modules/billing/invoice-pdf';
import { MemoryTransport } from '../src/modules/email/email.service';
import { ADMIN, buildWorld, type World } from './helpers';
import { dbError } from './db-error';

describe('GST rules', () => {
  const seller = { sellerGstin: '27AABCC1234D1Z5', sellerStateCode: '27' };
  it('splits CGST/SGST within the state and charges IGST across states', () => {
    const intra = computeTax({ ...seller, buyerCountry: 'IN', buyerStateCode: '27' }, [{ amountMinor: 54900n, taxRateBp: 1800 }]);
    expect(intra).toMatchObject({ taxType: 'INTRA', placeOfSupply: '27', cgstMinor: 4941n, sgstMinor: 4941n, igstMinor: 0n, totalMinor: 64782n });
    const inter = computeTax({ ...seller, buyerCountry: 'IN', buyerStateCode: '07' }, [{ amountMinor: 54900n, taxRateBp: 1800 }]);
    expect(inter).toMatchObject({ taxType: 'INTER', placeOfSupply: '07', igstMinor: 9882n, totalMinor: 64782n });
  });
  it('exports are zero-rated, unregistered sellers charge nothing, unknown buyer state = supplier state', () => {
    expect(computeTax({ ...seller, buyerCountry: 'US' }, [{ amountMinor: 1000n, taxRateBp: 1800 }])).toMatchObject({ taxType: 'EXPORT', taxMinor: 0n });
    expect(computeTax({ sellerGstin: '', sellerStateCode: '', buyerCountry: 'IN' }, [{ amountMinor: 1000n, taxRateBp: 1800 }])).toMatchObject({ taxType: 'NONE', taxMinor: 0n });
    expect(computeTax({ ...seller, buyerCountry: 'IN', buyerStateCode: null }, [{ amountMinor: 1000n, taxRateBp: 1800 }]).taxType).toBe('INTRA');
  });
  it('rounds half up in exact integer arithmetic and uses per-line rates', () => {
    expect(pct(25n, 1800, 2n)).toBe(2n); // 2.25 → 2
    expect(pct(50n, 1800, 2n)).toBe(5n); // 4.5 → 5
    const mixed = computeTax({ ...seller, buyerCountry: 'IN', buyerStateCode: '29' }, [
      { amountMinor: 10000n, taxRateBp: 1800 },
      { amountMinor: 10000n, taxRateBp: 500 },
    ]);
    expect(mixed.igstMinor).toBe(1800n + 500n);
  });
  it('numbers invoices per Indian financial year within 16 characters', () => {
    expect(financialYear(new Date('2026-03-31T10:00:00Z'))).toBe('2025-26');
    expect(financialYear(new Date('2026-04-01T10:00:00Z'))).toBe('2026-27');
    expect(invoiceNumber('CP', '2026-27', 42)).toBe('CP/2026-27/00042');
    expect(() => invoiceNumber('LONG', '2026-27', 1)).toThrow(/16 characters/);
    expect(amountInWords(11800000n, 'INR')).toBe('Rupees One Lakh Eighteen Thousand only');
    expect(amountInWords(64782n, 'INR')).toBe('Rupees Six Hundred Forty Seven and Eighty Two Paise only');
  });
});

let w: World;
let mail: MemoryTransport;
let retailListId: string;

async function makeCustomer(stateCode: string, email = `c${Math.random().toString(36).slice(2, 8)}@example.in`) {
  const slug = (await w.c.db.select().from(tenants).where(eq(tenants.id, w.tenantId)))[0].slug;
  const r = await w.c.auth.registerCustomer({ tenantSlug: slug, name: 'Asha Rao', email, password: 'customer-pass-123', country: 'IN', stateCode, companyName: 'Rao Traders' });
  if (!r.created) throw new Error('not created');
  return r.customerId;
}

function order(customerId: string, key: string, extra: Record<string, unknown> = {}) {
  return w.c.orders.createCustomerOrder({
    tenantId: w.tenantId,
    customerId,
    actor: { type: 'user', id: null },
    idempotencyKey: key,
    productSku: 'VPS-2C4G',
    locationCode: 'IN-MUM-1',
    templateId: w.templateId,
    cycle: 'MONTHLY',
    hostname: 'shop.rao.example',
    password: 'Server-Pass-2026!',
    ...extra,
  });
}

async function paySandbox(invoiceId: string, customerId: string, eventId = `evt_${Math.random()}`) {
  const { checkout } = await w.c.billing.startPayment({ tenantId: w.tenantId, invoiceId, customerId, gateway: 'sandbox' });
  const pay = await w.c.billing.findPaymentByGatewayOrder('sandbox', checkout.gatewayOrderId);
  const body = JSON.stringify({ id: eventId, type: 'payment.captured', data: { orderId: checkout.gatewayOrderId, paymentId: `pay_${eventId}`, amountMinor: pay!.amountMinor.toString(), currency: 'INR' } });
  return { body, headers: { 'x-sandbox-signature': w.c.sandboxGateway!.sign(body) } };
}

beforeAll(async () => {
  mail = new MemoryTransport();
  w = await buildWorld({ emailTransport: mail });
  await w.c.settings.update(w.tenantId, {
    company: { legalName: 'Crapplet Infotech Private Limited', gstin: '27AABCC1234D1Z5', stateCode: '27', supportEmail: 'support@crapplet.test', panelUrl: 'http://panel.test', address: 'Mumbai' },
  });
  retailListId = (await w.c.catalog.createPriceList(w.tenantId, 'Retail INR', 'INR', false, true)).id;
  await w.c.catalog.setPrice(w.tenantId, retailListId, w.productId, 'MONTHLY', 54900n, 10000n);
});
afterAll(async () => {
  await w.c.close();
});

describe('store checkout → invoice → payment → provisioning', () => {
  it('creates a pending order with a GST invoice and a held IP; payment provisions the server', async () => {
    const cust = await makeCustomer('27');
    const { order: o, invoiceId } = await order(cust, 'checkout-1');
    expect(o.status).toBe('PENDING_PAYMENT');
    const inv = await w.c.billing.get(w.tenantId, invoiceId!, cust);
    expect(inv.status).toBe('UNPAID');
    expect(inv.number).toMatch(/^CP\/\d{4}-\d{2}\/\d{5}$/);
    expect(inv.taxType).toBe('INTRA');
    expect(inv.lines).toHaveLength(2); // plan + setup fee
    expect(inv.subtotalMinor).toBe(64900n);
    expect(inv.totalMinor).toBe(64900n + 2n * 5841n); // CGST 9% + SGST 9%
    const [ip] = await w.c.db.select().from(ipAddresses).where(eq(ipAddresses.orderId, o.id));
    expect(ip.status).toBe('RESERVED');
    expect(w.q.provisionJobs).not.toContain(o.id); // nothing builds before payment

    const replay = await order(cust, 'checkout-1');
    expect(replay.order.id).toBe(o.id); // double-submitted checkout → same order

    const ev = await paySandbox(invoiceId!, cust, 'evt_store_1');
    expect((await w.c.deposits.handleGatewayWebhook('sandbox', ev.body, ev.headers)).status).toBe('invoice_paid');
    expect((await w.c.deposits.handleGatewayWebhook('sandbox', ev.body, ev.headers)).status).toBe('duplicate');
    expect((await w.c.billing.get(w.tenantId, invoiceId!)).status).toBe('PAID');
    expect(w.q.provisionJobs).toContain(o.id);
    expect(await w.q.runProvision(o.id)).toEqual({ result: 'active' });
    const [svc] = await w.c.db.select().from(services).where(eq(services.orderId, o.id));
    expect(svc.status).toBe('ACTIVE');

    const keys = (await w.c.db.select().from(emailMessages).where(eq(emailMessages.tenantId, w.tenantId))).map((m) => m.templateKey);
    expect(keys).toEqual(expect.arrayContaining(['invoice.created', 'invoice.paid', 'service.active']));
    expect((await w.c.ledger.reconcile(w.tenantId)).problems).toEqual([]);
  });

  it('charges IGST to a buyer in another state', async () => {
    const cust = await makeCustomer('07');
    const { invoiceId } = await order(cust, 'checkout-delhi');
    const inv = await w.c.billing.get(w.tenantId, invoiceId!);
    expect(inv).toMatchObject({ taxType: 'INTER', placeOfSupply: '07', cgstMinor: 0n, igstMinor: 11682n });
  });

  it('expires unpaid orders and releases the IP', async () => {
    const cust = await makeCustomer('27');
    const { order: o, invoiceId } = await order(cust, 'checkout-unpaid');
    await w.c.db.execute(sql`alter table invoices disable trigger cp_invoice_immutable`);
    await w.c.db.update(invoices).set({ issueDate: new Date(Date.now() - 49 * 3_600_000) }).where(eq(invoices.id, invoiceId!));
    await w.c.db.execute(sql`alter table invoices enable trigger cp_invoice_immutable`);
    const out = await w.c.billing.runAutomation(w.tenantId);
    expect(out.cancelledOrders).toBe(1);
    expect((await w.c.db.select().from(orders).where(eq(orders.id, o.id)))[0].status).toBe('CANCELLED');
    expect(await w.c.db.select().from(ipAddresses).where(eq(ipAddresses.orderId, o.id))).toHaveLength(0);
    expect((await w.c.billing.get(w.tenantId, invoiceId!)).status).toBe('VOID');
  });

  it('issued invoices cannot be altered', async () => {
    const [inv] = await w.c.db.select().from(invoices).where(and(eq(invoices.tenantId, w.tenantId), eq(invoices.status, 'PAID'))).limit(1);
    expect(await dbError(w.c.db.update(invoices).set({ totalMinor: 1n, subtotalMinor: 1n, taxMinor: 0n }).where(eq(invoices.id, inv.id)))).toMatch(/cannot be altered/);
  });

  it('numbers concurrently issued invoices without gaps or duplicates', async () => {
    const cust = await makeCustomer('27');
    const made = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        w.c.billing.inTx((tx) => w.c.billing.createInvoice(tx, { tenantId: w.tenantId, customerId: cust, kind: 'MANUAL', lines: [{ description: `Item ${i}`, unitMinor: 1000n, taxRateBp: 1800 }], sendEmail: false })),
      ),
    );
    const seqs = made.map((i) => Number(i.number!.split('/')[2])).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(10);
    expect(seqs[9] - seqs[0]).toBe(9);
  });

  it('renders a PDF tax invoice', async () => {
    const [inv] = await w.c.db.select().from(invoices).where(and(eq(invoices.status, 'PAID'), eq(invoices.tenantId, w.tenantId))).limit(1);
    const pdf = await w.c.billing.pdf(w.tenantId, inv.id);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
  });
});

describe('renewals and overdue handling', () => {
  it('invoices renewals once, suspends after the grace period, and payment restores the service', async () => {
    const cust = await makeCustomer('27');
    const { order: o, invoiceId } = await order(cust, 'renewal-1');
    await w.c.billing.recordManualPayment({ tenantId: w.tenantId, invoiceId: invoiceId!, amountMinor: (await w.c.billing.get(w.tenantId, invoiceId!)).totalMinor, reference: 'UTR-RENEW-1', actor: ADMIN });
    await w.q.runProvision(o.id);
    const [svc] = await w.c.db.select().from(services).where(eq(services.orderId, o.id));
    const due = new Date(Date.now() + 3 * 86_400_000);
    await w.c.db.update(services).set({ nextDueDate: due }).where(eq(services.id, svc.id));

    expect((await w.c.billing.runAutomation(w.tenantId)).renewals).toBeGreaterThanOrEqual(1);
    await w.c.billing.runAutomation(w.tenantId); // second run: no duplicate
    const ren = await w.c.db.select().from(invoices).where(and(eq(invoices.serviceId, svc.id), eq(invoices.kind, 'RENEWAL')));
    expect(ren).toHaveLength(1);
    expect(ren[0].totalMinor).toBe(54900n + 2n * 4941n);

    // Five days later: overdue past the 3-day grace → suspended.
    const later = new Date(due.getTime() + 4 * 86_400_000);
    const out = await w.c.billing.runAutomation(w.tenantId, later);
    expect(out.overdue).toBeGreaterThanOrEqual(1);
    expect((await w.c.db.select().from(services).where(eq(services.id, svc.id)))[0].status).toBe('SUSPENDED');

    await w.c.billing.recordManualPayment({ tenantId: w.tenantId, invoiceId: ren[0].id, amountMinor: ren[0].totalMinor, reference: 'UTR-RENEW-2', actor: ADMIN });
    const after = (await w.c.db.select().from(services).where(eq(services.id, svc.id)))[0];
    expect(after.status).toBe('ACTIVE');
    expect(after.nextDueDate!.getTime()).toBeGreaterThan(due.getTime());
    await expect(
      w.c.billing.recordManualPayment({ tenantId: w.tenantId, invoiceId: ren[0].id, amountMinor: 100n, reference: 'UTR-RENEW-3', actor: ADMIN }),
    ).rejects.toMatchObject({ code: 'invoice_not_payable' });
  });
});

describe('emails and support', () => {
  it('delivers queued email through the transport', async () => {
    const before = mail.sent.length;
    const r = await w.c.email.deliverPending(500);
    expect(r.sent).toBeGreaterThan(0);
    expect(mail.sent.length).toBe(before + r.sent);
    expect(mail.sent.some((m) => /is ready/.test(m.subject))).toBe(true);
    expect((await w.c.email.deliverPending()).sent).toBe(0); // nothing sent twice
  });

  it('uses an admin-edited template', async () => {
    await w.c.email.saveTemplate(w.tenantId, 'account.welcome', 'Hi {{name}} from {{brand}}', 'Body {{email}}');
    const id = await w.c.email.queue(w.c.db, { tenantId: w.tenantId, to: 'x@example.in', key: 'account.welcome', vars: { name: 'Ravi', email: 'x@example.in' } });
    const [m] = await w.c.db.select().from(emailMessages).where(eq(emailMessages.id, id!));
    expect(m.subject).toBe('Hi Ravi from CloudPilot');
  });

  it('tickets: staff alerted, customer notified of replies, internal notes hidden, other customers locked out', async () => {
    const custA = await makeCustomer('27', 'ticket-a@example.in');
    const custB = await makeCustomer('27', 'ticket-b@example.in');
    const [dept] = await w.c.support.departments(w.tenantId);
    const scopeA = { kind: 'customer' as const, customerId: custA, userId: crypto.randomUUID(), name: 'Asha' };
    const t = await w.c.support.open({ tenantId: w.tenantId, scope: scopeA, departmentId: dept.id, subject: 'Cannot SSH', body: 'Connection refused on port 22' });
    const staff = { kind: 'staff' as const, userId: crypto.randomUUID(), name: 'Neha (support)' };
    await w.c.support.reply({ tenantId: w.tenantId, scope: staff, ticketId: t.id, body: 'Checked: firewall rule missing', internal: true });
    await w.c.support.reply({ tenantId: w.tenantId, scope: staff, ticketId: t.id, body: 'Please try again now.' });
    const seen = await w.c.support.get(w.tenantId, scopeA, t.id);
    expect(seen.messages.map((m) => m.body)).toEqual(['Connection refused on port 22', 'Please try again now.']);
    expect(seen.status).toBe('ANSWERED');
    await expect(w.c.support.get(w.tenantId, { kind: 'customer', customerId: custB, userId: crypto.randomUUID(), name: 'B' }, t.id)).rejects.toMatchObject({ httpStatus: 404 });
    const mails = await w.c.db.select().from(emailMessages).where(eq(emailMessages.relatedId, t.id));
    expect(mails.map((m) => [m.templateKey, m.toAddress])).toEqual(
      expect.arrayContaining([
        ['staff.ticket', 'support@crapplet.test'],
        ['ticket.reply', 'ticket-a@example.in'],
      ]),
    );
    expect(mails.some((m) => m.body.includes('firewall rule missing'))).toBe(false); // internal note never emailed
  });
});

describe('accounts', () => {
  it('sign-up never reveals existing accounts and password reset links work once', async () => {
    const slug = (await w.c.db.select().from(tenants).where(eq(tenants.id, w.tenantId)))[0].slug;
    await makeCustomer('27', 'reset-me@example.in');
    const dup = await w.c.auth.registerCustomer({ tenantSlug: slug, name: 'X', email: 'reset-me@example.in', password: 'another-pass-123', country: 'IN' });
    expect(dup.created).toBe(false);
    expect(await w.c.db.select().from(customers).where(eq(customers.email, 'reset-me@example.in'))).toHaveLength(1);

    const r = await w.c.auth.createResetToken(w.c.redis, slug, 'reset-me@example.in');
    expect(r).not.toBeNull();
    await w.c.auth.resetPassword(w.c.redis, r!.token, 'brand-new-pass-456');
    await expect(w.c.auth.resetPassword(w.c.redis, r!.token, 'again-pass-7890')).rejects.toMatchObject({ code: 'invalid_token' });
    const login = await w.c.auth.login({ tenantSlug: slug, email: 'reset-me@example.in', password: 'brand-new-pass-456' });
    expect(login.user.role).toBe('CUSTOMER');
    expect(await w.c.auth.createResetToken(w.c.redis, slug, 'nobody@example.in')).toBeNull();
  });
});
