import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { integrationConnections } from '../db/schema';
import type { Container } from '../container';
import { DomainError } from '../common/errors';
import { actorOf, API_SCOPES, type Principal } from '../modules/auth/auth.service';
import { WEBHOOK_EVENT_TYPES } from '../modules/webhooks/webhook.service';
import { cycle, InjectContainer, Me, minorUnits, parse, ResellerApi, uuid } from './common';

const action = z.enum(['start', 'stop', 'shutdown', 'reboot', 'suspend', 'unsuspend', 'terminate']);

/**
 * Universal reseller API (v1). Used by the reseller portal (JWT) and by external
 * billing systems — WHMCS, Blesta, custom sites — with scoped API keys.
 * Every query is filtered by the caller's resellerId; ids from other resellers return 404.
 */
@ApiTags('reseller')
@ApiBearerAuth()
@Controller('v1/reseller')
export class ResellerController {
  constructor(@InjectContainer() private readonly c: Container) {}

  private rid(me: Principal) {
    return me.resellerId!;
  }

  @Get('me')
  @ResellerApi()
  async me(@Me() me: Principal) {
    const r = await this.c.resellers.get(me.tenantId, this.rid(me));
    const balances = await this.c.ledger.balances(this.c.db, me.tenantId, r.id, r.currency);
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      model: r.model,
      currency: r.currency,
      balances,
      lowBalance: balances.availableMinor < r.lowBalanceThresholdMinor,
      paymentGateways: this.c.deposits.availableGateways(),
      principal: { kind: me.kind, scopes: [...me.scopes] },
    };
  }

  // ───────────────────────── catalog

  @Get('products')
  @ResellerApi('products:read')
  products(@Me() me: Principal) {
    return this.c.catalog.resellerCatalog(me.tenantId, this.rid(me));
  }

  @Get('pricing/quote')
  @ResellerApi('products:read')
  async quote(@Me() me: Principal, @Query('sku') sku: string, @Query('cycle') cyc: string) {
    const product = await this.c.catalog.getProductBySku(me.tenantId, sku);
    const p = await this.c.catalog.resolveWholesale(this.c.db, me.tenantId, this.rid(me), product.id, parse(cycle, cyc));
    return { sku, cycle: cyc, currency: p.currency, amountMinor: p.amountMinor, setupFeeMinor: p.setupFeeMinor };
  }

  // ───────────────────────── wallet

  @Get('wallet')
  @ResellerApi('wallet:read')
  async wallet(@Me() me: Principal) {
    const r = await this.c.resellers.get(me.tenantId, this.rid(me));
    return this.c.ledger.balances(this.c.db, me.tenantId, r.id, r.currency);
  }

  @Get('wallet/ledger')
  @ResellerApi('wallet:read')
  ledger(@Me() me: Principal, @Query('limit') limit?: string) {
    return this.c.resellers.statement(me.tenantId, this.rid(me), Number(limit) || 200);
  }

  @Get('wallet/ledger.csv')
  @ResellerApi('wallet:read')
  async ledgerCsv(@Me() me: Principal, @Res() res: Response) {
    const rows = await this.c.resellers.statement(me.tenantId, this.rid(me), 1000);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      'created_at,transaction_id,type,account,amount_minor,balance_after_minor,currency,memo,source',
      ...rows.map((r) => [r.createdAt.toISOString(), r.transactionId, r.type, r.account, r.amountMinor, r.balanceAfterMinor, r.currency, r.memo, `${r.sourceType}:${r.sourceId}`].map(esc).join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="wallet-statement.csv"');
    res.send(lines.join('\n'));
  }

  @Get('wallet/deposits')
  @ResellerApi('wallet:read')
  async deposits(@Me() me: Principal) {
    return (await this.c.deposits.list(me.tenantId, { resellerId: this.rid(me) })).map((d) => d.deposit);
  }

  @Get('wallet/deposits/:id')
  @ResellerApi('wallet:read')
  deposit(@Me() me: Principal, @Param('id') id: string) {
    return this.c.deposits.getForReseller(me.tenantId, this.rid(me), parse(uuid, id));
  }

  /** Online top-up: returns a checkout. Funds are credited only by the verified gateway webhook. */
  @Post('wallet/topups')
  @ResellerApi('wallet:write')
  async topup(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ gateway: z.string(), amountMinor: minorUnits, externalRef: z.string().max(120).optional() }), body);
    const res = await this.c.deposits.createGatewayTopup({
      tenantId: me.tenantId,
      resellerId: this.rid(me),
      gateway: b.gateway,
      amountMinor: b.amountMinor,
      externalRef: b.externalRef,
      source: me.kind === 'api_key' ? 'API' : 'PORTAL',
      actor: actorOf(me),
    });
    return { deposit: res.deposit, checkout: 'checkout' in res ? res.checkout : undefined, replayed: res.replayed };
  }

  /** Bank transfer notice: goes to admin review; never credits on its own. */
  @Post('wallet/bank-transfers')
  @ResellerApi('wallet:write')
  bankTransfer(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ amountMinor: minorUnits, bankReference: z.string(), note: z.string().max(1000).optional(), externalRef: z.string().max(120).optional() }), body);
    return this.c.deposits.submitBankTransfer({
      tenantId: me.tenantId,
      resellerId: this.rid(me),
      ...b,
      source: me.kind === 'api_key' ? 'API' : 'PORTAL',
      actor: actorOf(me),
    });
  }

  // ───────────────────────── IPAM

  @Get('ipam/pools/:poolId/available')
  @ResellerApi('ipam:read')
  available(@Me() me: Principal, @Param('poolId') poolId: string, @Query('limit') limit?: string) {
    return this.c.ipam.listSelectable(me.tenantId, parse(uuid, poolId), Number(limit) || 50);
  }

  /** Checkout-time hold on a chosen IP (expires unless an order binds it via ipReservationToken). */
  @Post('ipam/reservations')
  @ResellerApi('ipam:write')
  async reserveIp(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ poolId: uuid, address: z.string().ip().optional() }), body);
    const pools = await this.c.ipam.listPools(me.tenantId);
    const pool = pools.find((p) => p.id === b.poolId);
    if (!pool?.customer_selectable) throw new DomainError('ip_selection_disabled', 'This pool does not allow IP selection', 403);
    // Bound outstanding checkout reservations per reseller to stop pool hoarding.
    const open = await this.c.db.execute(sql`select count(*)::int as n from ip_addresses where reserved_by_reseller_id = ${this.rid(me)}
      and status = 'RESERVED' and order_id is null and reserved_until > now()`);
    if ((open.rows[0].n as number) >= 20) throw new DomainError('too_many_reservations', 'Too many open IP reservations', 429);
    return this.c.ipam.reserve(this.c.db, {
      tenantId: me.tenantId,
      poolId: b.poolId,
      address: b.address,
      resellerId: this.rid(me),
      ttlMinutes: this.c.env.IP_RESERVATION_MINUTES,
      reason: 'checkout reservation',
    });
  }

  @Delete('ipam/reservations/:token')
  @ResellerApi('ipam:write')
  async releaseIp(@Me() me: Principal, @Param('token') token: string) {
    return { released: await this.c.ipam.cancelReservation({ tenantId: me.tenantId, token, resellerId: this.rid(me) }) };
  }

  // ───────────────────────── orders

  @Post('orders')
  @ResellerApi('orders:write')
  async createOrder(@Me() me: Principal, @Body() body: unknown, @Headers('idempotency-key') headerKey: string | undefined, @Res({ passthrough: true }) res: Response) {
    const b = parse(
      z.object({
        idempotencyKey: z.string().min(1).max(200).optional(),
        productSku: z.string(),
        locationCode: z.string(),
        templateId: uuid,
        cycle,
        hostname: z.string(),
        ipv4Address: z.string().ip({ version: 'v4' }).optional(),
        ipReservationToken: z.string().optional(),
        customer: z.object({ externalRef: z.string().max(120), name: z.string().max(200), email: z.string().email().optional() }).optional(),
        retail: z.object({ amountMinor: minorUnits, currency: z.string().length(3) }).optional(),
        password: z.string().optional(),
        sshKeys: z.array(z.string().max(16_000)).max(10).optional(),
        source: z.enum(['API', 'WHMCS']).optional(),
      }),
      body,
    );
    const key = headerKey ?? b.idempotencyKey;
    if (!key) throw new DomainError('idempotency_key_required', 'Send an Idempotency-Key header or idempotencyKey field', 422);
    const { order, replayed } = await this.c.orders.createResellerOrder({
      ...b,
      idempotencyKey: key,
      tenantId: me.tenantId,
      resellerId: this.rid(me),
      actor: actorOf(me),
      source: me.kind === 'api_key' ? (b.source ?? 'API') : 'PORTAL',
    });
    res.status(replayed ? 200 : 201);
    return { ...(await this.c.orders.get(me.tenantId, order.id, this.rid(me))), replayed };
  }

  @Get('orders')
  @ResellerApi('orders:read')
  orders(@Me() me: Principal, @Query('status') status?: string) {
    return this.c.orders.list(me.tenantId, { resellerId: this.rid(me), status: status ? status.split(',') : undefined });
  }

  @Get('orders/by-key/:key')
  @ResellerApi('orders:read')
  orderByKey(@Me() me: Principal, @Param('key') key: string) {
    return this.c.orders.getByKey(me.tenantId, this.rid(me), key);
  }

  @Get('orders/:id')
  @ResellerApi('orders:read')
  order(@Me() me: Principal, @Param('id') id: string) {
    return this.c.orders.get(me.tenantId, parse(uuid, id), this.rid(me));
  }

  // ───────────────────────── services

  @Get('services')
  @ResellerApi('services:read')
  services(@Me() me: Principal, @Query('status') status?: string) {
    return this.c.serviceOps.list(me.tenantId, { resellerId: this.rid(me), status: status ? status.split(',') : undefined });
  }

  @Get('services/:id')
  @ResellerApi('services:read')
  service(@Me() me: Principal, @Param('id') id: string) {
    return this.c.serviceOps.details(me.tenantId, parse(uuid, id), { resellerId: this.rid(me) });
  }

  @Get('services/:id/status')
  @ResellerApi('services:read')
  serviceStatus(@Me() me: Principal, @Param('id') id: string) {
    return this.c.serviceOps.liveStatus(me.tenantId, parse(uuid, id), { resellerId: this.rid(me) });
  }

  @Get('services/:id/metrics')
  @ResellerApi('services:read')
  metrics(@Me() me: Principal, @Param('id') id: string, @Query('timeframe') tf = 'hour') {
    return this.c.serviceOps.metrics(me.tenantId, parse(uuid, id), { resellerId: this.rid(me) }, parse(z.enum(['hour', 'day', 'week']), tf));
  }

  /**
   * Lifecycle actions run in the worker. Waits up to 25s; otherwise 202 with an operationId.
   * Send an Idempotency-Key header to make client retries collapse into one operation.
   */
  @Post('services/:id/actions/:action')
  @ResellerApi('services:write')
  async serviceAction(
    @Me() me: Principal,
    @Param('id') id: string,
    @Param('action') act: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const svc = await this.c.serviceOps.get(me.tenantId, parse(uuid, id), { resellerId: this.rid(me) });
    const a = parse(action, act);
    const b = parse(z.object({ reason: z.string().max(500).optional() }), body ?? {});
    const opKey = `${svc.id}-${a}-${(key ?? `${Date.now()}`).replace(/[^\w-]/g, '').slice(0, 80)}`;
    const out = await this.c.queue.runServiceOperation({ serviceId: svc.id, action: a, reason: b.reason, actor: actorOf(me) }, opKey, 25_000);
    if (out.error) throw new DomainError(out.error.code, out.error.message, out.error.code === 'provider_error' ? 502 : 409);
    res.status(out.done ? 200 : 202);
    return out;
  }

  @Post('services/:id/renew')
  @HttpCode(200)
  @ResellerApi('services:write')
  async renew(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') headerKey?: string) {
    const b = parse(z.object({ idempotencyKey: z.string().min(1).max(200).optional() }), body ?? {});
    const key = headerKey ?? b.idempotencyKey;
    if (!key) throw new DomainError('idempotency_key_required', 'Renewals need an idempotency key (e.g. invoice id)', 422);
    return this.c.serviceOps.renew(me.tenantId, parse(uuid, id), this.rid(me), key, actorOf(me));
  }

  // ───────────────────────── reports

  @Get('reports/margins')
  @ResellerApi('orders:read')
  margins(@Me() me: Principal) {
    return this.c.resellers.margins(me.tenantId, this.rid(me));
  }

  // ───────────────────────── API keys, integrations, webhooks (interactive users only)

  @Get('api-keys')
  @ResellerApi(undefined, { usersOnly: true })
  apiKeys(@Me() me: Principal) {
    return this.c.auth.listApiKeys(this.rid(me));
  }

  @Post('api-keys')
  @ResellerApi(undefined, { usersOnly: true })
  createApiKey(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({
        name: z.string().min(2).max(80),
        scopes: z.array(z.enum(API_SCOPES)).min(1),
        ipAllowlist: z.array(z.string()).max(50).optional(),
        expiresAt: z.coerce.date().optional(),
      }),
      body,
    );
    return this.c.auth.createApiKey({ tenantId: me.tenantId, resellerId: this.rid(me), ...b, actor: actorOf(me) });
  }

  @Delete('api-keys/:id')
  @ResellerApi(undefined, { usersOnly: true })
  async revokeApiKey(@Me() me: Principal, @Param('id') id: string) {
    await this.c.auth.revokeApiKey(me.tenantId, this.rid(me), parse(uuid, id), actorOf(me));
    return { revoked: true };
  }

  @Get('integrations')
  @ResellerApi()
  integrations(@Me() me: Principal) {
    return this.c.resellers.listConnections(this.rid(me));
  }

  @Post('integrations')
  @ResellerApi(undefined, { usersOnly: true })
  createIntegration(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({
        platform: z.enum(['WHMCS', 'BLESTA', 'HOSTBILL', 'WISECP', 'CLIENTEXEC', 'CUSTOM']),
        name: z.string().min(2).max(80),
        siteUrl: z.string().url().optional(),
        ipAllowlist: z.array(z.string()).max(50).optional(),
      }),
      body,
    );
    return this.c.resellers.createConnection({ tenantId: me.tenantId, resellerId: this.rid(me), ...b, actor: actorOf(me) });
  }

  /** Called by billing-system modules ("Test Connection" in WHMCS) to confirm credentials and record liveness. */
  @Post('integrations/heartbeat')
  @HttpCode(200)
  @ResellerApi()
  async heartbeat(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ platform: z.string().max(40).optional(), version: z.string().max(40).optional(), siteUrl: z.string().max(300).optional() }), body ?? {});
    if (b.siteUrl) {
      await this.c.db
        .update(integrationConnections)
        .set({ lastSeenAt: new Date() })
        .where(and(eq(integrationConnections.resellerId, this.rid(me)), eq(integrationConnections.siteUrl, b.siteUrl)));
    }
    const r = await this.c.resellers.get(me.tenantId, this.rid(me));
    return { ok: true, reseller: r.name, status: r.status, apiVersion: 'v1', serverTime: new Date().toISOString() };
  }

  @Get('webhooks')
  @ResellerApi('webhooks:manage')
  webhooks(@Me() me: Principal) {
    return this.c.webhooks.listEndpoints(this.rid(me));
  }

  @Post('webhooks')
  @ResellerApi('webhooks:manage')
  createWebhook(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ url: z.string().url(), events: z.array(z.enum(['*', ...WEBHOOK_EVENT_TYPES])).min(1) }), body);
    return this.c.webhooks.createEndpoint({ tenantId: me.tenantId, resellerId: this.rid(me), ...b });
  }

  @Delete('webhooks/:id')
  @ResellerApi('webhooks:manage')
  async deleteWebhook(@Me() me: Principal, @Param('id') id: string) {
    await this.c.webhooks.deleteEndpoint(this.rid(me), parse(uuid, id));
    return { deleted: true };
  }

  @Get('webhooks/deliveries')
  @ResellerApi('webhooks:manage')
  deliveries(@Me() me: Principal) {
    return this.c.webhooks.deliveryLog(this.rid(me));
  }

  @Post('webhooks/deliveries/:id/retry')
  @HttpCode(200)
  @ResellerApi('webhooks:manage')
  async redeliver(@Me() me: Principal, @Param('id') id: string) {
    await this.c.webhooks.resetForRetry(this.rid(me), parse(uuid, id));
    await this.c.queue.enqueueWebhookDelivery(id);
    return { queued: true };
  }
}
