import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvents, locations } from '../db/schema';
import type { Container } from '../container';
import { DomainError } from '../common/errors';
import { actorOf, type Principal } from '../modules/auth/auth.service';
import { publicProvider } from '../modules/hypervisors/hypervisor.service';
import { Admin, currency, cycle, InjectContainer, Me, minorUnits, parse, uuid } from './common';

const opName = z.enum(['start', 'stop', 'shutdown', 'reboot', 'suspend', 'unsuspend', 'terminate']);

@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin')
export class AdminController {
  constructor(@InjectContainer() private readonly c: Container) {}

  // ───────────────────────── overview

  @Get('overview')
  @Admin()
  async overview(@Me() me: Principal) {
    const t = me.tenantId;
    const q = async (s: ReturnType<typeof sql>) => (await this.c.db.execute(s)).rows;
    const [orders, servicesByStatus, deposits, providers, ipStats] = await Promise.all([
      q(sql`select status, count(*)::int as n from orders where tenant_id = ${t} group by status`),
      q(sql`select status, count(*)::int as n from services where tenant_id = ${t} group by status`),
      q(sql`select count(*)::int as n from deposits where tenant_id = ${t} and status = 'UNDER_REVIEW'`),
      q(sql`select status, count(*)::int as n from hypervisor_providers where tenant_id = ${t} group by status`),
      q(sql`select status, count(*)::int as n from ip_addresses where tenant_id = ${t} group by status`),
    ]);
    const revenue = await q(sql`select a.currency, a.balance_minor::text as captured_minor from ledger_accounts a
      where a.tenant_id = ${t} and a.kind = 'SYSTEM_REVENUE'`);
    const recentOrders = await this.c.orders.list(t, { limit: 10 });
    return { orders, services: servicesByStatus, pendingDeposits: deposits[0]?.n ?? 0, providers, ip: ipStats, revenue, recentOrders };
  }

  // ───────────────────────── locations

  @Get('locations')
  @Admin()
  listLocations(@Me() me: Principal) {
    return this.c.db.select().from(locations).where(eq(locations.tenantId, me.tenantId));
  }

