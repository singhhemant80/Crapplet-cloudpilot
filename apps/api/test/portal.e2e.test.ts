import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';
import { MemoryTransport } from '../src/modules/email/email.service';
import { buildWorld, testEnv, type World } from './helpers';

let w: World;
let app: INestApplication;
let http: ReturnType<typeof request>;
let slug: string;
let adminToken: string;
const mail = new MemoryTransport();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function signUp(email: string, extra: Record<string, unknown> = {}) {
  const r = await http.post('/v1/auth/register').send({ tenant: slug, name: 'Asha Rao', email, password: 'customer-pass-123', country: 'IN', stateCode: '27', ...extra });
  expect(r.status).toBe(200);
  const login = await http.post('/v1/auth/login').send({ tenant: slug, email, password: 'customer-pass-123' });
  expect(login.status).toBe(200);
  return login.body.accessToken as string;
}

beforeAll(async () => {
  w = await buildWorld({ emailTransport: mail });
  await w.c.redis.flushdb();
  app = await createApp(w.c, testEnv());
  await app.init();
  http = request(app.getHttpServer());
  slug = (await w.c.db.execute(`select slug from tenants where id = '${w.tenantId}'`)).rows[0].slug as string;
  await w.c.auth.createUser({ tenantId: w.tenantId, email: 'root@cp.test', name: 'Root', password: 'correct horse battery', role: 'PLATFORM_ADMIN' });
  adminToken = (await http.post('/v1/auth/login').send({ tenant: slug, email: 'root@cp.test', password: 'correct horse battery' })).body.accessToken;
});
afterAll(async () => {
  await app?.close();
  await w.c.close();
});

