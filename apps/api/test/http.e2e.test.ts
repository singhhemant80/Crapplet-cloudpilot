import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';
import { users } from '../src/db/schema';
import { ADMIN, buildWorld, makeReseller, testEnv, type World } from './helpers';

let w: World;
let app: INestApplication;
let http: ReturnType<typeof request>;
let adminToken: string;
let resellerId: string;
let apiKey: string;
let otherKey: string;

beforeAll(async () => {
  w = await buildWorld();
  await w.c.redis.flushdb(); // rate-limit buckets
  app = await createApp(w.c, testEnv());
  await app.init();
  http = request(app.getHttpServer());

  const tenantSlug = (await w.c.db.execute(`select slug from tenants where id = '${w.tenantId}'`)).rows[0].slug as string;
  await w.c.auth.createUser({ tenantId: w.tenantId, email: 'root@cp.test', name: 'Root', password: 'correct horse battery', role: 'PLATFORM_ADMIN' });
  const login = await http.post('/v1/auth/login').send({ tenant: tenantSlug, email: 'root@cp.test', password: 'correct horse battery' });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken;

  const r = await makeReseller(w, { fundMinor: 300000n });
  resellerId = r.id;
  apiKey = (await w.c.auth.createApiKey({ tenantId: w.tenantId, resellerId, name: 'whmcs', scopes: ['products:read', 'orders:write', 'orders:read', 'services:read', 'services:write', 'wallet:read', 'wallet:write'], actor: ADMIN })).apiKey;
  const other = await makeReseller(w, { fundMinor: 1000n });
  otherKey = (await w.c.auth.createApiKey({ tenantId: w.tenantId, resellerId: other.id, name: 'other', scopes: ['orders:read', 'services:read'], actor: ADMIN })).apiKey;
});

