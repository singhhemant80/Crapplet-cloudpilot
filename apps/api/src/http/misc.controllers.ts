import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Container } from '../container';
import { DomainError } from '../common/errors';
import { actorOf, type Principal } from '../modules/auth/auth.service';
import { Authenticated, CustomerApi, InjectContainer, Me, parse, Public, uuid, type AuthedRequest } from './common';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@InjectContainer() private readonly c: Container) {}

  @Get('health')
  @Public()
  health() {
    return { status: 'ok' };
  }

  /** Readiness: database and Redis reachable, migrations applied. */
  @Get('ready')
  @Public()
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, string> = {};
    try {
      await this.c.db.execute(sql`select 1 from ledger_accounts limit 1`);
      checks.database = 'ok';
    } catch (e) {
      checks.database = 'error';
    }
    try {
      checks.redis = (await this.c.redis.ping()) === 'PONG' ? 'ok' : 'error';
    } catch {
      checks.redis = 'error';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ready' : 'degraded', checks };
  }
}

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(@InjectContainer() private readonly c: Container) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  async login(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(256), tenant: z.string().default('default') }), body);
    // Per-identity throttle on top of the per-IP public limit.
    const key = `rl:login:${b.tenant}:${b.email.toLowerCase()}:${Math.floor(Date.now() / 60_000)}`;
    const n = await this.c.redis.incr(key);
    if (n === 1) await this.c.redis.expire(key, 61);
    if (n > 10) throw new DomainError('rate_limited', 'Too many login attempts', 429);
    return this.c.auth.login({ tenantSlug: b.tenant, email: b.email, password: b.password, ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  refresh(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ refreshToken: z.string().min(20) }), body);
    return this.c.auth.refresh(b.refreshToken, req.ip, req.headers['user-agent']);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiBearerAuth()
  @Authenticated()
  async logout(@Me() me: Principal) {
    if (me.sessionId) await this.c.auth.logout(me.sessionId);
    return { ok: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @Authenticated()
  async me(@Me() me: Principal) {
    const tenant = await this.c.db.execute(sql`select name, brand_name from tenants where id = ${me.tenantId}`);
    return {
      kind: me.kind,
      userId: me.userId,
      role: me.role,
      resellerId: me.resellerId,
      customerId: me.customerId,
      tenant: { id: me.tenantId, name: tenant.rows[0]?.name, brandName: tenant.rows[0]?.brand_name },
    };
  }
}

@ApiTags('customer')
@ApiBearerAuth()
@Controller('v1/customer')
export class CustomerController {
  constructor(@InjectContainer() private readonly c: Container) {}

  @Get('services')
  @CustomerApi()
  services(@Me() me: Principal) {
    return this.c.serviceOps.list(me.tenantId, { customerId: me.customerId });
  }

  @Get('services/:id')
  @CustomerApi()
  service(@Me() me: Principal, @Param('id') id: string) {
    return this.c.serviceOps.details(me.tenantId, parse(uuid, id), { customerId: me.customerId });
  }

  @Get('services/:id/status')
  @CustomerApi()
  status(@Me() me: Principal, @Param('id') id: string) {
    return this.c.serviceOps.liveStatus(me.tenantId, parse(uuid, id), { customerId: me.customerId });
  }

  @Get('services/:id/metrics')
  @CustomerApi()
  metrics(@Me() me: Principal, @Param('id') id: string) {
    return this.c.serviceOps.metrics(me.tenantId, parse(uuid, id), { customerId: me.customerId }, 'hour');
  }

  /** Customers may only power-cycle; suspension and termination are billing decisions. */
  @Post('services/:id/actions/:action')
  @HttpCode(200)
  @CustomerApi()
  async action(@Me() me: Principal, @Param('id') id: string, @Param('action') action: string) {
    const svc = await this.c.serviceOps.get(me.tenantId, parse(uuid, id), { customerId: me.customerId });
    const a = parse(z.enum(['start', 'stop', 'shutdown', 'reboot']), action);
    const out = await this.c.queue.runServiceOperation({ serviceId: svc.id, action: a, actor: actorOf(me) }, `${svc.id}-${a}-${Date.now()}`, 25_000);
    if (out.error) throw new DomainError(out.error.code, out.error.message, 409);
    return out;
  }
}

/**
 * Payment gateway callbacks. Public, but every request is authenticated by the
 * gateway's signature over the raw request body.
 */
@ApiTags('payments')
@Controller('v1/payments')
export class PaymentsController {
  constructor(@InjectContainer() private readonly c: Container) {}

  @Post('webhooks/:gateway')
  @HttpCode(200)
  @Public()
  async webhook(@Param('gateway') gateway: string, @Req() req: AuthedRequest) {
    if (!req.rawBody) throw new DomainError('invalid_request', 'Missing body', 400);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    return this.c.deposits.handleGatewayWebhook(gateway, req.rawBody.toString('utf8'), headers);
  }

  // ── Sandbox gateway (development/staging only): a fake hosted checkout page.

  private sandbox() {
    if (!this.c.sandboxGateway) throw new DomainError('not_found', 'Sandbox gateway is disabled', 404);
    return this.c.sandboxGateway;
  }

  /** A sandbox checkout pays either a wallet top-up (deposit) or an invoice (payment). */
  private async checkout(orderId: string) {
    const d = await this.c.deposits.findByGatewayOrder('sandbox', orderId);
    if (d) return { label: 'Wallet top-up', amountMinor: d.amountMinor, currency: d.currency, status: d.status, open: d.status === 'AWAITING_PAYMENT' };
    const p = await this.c.billing.findPaymentByGatewayOrder('sandbox', orderId);
    if (p) return { label: 'Invoice payment', amountMinor: p.amountMinor, currency: p.currency, status: p.status, open: p.status === 'PENDING' };
    throw new DomainError('not_found', 'Unknown checkout', 404);
  }

  @Get('sandbox/checkout/:orderId')
  @Public()
  async checkoutPage(@Param('orderId') orderId: string, @Res() res: Response) {
    this.sandbox();
    const d = await this.checkout(orderId);
    const amount = (Number(d.amountMinor) / 100).toFixed(2);
    const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox checkout</title><style>body{font:15px system-ui;max-width:420px;margin:60px auto;padding:0 16px;color:#111}
.b{border:1px solid #ddd;border-radius:10px;padding:24px}button{font:inherit;padding:10px 16px;border-radius:8px;border:0;margin-right:8px;cursor:pointer}
.ok{background:#0a7d4f;color:#fff}.no{background:#eee}.tag{background:#fff4d6;color:#7a5200;padding:2px 8px;border-radius:99px;font-size:12px}</style></head>
<body><div class="b"><span class="tag">SANDBOX — no real money</span><h2>${esc(d.label)}</h2>
<p>Amount: <b>${esc(d.currency)} ${esc(amount)}</b><br>Reference: <code>${esc(orderId)}</code><br>Status: ${esc(d.status)}</p>
${d.open ? `<form method="post" action="/v1/payments/sandbox/checkout/${esc(orderId)}/complete">
<button class="ok" name="outcome" value="captured">Simulate successful payment</button>
<button class="no" name="outcome" value="failed">Simulate failure</button></form>` : '<p>This checkout is closed.</p>'}
</div></body></html>`);
  }

  /** Emits a correctly signed sandbox webhook through the same verified handler a real gateway uses. */
  @Post('sandbox/checkout/:orderId/complete')
  @Public()
  async completeSandbox(@Param('orderId') orderId: string, @Body() body: Record<string, string>, @Res() res: Response) {
    const gw = this.sandbox();
    const d = await this.checkout(orderId);
    const raw = JSON.stringify({
      id: `evt_sbx_${orderId}_${body?.outcome === 'failed' ? 'f' : 'c'}`,
      type: body?.outcome === 'failed' ? 'payment.failed' : 'payment.captured',
      data: { orderId, paymentId: `sbx_pay_${orderId}`, amountMinor: d.amountMinor.toString(), currency: d.currency },
    });
    const result = await this.c.deposits.handleGatewayWebhook('sandbox', raw, { 'x-sandbox-signature': gw.sign(raw) });
    res.type('html').send(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;max-width:420px;margin:60px auto">
<h3>Sandbox result: ${result.status}</h3><p>You can close this window.</p></body>`);
  }
}
