import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../config/env';
import { createContainer } from '../container';
import { InlineQueue } from '../modules/jobs/inline-queue';
import { locations, osTemplates, priceLists, products, resellers, tenants, users } from './schema';

/**
 * Idempotent seed.
 *   npm run db:seed                 → default tenant + platform administrator
 *   npm run db:seed -- --demo       → plus a mock datacenter, IP pool, VPS product, price list
 *                                      and a funded demo reseller (development/staging only)
 *
 * Credentials come from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD; if the password is
 * absent a random one is generated and printed ONCE.
 */
async function main() {
  const env = loadEnv();
  const demo = process.argv.includes('--demo');
  if (demo && env.NODE_ENV === 'production') throw new Error('--demo is not allowed in production');
  const c = createContainer(env, { queueFactory: (p) => new InlineQueue(p) });
  const ADMIN = { type: 'system' as const, id: 'seed' };
  try {
    const [tenant] = await c.db
      .insert(tenants)
      .values({ slug: 'default', name: process.env.SEED_COMPANY_NAME ?? 'Crapplet Infotech Private Limited', brandName: process.env.SEED_BRAND ?? 'CloudPilot' })
      .onConflictDoNothing()
      .returning()
      .then(async (r) => (r.length ? r : c.db.select().from(tenants).where(eq(tenants.slug, 'default'))));

    const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@cloudpilot.local').toLowerCase();
    const [existingAdmin] = await c.db.select().from(users).where(and(eq(users.tenantId, tenant.id), eq(users.email, email)));
    if (!existingAdmin) {
      const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
      await c.auth.createUser({ tenantId: tenant.id, email, name: 'Platform Administrator', password, role: 'PLATFORM_ADMIN' });
      console.log(`Created platform admin ${email}${process.env.SEED_ADMIN_PASSWORD ? '' : ` with generated password: ${password}  (shown once — store it now)`}`);
    } else console.log(`Platform admin ${email} already exists`);

    if (!demo) return;

    let [loc] = await c.db.select().from(locations).where(and(eq(locations.tenantId, tenant.id), eq(locations.code, 'IN-MUM-1')));
    loc ??= (await c.db.insert(locations).values({ tenantId: tenant.id, code: 'IN-MUM-1', name: 'Mumbai DC1', country: 'IN' }).returning())[0];

    let provider = (await c.hypervisors.list(tenant.id)).find((p) => p.name === 'Mock Cluster (dev)');
    provider ??= await c.hypervisors.create({
      tenantId: tenant.id,
      locationId: loc.id,
      name: 'Mock Cluster (dev)',
      type: 'mock',
      endpoint: 'https://mock.invalid',
      credentials: { note: 'mock provider – no real infrastructure' },
    });
    await c.hypervisors.testConnection(tenant.id, provider.id);
    await c.hypervisors.discover(tenant.id, provider.id);
    const tpls = await c.db.select().from(osTemplates).where(eq(osTemplates.providerId, provider.id));

    const pools = await c.ipam.listPools(tenant.id);
    let poolId = pools.find((p) => p.name === 'Mumbai public v4')?.id as string | undefined;
    if (!poolId) {
      const res = await c.ipam.createPool({
        tenantId: tenant.id,
        locationId: loc.id,
        name: 'Mumbai public v4',
        cidr: '203.0.113.0/26',
        gateway: '203.0.113.1',
        nameservers: ['1.1.1.1', '8.8.8.8'],
        vlanTag: 100,
      });
      poolId = res.pool.id;
    }

    const plans = [
      { sku: 'VPS-1C2G', name: 'Linux VPS S — 1 vCPU / 2 GB / 40 GB', cpuCores: 1, memoryMb: 2048, diskGb: 40, monthly: 29900n },
      { sku: 'VPS-2C4G', name: 'Linux VPS M — 2 vCPU / 4 GB / 80 GB', cpuCores: 2, memoryMb: 4096, diskGb: 80, monthly: 54900n },
      { sku: 'VPS-4C8G', name: 'Linux VPS L — 4 vCPU / 8 GB / 160 GB', cpuCores: 4, memoryMb: 8192, diskGb: 160, monthly: 99900n },
    ];
    let [pl] = await c.db.select().from(priceLists).where(and(eq(priceLists.tenantId, tenant.id), eq(priceLists.name, 'Wholesale INR')));
    pl ??= await c.catalog.createPriceList(tenant.id, 'Wholesale INR', 'INR', true);
    for (const p of plans) {
      let [prod] = await c.db.select().from(products).where(and(eq(products.tenantId, tenant.id), eq(products.sku, p.sku)));
      prod ??= await c.catalog.createProduct({
        tenantId: tenant.id,
        sku: p.sku,
        name: p.name,
        type: 'VPS_LINUX',
        status: 'ACTIVE',
        cpuCores: p.cpuCores,
        memoryMb: p.memoryMb,
        diskGb: p.diskGb,
        bandwidthGb: 2000,
        ipv4Count: 1,
      });
      await c.catalog.upsertPlacement(tenant.id, prod.id, {
        locationId: loc.id,
        providerId: provider.id,
        node: 'mock-node-1',
        storage: 'local-lvm',
        bridge: 'vmbr0',
        vlanTag: 100,
        ipv4PoolId: poolId,
        templateIds: tpls.map((t) => t.id),
      });
      await c.catalog.setPrice(tenant.id, pl.id, prod.id, 'MONTHLY', p.monthly);
      await c.catalog.setPrice(tenant.id, pl.id, prod.id, 'ANNUAL', (p.monthly * 10n) as bigint);
    }

    const [existingReseller] = await c.db.select().from(resellers).where(and(eq(resellers.tenantId, tenant.id), eq(resellers.name, 'Demo Hosting Co')));
    if (!existingReseller) {
      const password = process.env.SEED_RESELLER_PASSWORD ?? randomBytes(12).toString('base64url');
      const { reseller } = await c.resellers.create({
        tenantId: tenant.id,
        name: 'Demo Hosting Co',
        contactEmail: 'billing@demohosting.example',
        model: 'PREPAID',
        currency: 'INR',
        admin: { email: 'reseller@demohosting.example', name: 'Demo Reseller', password },
        actor: ADMIN,
      });
      const d = await c.deposits.submitBankTransfer({
        tenantId: tenant.id,
        resellerId: reseller.id,
        amountMinor: 1_000_000n,
        bankReference: 'DEMOSEED0001',
        note: 'Seed deposit',
        source: 'PORTAL',
        actor: ADMIN,
      });
      await c.deposits.approve({ tenantId: tenant.id, depositId: d.id, actor: ADMIN });
      console.log(`Created demo reseller login reseller@demohosting.example${process.env.SEED_RESELLER_PASSWORD ? '' : ` / ${password}`} with ₹10,000 approved balance`);
    }
    console.log('Demo data ready (mock hypervisor — no real VMs are created).');
  } finally {
    await c.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