afterAll(async () => {
  await app?.close();
  await w.c.close();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('HTTP API', () => {
  it('health and readiness', async () => {
    expect((await http.get('/health')).status).toBe(200);
    const ready = await http.get('/ready');
    expect(ready.body).toMatchObject({ status: 'ready', checks: { database: 'ok', redis: 'ok' } });
  });

  it('denies unauthenticated and wrong-role access', async () => {
    expect((await http.get('/v1/admin/overview')).status).toBe(401);
    expect((await http.get('/v1/admin/overview').set(auth(apiKey))).status).toBe(403);
    expect((await http.get('/v1/reseller/me').set(auth(adminToken))).status).toBe(403);
    expect((await http.get('/v1/reseller/me').set(auth('cp_0123456789abcdef_' + 'x'.repeat(43)))).status).toBe(401);
  });

  it('wrong password is rejected and does not reveal which part was wrong', async () => {
    const res = await http.post('/v1/auth/login').send({ tenant: 'nope', email: 'root@cp.test', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('never returns provider credentials', async () => {
    const res = await http.get('/v1/admin/hypervisors').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/encryptedCredentials|"credentials"/);
  });

  it('reseller catalog shows wholesale prices as minor-unit strings', async () => {
    const res = await http.get('/v1/reseller/products').set(auth(apiKey));
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ sku: 'VPS-2C4G', pricing: [{ cycle: 'MONTHLY', amountMinor: '50000', currency: 'INR' }] });
    expect(res.body[0].locations[0].templates.length).toBeGreaterThan(0);
  });

  it('order lifecycle over HTTP with idempotency header, as the WHMCS module does', async () => {
    const body = {
      productSku: 'VPS-2C4G',
      locationCode: 'IN-MUM-1',
      templateId: w.templateId,
      cycle: 'MONTHLY',
      hostname: 'srv1.acme.example',
      customer: { externalRef: 'whmcs-client-9', name: 'Acme' },
      retail: { amountMinor: '99900', currency: 'INR' },
      password: 'An0ther-Str0ng-Pass',
      source: 'WHMCS',
    };
    const first = await http.post('/v1/reseller/orders').set(auth(apiKey)).set('Idempotency-Key', 'whmcs:test:service:55').send(body);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('QUEUED');
    expect(JSON.stringify(first.body)).not.toMatch(/An0ther|encryptedSecret|requestHash/);
    const again = await http.post('/v1/reseller/orders').set(auth(apiKey)).set('Idempotency-Key', 'whmcs:test:service:55').send(body);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.replayed).toBe(true);

    await w.q.runProvision(first.body.id);
    const byKey = await http.get('/v1/reseller/orders/by-key/whmcs:test:service:55').set(auth(apiKey));
    expect(byKey.body.status).toBe('ACTIVE');
    const serviceId = byKey.body.service.id;

    // Another reseller cannot see it.
    expect((await http.get(`/v1/reseller/orders/${first.body.id}`).set(auth(otherKey))).status).toBe(404);
    expect((await http.get(`/v1/reseller/services/${serviceId}`).set(auth(otherKey))).status).toBe(404);

    const susp = await http.post(`/v1/reseller/services/${serviceId}/actions/suspend`).set(auth(apiKey)).send({ reason: 'overdue' });
    expect(susp.status).toBe(200);
    expect(susp.body.result).toEqual({ status: 'SUSPENDED' });
    const bad = await http.post(`/v1/reseller/services/${serviceId}/actions/reboot`).set(auth(apiKey));
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('service_not_active');

    const renew1 = await http.post(`/v1/reseller/services/${serviceId}/renew`).set(auth(apiKey)).set('Idempotency-Key', 'inv-1001');
    const renew2 = await http.post(`/v1/reseller/services/${serviceId}/renew`).set(auth(apiKey)).set('Idempotency-Key', 'inv-1001');
    expect(renew1.status).toBe(200);
    expect(renew2.body.replayed).toBe(true);

    const wallet = await http.get('/v1/reseller/wallet').set(auth(apiKey));
    expect(wallet.body).toMatchObject({ availableMinor: '200000', reservedMinor: '0' });
    const margins = await http.get('/v1/reseller/reports/margins').set(auth(apiKey));
    expect(margins.body[0]).toMatchObject({ orders: 1, wholesale_minor: '50000', retail_minor: '99900', marginMinor: '49900' });
  });

  it('scopes are enforced for API keys', async () => {
    const res = await http.post('/v1/reseller/orders').set(auth(otherKey)).set('Idempotency-Key', 'x').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('insufficient_scope');
    // API keys cannot mint more API keys.
    expect((await http.post('/v1/reseller/api-keys').set(auth(apiKey)).send({ name: 'x', scopes: ['orders:read'] })).status).toBe(403);
  });

  it('there is no endpoint that lets a reseller credit its own wallet', async () => {
    const top = await http.post('/v1/reseller/wallet/topups').set(auth(apiKey)).send({ gateway: 'sandbox', amountMinor: '10000' });
    expect(top.status).toBe(201);
    expect(top.body.deposit.status).toBe('AWAITING_PAYMENT');
    const forged = await http
      .post('/v1/payments/webhooks/sandbox')
      .set('Content-Type', 'application/json')
      .set('x-sandbox-signature', '00'.repeat(32))
      .send(JSON.stringify({ id: 'evt_forged', type: 'payment.captured', data: { orderId: top.body.deposit.gatewayOrderId, paymentId: 'p', amountMinor: '10000', currency: 'INR' } }));
    expect(forged.status).toBe(400);
    const wallet = await http.get('/v1/reseller/wallet').set(auth(apiKey));
    expect(wallet.body.availableMinor).toBe('200000');

    // A correctly signed webhook (as the gateway would send) does credit — once.
    const raw = JSON.stringify({ id: 'evt_real_1', type: 'payment.captured', data: { orderId: top.body.deposit.gatewayOrderId, paymentId: 'p1', amountMinor: '10000', currency: 'INR' } });
    for (let i = 0; i < 3; i++) {
      const ok = await http.post('/v1/payments/webhooks/sandbox').set('Content-Type', 'application/json').set('x-sandbox-signature', w.c.sandboxGateway!.sign(raw)).send(raw);
      expect(ok.status).toBe(200);
    }
    expect((await http.get('/v1/reseller/wallet').set(auth(apiKey))).body.availableMinor).toBe('210000');
  });

  it('admin overview and reconciliation', async () => {
    const res = await http.get('/v1/admin/overview').set(auth(adminToken));
    expect(res.status).toBe(200);
    const rec = await http.get('/v1/admin/ledger/reconcile').set(auth(adminToken));
    expect(rec.body).toMatchObject({ ok: true, problems: [] });
  });

  it('logout revokes the session immediately', async () => {
    const [u] = await w.c.db.select().from(users).limit(1);
    void u;
    const login = await http.post('/v1/auth/login').send({ tenant: (await w.c.db.execute(`select slug from tenants where id = '${w.tenantId}'`)).rows[0].slug, email: 'root@cp.test', password: 'correct horse battery' });
    const t = login.body.accessToken;
    expect((await http.get('/v1/auth/me').set(auth(t))).status).toBe(200);
    await http.post('/v1/auth/logout').set(auth(t));
    expect((await http.get('/v1/auth/me').set(auth(t))).status).toBe(401);
  });
});