  @Post('locations')
  @Admin('catalog:write')
  async createLocation(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ code: z.string().regex(/^[A-Z0-9-]{2,20}$/), name: z.string().min(2), country: z.string().length(2) }), body);
    const [row] = await this.c.db.insert(locations).values({ tenantId: me.tenantId, ...b, country: b.country.toUpperCase() }).returning();
    return row;
  }

  // ───────────────────────── hypervisors

  @Get('hypervisors')
  @Admin()
  async listProviders(@Me() me: Principal) {
    return (await this.c.hypervisors.list(me.tenantId)).map(publicProvider);
  }

  @Post('hypervisors')
  @Admin('infra:write')
  async createProvider(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({
        locationId: uuid,
        name: z.string().min(2).max(60),
        type: z.enum(['proxmox', 'mock']),
        endpoint: z.string().url(),
        credentials: z.record(z.string()),
        caCertificate: z.string().optional(),
        allowInsecureTls: z.boolean().optional(),
        options: z.record(z.unknown()).optional(),
      }),
      body,
    );
    const row = await this.c.hypervisors.create({ tenantId: me.tenantId, ...b });
    return publicProvider(row);
  }

  @Post('hypervisors/:id/test')
  @HttpCode(200)
  @Admin('infra:write')
  test(@Me() me: Principal, @Param('id') id: string) {
    return this.c.hypervisors.testConnection(me.tenantId, parse(uuid, id));
  }

  @Post('hypervisors/:id/discover')
  @HttpCode(200)
  @Admin('infra:write')
  discover(@Me() me: Principal, @Param('id') id: string) {
    return this.c.hypervisors.discover(me.tenantId, parse(uuid, id));
  }

  @Get('hypervisors/:id/inventory')
  @Admin()
  inventory(@Me() me: Principal, @Param('id') id: string) {
    return this.c.hypervisors.inventory(me.tenantId, parse(uuid, id));
  }

  // ───────────────────────── IPAM

  @Get('ip-pools')
  @Admin()
  pools(@Me() me: Principal) {
    return this.c.ipam.listPools(me.tenantId);
  }

  @Post('ip-pools')
  @Admin('infra:write')
  createPool(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({
        locationId: uuid,
        name: z.string().min(2),
        cidr: z.string(),
        gateway: z.string().optional(),
        nameservers: z.array(z.string().ip()).max(4).optional(),
        vlanTag: z.number().int().min(1).max(4094).optional(),
        rangeStart: z.string().ip().optional(),
        rangeEnd: z.string().ip().optional(),
        exclude: z.array(z.string().ip()).optional(),
        customerSelectable: z.boolean().optional(),
        quarantineHours: z.number().int().min(0).max(24 * 90).optional(),
      }),
      body,
    );
    return this.c.ipam.createPool({ tenantId: me.tenantId, ...b });
  }

  @Get('ip-pools/:id/addresses')
  @Admin()
  addresses(@Me() me: Principal, @Param('id') id: string, @Query('status') status?: string) {
    return this.c.ipam.listAddresses(me.tenantId, parse(uuid, id), status, 1024);
  }

  @Get('ip-addresses/:address/history')
  @Admin()
  async ipHistory(@Me() me: Principal, @Param('address') address: string) {
    return (await this.c.ipam.history(me.tenantId, address)).rows;
  }

  // ───────────────────────── catalog

  @Get('products')
  @Admin()
  products(@Me() me: Principal) {
    return this.c.catalog.listProducts(me.tenantId);
  }

  @Post('products')
  @Admin('catalog:write')
  createProduct(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({
        sku: z.string().regex(/^[A-Z0-9-]{2,40}$/),
        name: z.string().min(2),
        type: z.enum(['VPS_LINUX', 'VPS_WINDOWS', 'VPS_FOREX', 'VPS_MINECRAFT', 'GPU_CLOUD']),
        description: z.string().max(4000).optional(),
        status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']).optional(),
        provisioning: z.enum(['AUTOMATIC', 'MANUAL_APPROVAL']).optional(),
        cpuCores: z.number().int().min(1).max(256),
        memoryMb: z.number().int().min(256).max(4 * 1024 * 1024),
        diskGb: z.number().int().min(5).max(100_000),
        bandwidthGb: z.number().int().min(0).optional(),
        ipv4Count: z.number().int().min(0).max(1).optional(),
        ipv6Count: z.number().int().min(0).max(1).optional(),
      }),
      body,
    );
    return this.c.catalog.createProduct({ tenantId: me.tenantId, ...b });
  }

  @Patch('products/:id')
  @Admin('catalog:write')
  updateProduct(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(
      z.object({ name: z.string().min(2).optional(), description: z.string().optional(), status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']).optional() }),
      body,
    );
    return this.c.catalog.updateProduct(me.tenantId, parse(uuid, id), b);
  }

  @Put('products/:id/placements')
  @Admin('catalog:write')
  placement(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(
      z.object({
        locationId: uuid,
        providerId: uuid,
        node: z.string().min(1),
        storage: z.string().optional(),
        bridge: z.string().regex(/^[\w.-]+$/).optional(),
        vlanTag: z.number().int().min(1).max(4094).optional(),
        ipv4PoolId: uuid.optional(),
        ipv6PoolId: uuid.optional(),
        templateIds: z.array(uuid).min(1),
        enabled: z.boolean().optional(),
      }),
      body,
    );
    return this.c.catalog.upsertPlacement(me.tenantId, parse(uuid, id), b);
  }

  @Get('price-lists')
  @Admin()
  priceLists(@Me() me: Principal) {
    return this.c.catalog.listPriceLists(me.tenantId);
  }

  @Post('price-lists')
  @Admin('catalog:write')
  createPriceList(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(2), currency, isDefaultWholesale: z.boolean().optional() }), body);
    return this.c.catalog.createPriceList(me.tenantId, b.name, b.currency, b.isDefaultWholesale);
  }

  @Put('price-lists/:id/prices')
  @Admin('catalog:write')
  setPrice(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ productId: uuid, cycle, amountMinor: minorUnits, setupFeeMinor: minorUnits.optional() }), body);
    return this.c.catalog.setPrice(me.tenantId, parse(uuid, id), b.productId, b.cycle, b.amountMinor, b.setupFeeMinor);
  }

  // ───────────────────────── resellers & wallet

  @Get('resellers')
  @Admin()
  resellers(@Me() me: Principal) {
    return this.c.resellers.list(me.tenantId);
  }

  @Post('resellers')
  @Admin('resellers:write')
  createReseller(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({
        name: z.string().min(2),
        contactEmail: z.string().email(),
        model: z.enum(['PREPAID', 'CREDIT', 'COMMISSION']),
        currency,
        creditLimitMinor: minorUnits.optional(),
        priceListId: uuid.optional(),
        admin: z.object({ email: z.string().email(), name: z.string().min(2), password: z.string().min(12) }).optional(),
      }),
      body,
    );
    return this.c.resellers.create({ tenantId: me.tenantId, ...b, actor: actorOf(me) });
  }

  @Patch('resellers/:id')
  @Admin('resellers:write')
  updateReseller(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(
      z.object({
        name: z.string().min(2).optional(),
        status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']).optional(),
        creditLimitMinor: minorUnits.optional(),
        priceListId: uuid.nullable().optional(),
        lowBalanceThresholdMinor: minorUnits.optional(),
      }),
      body,
    );
    return this.c.resellers.update(me.tenantId, parse(uuid, id), b, actorOf(me));
  }

  @Get('resellers/:id/statement')
  @Admin()
  statement(@Me() me: Principal, @Param('id') id: string) {
    return this.c.resellers.statement(me.tenantId, parse(uuid, id));
  }

  @Post('resellers/:id/adjustments')
  @Admin('ledger:adjust')
  async adjust(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(
      z.object({
        amountMinor: z.union([z.string().regex(/^-?\d{1,15}$/), z.number().int()]).transform((v) => BigInt(v)),
        memo: z.string().min(3).max(500),
        idempotencyKey: z.string().min(8).max(100),
      }),
      body,
    );
    const r = await this.c.resellers.get(me.tenantId, parse(uuid, id));
    const res = await this.c.db.transaction((tx) =>
      this.c.ledger.adjust(tx, { tenantId: me.tenantId, resellerId: r.id, amount: b.amountMinor, currency: r.currency, idempotencyKey: `admin-adj:${b.idempotencyKey}`, actor: actorOf(me), memo: b.memo }),
    );
    return { transactionId: res.transaction.id, created: res.created };
  }

  @Get('deposits')
  @Admin()
  async deposits(@Me() me: Principal, @Query('status') status?: string) {
    return this.c.deposits.list(me.tenantId, { status });
  }

  @Post('deposits/:id/approve')
  @HttpCode(200)
  @Admin('deposits:review')
  async approveDeposit(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ receivedAmountMinor: minorUnits.optional() }), body ?? {});
    await this.c.deposits.approve({ tenantId: me.tenantId, depositId: parse(uuid, id), receivedAmountMinor: b.receivedAmountMinor, actor: actorOf(me) });
    return { ok: true };
  }

  @Post('deposits/:id/reject')
  @HttpCode(200)
  @Admin('deposits:review')
  async rejectDeposit(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.string().min(3).max(500) }), body);
    await this.c.deposits.reject({ tenantId: me.tenantId, depositId: parse(uuid, id), reason: b.reason, actor: actorOf(me) });
    return { ok: true };
  }

  @Get('ledger/reconcile')
  @Admin()
  reconcile(@Me() me: Principal) {
    return this.c.ledger.reconcile(me.tenantId);
  }

  // ───────────────────────── orders & services

  @Get('orders')
  @Admin()
  orders(@Me() me: Principal, @Query('status') status?: string, @Query('resellerId') resellerId?: string) {
    return this.c.orders.list(me.tenantId, { status: status ? status.split(',') : undefined, resellerId });
  }

  @Get('orders/:id')
  @Admin()
  order(@Me() me: Principal, @Param('id') id: string) {
    return this.c.orders.get(me.tenantId, parse(uuid, id));
  }

  @Post('orders/:id/approve')
  @HttpCode(200)
  @Admin('orders:manage')
  async approveOrder(@Me() me: Principal, @Param('id') id: string) {
    await this.c.orders.approve(me.tenantId, parse(uuid, id), actorOf(me));
    return { ok: true };
  }

  @Post('orders/:id/retry')
  @HttpCode(200)
  @Admin('orders:manage')
  async retryOrder(@Me() me: Principal, @Param('id') id: string) {
    await this.c.orders.retry(me.tenantId, parse(uuid, id), actorOf(me));
    return { ok: true };
  }

  @Get('services')
  @Admin()
  services(@Me() me: Principal, @Query('status') status?: string) {
    return this.c.serviceOps.list(me.tenantId, { status: status ? status.split(',') : undefined });
  }

  @Get('services/:id')
  @Admin()
  service(@Me() me: Principal, @Param('id') id: string) {
    return this.c.serviceOps.details(me.tenantId, parse(uuid, id));
  }

  @Get('services/:id/status')
  @Admin()
  serviceStatus(@Me() me: Principal, @Param('id') id: string) {
    return this.c.serviceOps.liveStatus(me.tenantId, parse(uuid, id), {});
  }

  @Get('services/:id/metrics')
  @Admin()
  serviceMetrics(@Me() me: Principal, @Param('id') id: string) {
    return this.c.serviceOps.metrics(me.tenantId, parse(uuid, id), {}, 'hour');
  }

  @Post('services/:id/actions/:action')
  @HttpCode(200)
  @Admin('services:manage')
  async serviceAction(@Me() me: Principal, @Param('id') id: string, @Param('action') action: string, @Body() body: unknown) {
    const svc = await this.c.serviceOps.get(me.tenantId, parse(uuid, id));
    const act = parse(opName, action);
    const b = parse(z.object({ reason: z.string().max(500).optional(), confirm: z.literal(svc.hostname).optional() }), body ?? {});
    if (act === 'terminate' && !b.confirm) {
      throw new DomainError('confirmation_required', `Send {"confirm":"${svc.hostname}"} to terminate`, 422);
    }
    const out = await this.c.queue.runServiceOperation({ serviceId: svc.id, action: act, reason: b.reason, actor: actorOf(me) }, `${svc.id}-${act}-${Date.now()}`, 25_000);
    if (out.error) throw new DomainError(out.error.code, out.error.message, out.error.code === 'provider_error' ? 502 : 409);
    return out;
  }

  @Get('audit')
  @Admin()
  audit(@Me() me: Principal, @Query('resellerId') resellerId?: string) {
    const where = [eq(auditEvents.tenantId, me.tenantId)];
    if (resellerId) where.push(eq(auditEvents.resellerId, parse(uuid, resellerId)));
    return this.c.db.select().from(auditEvents).where(and(...where)).orderBy(desc(auditEvents.createdAt)).limit(200);
  }
}