describe('store → invoice → payment → provisioning over HTTP', () => {
  it('runs the whole customer journey', async () => {
    const A = auth(adminToken);
    // Admin: seller details, retail prices, GST rate.
    expect((await http.put('/v1/admin/settings').set(A).send({ company: { legalName: 'Crapplet Infotech Private Limited', gstin: '27AAACC1234F1Z5', stateCode: '27', supportEmail: 'support@crapplet.test' } })).status).toBe(200);
    expect((await http.put('/v1/admin/settings').set(A).send({ company: { gstin: 'BAD' } })).status).toBe(422);
    const pl = await http.post('/v1/admin/price-lists').set(A).send({ name: 'Retail INR', currency: 'INR', isDefaultRetail: true });
    expect(pl.status).toBe(201);
    await http.put(`/v1/admin/price-lists/${pl.body.id}/prices`).set(A).send({ productId: w.productId, cycle: 'MONTHLY', amountMinor: '80000' }).expect(200);
    await http.patch(`/v1/admin/products/${w.productId}`).set(A).send({ gstRateBp: 1800, hsnSac: '998315' }).expect(200);

    const tok = await signUp('asha@example.in', { gstin: '27ABCDE1234F1Z5', companyName: 'Rao Traders' });
    const C = auth(tok);
    expect(mail.sent.length).toBe(0); // queued in the outbox, not sent inline
    await w.c.email.deliverPending();
    expect(mail.sent.find((m) => m.to === 'asha@example.in')?.subject).toMatch(/Welcome/);

    // Customers cannot reach admin or reseller APIs.
    expect((await http.get('/v1/admin/invoices').set(C)).status).toBe(403);
    expect((await http.get('/v1/reseller/me').set(C)).status).toBe(403);

    const store = await http.get('/v1/customer/store/products').set(C).expect(200);
    expect(store.body[0]).toMatchObject({ sku: 'VPS-2C4G', pricing: [{ cycle: 'MONTHLY', amountMinor: '80000' }] });

    const body = { idempotencyKey: 'checkout-0001', productSku: 'VPS-2C4G', locationCode: 'IN-MUM-1', templateId: w.templateId, cycle: 'MONTHLY', hostname: 'shop.rao.example', password: 'Server-Pass-2026!' };
    const ord = await http.post('/v1/customer/orders').set(C).send(body).expect(201);
    expect(ord.body.status).toBe('PENDING_PAYMENT');
    const again = await http.post('/v1/customer/orders').set(C).send(body).expect(201);
    expect(again.body).toMatchObject({ orderId: ord.body.orderId, replayed: true });

    const inv = await http.get(`/v1/customer/invoices/${ord.body.invoiceId}`).set(C).expect(200);
    expect(inv.body).toMatchObject({ status: 'UNPAID', taxType: 'INTRA', subtotalMinor: '80000', cgstMinor: '7200', sgstMinor: '7200', totalMinor: '94400' });
    const pdf = await http.get(`/v1/customer/invoices/${ord.body.invoiceId}/pdf`).set(C).expect(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);

    // Another customer sees nothing of this.
    const other = auth(await signUp('other@example.in'));
    expect((await http.get(`/v1/customer/invoices/${ord.body.invoiceId}`).set(other)).status).toBe(404);
    expect((await http.post(`/v1/customer/invoices/${ord.body.invoiceId}/pay`).set(other).send({ gateway: 'sandbox' })).status).toBe(404);

    // Pay through the hosted sandbox checkout; only the signed webhook marks it paid.
    const pay = await http.post(`/v1/customer/invoices/${ord.body.invoiceId}/pay`).set(C).send({ gateway: 'sandbox' }).expect(200);
    const orderRef = pay.body.checkout.gatewayOrderId as string;
    const page = await http.get(`/v1/payments/sandbox/checkout/${orderRef}`).expect(200);
    expect(page.text).toContain('Invoice payment');
    expect(page.text).toContain('944.00');
    expect((await http.get(`/v1/customer/invoices/${ord.body.invoiceId}`).set(C)).body.status).toBe('UNPAID');
    await http.post(`/v1/payments/sandbox/checkout/${orderRef}/complete`).type('form').send({ outcome: 'captured' }).expect(201);
    expect((await http.get(`/v1/customer/invoices/${ord.body.invoiceId}`).set(C)).body).toMatchObject({ status: 'PAID', paidMinor: '94400' });

    await w.q.runProvision(ord.body.orderId);
    const svcs = await http.get('/v1/customer/services').set(C).expect(200);
    expect(svcs.body[0]).toMatchObject({ status: 'ACTIVE', hostname: 'shop.rao.example' });
    const sid = svcs.body[0].id as string;

    // Extras through HTTP.
    expect((await http.get(`/v1/customer/services/${sid}/reinstall`).set(C).expect(200)).body.length).toBeGreaterThan(0);
    await http.post(`/v1/customer/services/${sid}/snapshots/create`).set(C).send({ name: 'before-update' }).expect(200);
    expect((await http.get(`/v1/customer/services/${sid}/snapshots`).set(C).expect(200)).body.map((s: { name: string }) => s.name)).toEqual(['before-update']);
    expect((await http.post(`/v1/customer/services/${sid}/snapshots/create`).set(other).send({ name: 'x-snap' })).status).toBe(404);
    expect((await http.post(`/v1/customer/services/${sid}/reinstall`).set(C).send({ templateId: w.templateId, password: 'Server-Pass-2027!' })).status).toBe(422); // confirm required

    // Admin sees the paid invoice and the customer.
    const list = await http.get('/v1/admin/invoices?status=PAID').set(A).expect(200);
    expect(list.body.some((i: { id: string }) => i.id === ord.body.invoiceId)).toBe(true);
    const cust = await http.get(`/v1/admin/customers?q=asha@`).set(A).expect(200);
    expect(cust.body[0]).toMatchObject({ email: 'asha@example.in', services: 1, unpaidMinor: '0' });
  });

  it('unpaid orders can be cancelled by their owner, freeing the IP', async () => {
    const C = auth(await signUp('cancel@example.in'));
    const ord = await http
      .post('/v1/customer/orders')
      .set(C)
      .send({ idempotencyKey: 'checkout-cancel', productSku: 'VPS-2C4G', locationCode: 'IN-MUM-1', templateId: w.templateId, cycle: 'MONTHLY', hostname: 'c.example.in', password: 'Server-Pass-2026!' })
      .expect(201);
    await http.post(`/v1/customer/orders/${ord.body.orderId}/cancel`).set(C).expect(200);
    expect((await http.get(`/v1/customer/invoices/${ord.body.invoiceId}`).set(C)).body.status).toBe('VOID');
    const ips = await w.c.db.execute(`select count(*)::int n from ip_addresses where order_id = '${ord.body.orderId}'`);
    expect(ips.rows[0].n).toBe(0);
  });

  it('manual invoices and offline payments by staff', async () => {
    const A = auth(adminToken);
    await signUp('manual@example.in', { stateCode: '29' });
    const [cust] = (await http.get('/v1/admin/customers?q=manual').set(A)).body;
    const inv = await http
      .post('/v1/admin/invoices')
      .set(A)
      .send({ customerId: cust.id, lines: [{ description: 'Server migration', unitMinor: '150000', taxRateBp: 1800 }] })
      .expect(201);
    expect(inv.body).toMatchObject({ status: 'UNPAID', taxType: 'INTER', igstMinor: '27000', totalMinor: '177000' });
    expect(inv.body.number).toMatch(/^CP\/\d{4}-\d{2}\/\d{5}$/);
    await http.post(`/v1/admin/invoices/${inv.body.id}/payments`).set(A).send({ amountMinor: '100000', reference: 'UTR-1' }).expect(201);
    expect((await http.get(`/v1/admin/invoices/${inv.body.id}`).set(A)).body.status).toBe('PARTIALLY_PAID');
    await http.post(`/v1/admin/invoices/${inv.body.id}/payments`).set(A).send({ amountMinor: '77000', reference: 'UTR-2' }).expect(201);
    expect((await http.get(`/v1/admin/invoices/${inv.body.id}`).set(A)).body.status).toBe('PAID');
    expect((await http.post(`/v1/admin/invoices/${inv.body.id}/void`).set(A).send({ reason: 'mistake' })).status).toBe(409);
  });
});

