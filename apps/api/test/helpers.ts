import { MemoryStateStore } from '@cloudpilot/hypervisor-sdk';
import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { createContainer, type Container } from '../src/container';
import { runMigrations } from '../src/db/migrate';
import { locations, osTemplates, tenants } from '../src/db/schema';
import { InlineQueue } from '../src/modules/jobs/inline-queue';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://cloudpilot:cloudpilot@127.0.0.1:5432/cloudpilot_test';

/** Drops and re-creates the test schema, then applies all migrations. */
export async function resetDatabase() {
  const client = new Client({ connectionString: TEST_DB_URL });
  await client.connect();
  await client.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await client.end();
  await runMigrations(TEST_DB_URL);
}

export function testEnv() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
  process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.JWT_SECRET ??= 'test-jwt-secret-that-is-definitely-long-enough';
  process.env.SANDBOX_GATEWAY_SECRET = 'sandbox-test-secret';
  process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = 'true';
  resetEnvCache();
  return loadEnv();
}

export interface World {
  c: Container;
  q: InlineQueue;
  mockStore: MemoryStateStore;
  tenantId: string;
  locationId: string;
  providerId: string;
  templateId: string;
  v4PoolId: string;
  productId: string;
  priceListId: string;
}

export async function buildWorld(opts: { failures?: Record<string, unknown>; emailTransport?: import('../src/modules/email/email.service').EmailTransport | null } = {}): Promise<World> {
  const env = testEnv();
  const mockStore = new MemoryStateStore();
  let q!: InlineQueue;
  const c = createContainer(env, {
    mockStore,
    queueFactory: (p) => (q = new InlineQueue(p, 'manual')),
    provisioning: { verifyAttempts: 2, verifyIntervalMs: 1 },
    emailTransport: opts.emailTransport ?? null,
  });
  const [tenant] = await c.db.insert(tenants).values({ slug: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: 'Crapplet Cloud' }).returning();
  const [loc] = await c.db.insert(locations).values({ tenantId: tenant.id, code: 'IN-MUM-1', name: 'Mumbai 1', country: 'IN' }).returning();
  const provider = await c.hypervisors.create({
    tenantId: tenant.id,
    locationId: loc.id,
    name: `mock-${tenant.slug}`,
    type: 'mock',
    endpoint: 'https://mock.invalid',
    credentials: { token: 'unused' },
    options: opts.failures ? { failures: opts.failures } : {},
  });
  await c.hypervisors.discover(tenant.id, provider.id);
  const [tpl] = await c.db.select().from(osTemplates).where(eq(osTemplates.providerId, provider.id));
  const { pool } = await c.ipam.createPool({
    tenantId: tenant.id,
    locationId: loc.id,
    name: 'mum-v4',
    cidr: '203.0.113.0/28',
    gateway: '203.0.113.1',
    nameservers: ['1.1.1.1'],
  });
  const product = await c.catalog.createProduct({
    tenantId: tenant.id,
    sku: 'VPS-2C4G',
    name: 'Linux VPS 2 vCPU / 4 GB',
    type: 'VPS_LINUX',
    status: 'ACTIVE',
    cpuCores: 2,
    memoryMb: 4096,
    diskGb: 60,
    ipv4Count: 1,
  });
  await c.catalog.upsertPlacement(tenant.id, product.id, {
    locationId: loc.id,
    providerId: provider.id,
    node: 'mock-node-1',
    storage: 'local-lvm',
    bridge: 'vmbr0',
    ipv4PoolId: pool.id,
    templateIds: [tpl.id],
  });
  const pl = await c.catalog.createPriceList(tenant.id, 'Wholesale INR', 'INR', true);
  await c.catalog.setPrice(tenant.id, pl.id, product.id, 'MONTHLY', 50000n); // ₹500.00
  return {
    c,
    q,
    mockStore,
    tenantId: tenant.id,
    locationId: loc.id,
    providerId: provider.id,
    templateId: tpl.id,
    v4PoolId: pool.id,
    productId: product.id,
    priceListId: pl.id,
  };
}

export const ADMIN = { type: 'user' as const, id: '00000000-0000-0000-0000-000000000001' };

export async function makeReseller(w: World, opts: { model?: 'PREPAID' | 'CREDIT'; creditLimitMinor?: bigint; fundMinor?: bigint } = {}) {
  const { reseller } = await w.c.resellers.create({
    tenantId: w.tenantId,
    name: `Reseller ${Math.random().toString(36).slice(2, 7)}`,
    contactEmail: 'ops@reseller.test',
    model: opts.model ?? 'PREPAID',
    currency: 'INR',
    creditLimitMinor: opts.creditLimitMinor,
    actor: ADMIN,
  });
  if (opts.fundMinor) await fundViaBankTransfer(w, reseller.id, opts.fundMinor);
  return reseller;
}

export async function fundViaBankTransfer(w: World, resellerId: string, amount: bigint) {
  const d = await w.c.deposits.submitBankTransfer({
    tenantId: w.tenantId,
    resellerId,
    amountMinor: amount,
    bankReference: `UTR${Math.random().toString().slice(2, 14)}`,
    source: 'PORTAL',
    actor: { type: 'user', id: null },
  });
  await w.c.deposits.approve({ tenantId: w.tenantId, depositId: d.id, actor: ADMIN });
  return d;
}

export function orderInput(w: World, resellerId: string, key: string, extra: Record<string, unknown> = {}) {
  return {
    tenantId: w.tenantId,
    resellerId,
    actor: { type: 'api_key' as const, id: 'test' },
    source: 'WHMCS' as const,
    idempotencyKey: key,
    productSku: 'VPS-2C4G',
    locationCode: 'IN-MUM-1',
    templateId: w.templateId,
    cycle: 'MONTHLY' as const,
    hostname: 'vps1.customer.example',
    customer: { externalRef: 'whmcs-client-42', name: 'Acme Pvt Ltd', email: 'it@acme.example' },
    retail: { amountMinor: 89900n, currency: 'INR' },
    password: 'Sup3r-Secret-Pass!',
    ...extra,
  };
}