describe('support desk and account recovery', () => {
  it('tickets: customer ↔ staff with internal notes kept private', async () => {
    const A = auth(adminToken);
    const C = auth(await signUp('ticket@example.in'));
    await w.c.email.deliverPending(); // welcome mail out of the way
    const depts = await http.get('/v1/customer/support/departments').set(C).expect(200);
    const t = await http.post('/v1/customer/tickets').set(C).send({ departmentId: depts.body[0].id, subject: 'Server is slow', body: 'Load is high since morning' }).expect(201);
    await http.post(`/v1/admin/tickets/${t.body.id}/replies`).set(A).send({ body: 'Customer runs a crypto miner?', internal: true }).expect(201);
    await http.post(`/v1/admin/tickets/${t.body.id}/replies`).set(A).send({ body: 'We are checking the host now.' }).expect(201);
    const seen = await http.get(`/v1/customer/tickets/${t.body.id}`).set(C).expect(200);
    expect(seen.body.status).toBe('ANSWERED');
    expect(seen.body.messages.map((m: { body: string }) => m.body)).toEqual(['Load is high since morning', 'We are checking the host now.']);
    const staffView = await http.get(`/v1/admin/tickets/${t.body.id}`).set(A).expect(200);
    expect(staffView.body.messages).toHaveLength(3);
    const other = auth(await signUp('ticket2@example.in'));
    expect((await http.get(`/v1/customer/tickets/${t.body.id}`).set(other)).status).toBe(404);

    mail.sent.length = 0;
    await w.c.email.deliverPending();
    const toCustomer = mail.sent.filter((m) => m.to === 'ticket@example.in');
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0].text).toContain('We are checking the host now.');
    expect(mail.sent.some((m) => m.text.includes('crypto miner'))).toBe(false);
  });

  it('forgot/reset password: single-use link, no account enumeration', async () => {
    await signUp('reset@example.in');
    await w.c.email.deliverPending();
    mail.sent.length = 0;
    const r1 = await http.post('/v1/auth/forgot').send({ tenant: slug, email: 'reset@example.in' }).expect(200);
    const r2 = await http.post('/v1/auth/forgot').send({ tenant: slug, email: 'nobody@example.in' }).expect(200);
    expect(r1.body).toEqual(r2.body);
    await w.c.email.deliverPending();
    const link = mail.sent.find((m) => m.to === 'reset@example.in')!.text.match(/reset\?token=([\w-]+)/)![1];
    await http.post('/v1/auth/reset').send({ token: link, password: 'brand-new-pass-456' }).expect(200);
    expect((await http.post('/v1/auth/reset').send({ token: link, password: 'another-pass-789' })).status).toBe(400);
    expect((await http.post('/v1/auth/login').send({ tenant: slug, email: 'reset@example.in', password: 'customer-pass-123' })).status).toBe(401);
    const ok = await http.post('/v1/auth/login').send({ tenant: slug, email: 'reset@example.in', password: 'brand-new-pass-456' });
    expect(ok.status).toBe(200);
    await http.post('/v1/auth/password').set(auth(ok.body.accessToken)).send({ currentPassword: 'wrong', newPassword: 'third-pass-000000' }).expect(400);
    await http.post('/v1/auth/password').set(auth(ok.body.accessToken)).send({ currentPassword: 'brand-new-pass-456', newPassword: 'third-pass-000000' }).expect(200);
  });

  it('signing up twice does not reveal the account', async () => {
    const a = await http.post('/v1/auth/register').send({ tenant: slug, name: 'X', email: 'dup@example.in', password: 'customer-pass-123', country: 'IN' });
    const b = await http.post('/v1/auth/register').send({ tenant: slug, name: 'X', email: 'dup@example.in', password: 'something-else-1', country: 'IN' });
    expect(a.body).toEqual(b.body);
    expect((await http.post('/v1/auth/login').send({ tenant: slug, email: 'dup@example.in', password: 'something-else-1' })).status).toBe(401);
  });
});
