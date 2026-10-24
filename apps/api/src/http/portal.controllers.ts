import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { customers, resellers, services, users } from '../db/schema';
import type { Container } from '../container';
import { DomainError } from '../common/errors';
import { actorOf, type Principal } from '../modules/auth/auth.service';
import { GSTIN_RE, STATE_CODES } from '../modules/settings/settings.service';
import type { TicketScope } from '../modules/support/support.service';
import { Admin, Authenticated, CustomerApi, cycle, InjectContainer, Me, minorUnits, parse, Public, ResellerApi, uuid } from './common';

const password = z.string().min(12, 'Use at least 12 characters').max(256);
const ticketStatus = z.enum(['OPEN', 'ANSWERED', 'CUSTOMER_REPLY', 'ON_HOLD', 'CLOSED']);
const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
const profileFields = {
  name: z.string().min(2).max(120),
  companyName: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  address1: z.string().max(200).optional(),
  address2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  stateCode: z.string().regex(/^\d{2}$/).optional().or(z.literal('')),
  country: z.string().regex(/^[A-Za-z]{2}$/).default('IN'),
  postalCode: z.string().max(20).optional(),
  gstin: z.string().regex(GSTIN_RE, 'Invalid GSTIN').optional().or(z.literal('')),
};

async function panelUrl(c: Container, tenantId: string) {
  const s = await c.settings.get(c.db, tenantId);
  return (s.company.panelUrl || c.env.WEB_ORIGIN.split(',')[0]).replace(/\/$/, '');
}

async function throttle(c: Container, key: string, limit: number, windowSec: number) {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = await c.redis.incr(k);
  if (n === 1) await c.redis.expire(k, windowSec + 1);
  if (n > limit) throw new DomainError('rate_limited', 'Too many requests, try again later', 429);
}

function checkGstin(gstin?: string, stateCode?: string) {
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) throw new DomainError('invalid_request', 'GSTIN does not match the selected state', 422);
}

// ═════════════════════════════════════════════ account (sign-up, password reset)

@ApiTags('auth')
@Controller('v1/auth')
export class AccountController {
  constructor(@InjectContainer() private readonly c: Container) {}

  @Get('states')
  @Public()
  states() {
    return Object.entries(STATE_CODES).map(([code, name]) => ({ code, name }));
  }

  /** Store sign-up. Responds identically whether or not the address is already registered. */
  @Post('register')
  @HttpCode(200)
  @Public()
  async register(@Body() body: unknown) {
    const b = parse(z.object({ ...profileFields, email: z.string().email().max(200), password, tenant: z.string().default('default') }), body);
    checkGstin(b.gstin, b.stateCode);
    await throttle(this.c, `register:${b.email.toLowerCase()}`, 5, 3600);
    const r = await this.c.auth.registerCustomer({ ...b, tenantSlug: b.tenant, stateCode: b.stateCode || undefined, gstin: b.gstin || undefined });
    const url = await panelUrl(this.c, r.tenantId);
    if (r.created) {
      await this.c.email.queue(this.c.db, { tenantId: r.tenantId, to: r.email, key: 'account.welcome', vars: { name: r.name, email: r.email }, related: { type: 'customer', id: r.customerId } });
    } else {
      // Existing account: tell the owner how to get back in instead of revealing it here.
      const t = await this.c.auth.createResetToken(this.c.redis, b.tenant, r.email);
      if (t) await this.c.email.queue(this.c.db, { tenantId: r.tenantId, to: r.email, key: 'auth.password_reset', vars: { name: t.user.name, resetUrl: `${url}/reset?token=${t.token}` } });
    }
    return { ok: true, message: 'Check your email. If this address is new, your account is ready and you can sign in.' };
  }

  @Post('forgot')
  @HttpCode(200)
  @Public()
  async forgot(@Body() body: unknown) {
    const b = parse(z.object({ email: z.string().email(), tenant: z.string().default('default') }), body);
    await throttle(this.c, `forgot:${b.email.toLowerCase()}`, 3, 900);
    const t = await this.c.auth.createResetToken(this.c.redis, b.tenant, b.email);
    if (t) {
      const url = await panelUrl(this.c, t.user.tenantId);
      await this.c.email.queue(this.c.db, { tenantId: t.user.tenantId, to: t.user.email, key: 'auth.password_reset', vars: { name: t.user.name, resetUrl: `${url}/reset?token=${t.token}` } });
    }
    return { ok: true, message: 'If that address has an account, a reset link is on its way.' };
  }

  @Post('reset')
  @HttpCode(200)
  @Public()
  async reset(@Body() body: unknown) {
    const b = parse(z.object({ token: z.string().min(20).max(200), password }), body);
    await this.c.auth.resetPassword(this.c.redis, b.token, b.password);
    return { ok: true };
  }

  @Post('password')
  @HttpCode(200)
  @ApiBearerAuth()
  @Authenticated()
  async changePassword(@Me() me: Principal, @Body() body: unknown) {
    if (me.kind !== 'user' || !me.userId) throw new DomainError('forbidden', 'Interactive login required', 403);
    const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), body);
    await this.c.auth.changePassword(me.userId, b.currentPassword, b.newPassword, me.sessionId ?? undefined);
    return { ok: true };
  }
}

// ═════════════════════════════════════════════ customer portal: store, billing, support, extras

@ApiTags('customer')
@ApiBearerAuth()
@Controller('v1/customer')
export class CustomerPortalController {
  constructor(@InjectContainer() private readonly c: Container) {}

  private cid(me: Principal) {
    return me.customerId!;
  }

  private async scope(me: Principal): Promise<TicketScope> {
    return { kind: 'customer', customerId: this.cid(me), userId: me.userId!, name: await this.c.support.userName(me.userId!) };
  }

  // ── profile
  @Get('profile')
  @CustomerApi()
  async profile(@Me() me: Principal) {
    const [row] = await this.c.db.select().from(customers).where(and(eq(customers.id, this.cid(me)), eq(customers.tenantId, me.tenantId)));
    return row;
  }

  @Patch('profile')
  @CustomerApi()
  async updateProfile(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object(profileFields).partial(), body);
    checkGstin(b.gstin, b.stateCode);
    const patch = { ...b, country: b.country?.toUpperCase(), gstin: b.gstin === undefined ? undefined : b.gstin ? b.gstin.toUpperCase() : null, stateCode: b.stateCode === undefined ? undefined : b.stateCode || null };
    const [row] = await this.c.db.update(customers).set(patch).where(and(eq(customers.id, this.cid(me)), eq(customers.tenantId, me.tenantId))).returning();
    if (b.name && me.userId) await this.c.db.update(users).set({ name: b.name }).where(eq(users.id, me.userId));
    return row;
  }

  // ── store
  @Get('store/products')
  @CustomerApi()
  async store(@Me() me: Principal) {
    const s = await this.c.settings.get(this.c.db, me.tenantId);
    return this.c.catalog.storeCatalog(me.tenantId, s.billing.currency);
  }

  @Get('store/pools/:poolId/available')
  @CustomerApi()
  available(@Me() me: Principal, @Param('poolId') poolId: string) {
    return this.c.ipam.listSelectable(me.tenantId, parse(uuid, poolId), 64);
  }

  @Post('orders')
  @CustomerApi()
  async order(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({
        idempotencyKey: z.string().min(8).max(100),
        productSku: z.string().min(2),
        locationCode: z.string().min(2),
        templateId: uuid,
        cycle,
        hostname: z.string().min(3).max(253),
        password: z.string().min(12).max(128),
        ipv4Address: z.string().ip({ version: 'v4' }).optional(),
        sshKeys: z.array(z.string().max(4000)).max(5).optional(),
      }),
      body,
    );
    const r = await this.c.orders.createCustomerOrder({ tenantId: me.tenantId, customerId: this.cid(me), actor: actorOf(me), ...b });
    return { orderId: r.order.id, orderNumber: r.order.number, status: r.order.status, invoiceId: r.invoiceId, replayed: Boolean(r.replayed) };
  }

  @Get('orders')
  @CustomerApi()
  orders(@Me() me: Principal) {
    return this.c.orders.list(me.tenantId, { customerId: this.cid(me) });
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @CustomerApi()
  async cancelOrder(@Me() me: Principal, @Param('id') id: string) {
    await this.c.billing.cancelUnpaidOrderFor({ tenantId: me.tenantId, orderId: parse(uuid, id), customerId: this.cid(me), reason: 'Cancelled by customer', actor: actorOf(me) });
    return { ok: true };
  }

  // ── invoices
  @Get('invoices')
  @CustomerApi()
  invoices(@Me() me: Principal) {
    return this.c.billing.list(me.tenantId, { customerId: this.cid(me) });
  }

  @Get('invoices/:id')
  @CustomerApi()
  invoice(@Me() me: Principal, @Param('id') id: string) {
    return this.c.billing.get(me.tenantId, parse(uuid, id), this.cid(me));
  }

  @Get('invoices/:id/pdf')
  @CustomerApi()
  async invoicePdf(@Me() me: Principal, @Param('id') id: string, @Res() res: Response) {
    const pdf = await this.c.billing.pdf(me.tenantId, parse(uuid, id), this.cid(me));
    res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="invoice-${id.slice(0, 8)}.pdf"`).send(pdf);
  }

  @Get('payment-methods')
  @CustomerApi()
  async paymentMethods(@Me() me: Principal) {
    const s = await this.c.settings.get(this.c.db, me.tenantId);
    return { gateways: this.c.billing.gatewayNames(), bankDetails: s.billing.bankDetails };
  }

  /** Starts a hosted checkout. The invoice is only marked paid by the gateway's verified webhook. */
  @Post('invoices/:id/pay')
  @HttpCode(200)
  @CustomerApi()
  async pay(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ gateway: z.string().min(2).max(40) }), body);
    await throttle(this.c, `pay:${this.cid(me)}`, 20, 3600);
    return this.c.billing.startPayment({ tenantId: me.tenantId, invoiceId: parse(uuid, id), customerId: this.cid(me), gateway: b.gateway });
  }

  // ── support
  @Get('announcements')
  @CustomerApi()
  announcements(@Me() me: Principal) {
    return this.c.support.listAnnouncements(me.tenantId, 'CUSTOMERS');
  }

  @Get('support/departments')
  @CustomerApi()
  departments(@Me() me: Principal) {
    return this.c.support.departments(me.tenantId);
  }

  @Get('tickets')
  @CustomerApi()
  async tickets(@Me() me: Principal) {
    return this.c.support.list(me.tenantId, await this.scope(me));
  }

  @Post('tickets')
  @CustomerApi()
  async openTicket(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ departmentId: uuid, subject: z.string().min(3).max(200), body: z.string().min(1).max(20000), priority: priority.optional(), serviceId: uuid.optional() }), body);
    await throttle(this.c, `ticket:${this.cid(me)}`, 10, 3600);
    return this.c.support.open({ tenantId: me.tenantId, scope: await this.scope(me), ...b });
  }

  @Get('tickets/:id')
  @CustomerApi()
  async ticket(@Me() me: Principal, @Param('id') id: string) {
    return this.c.support.get(me.tenantId, await this.scope(me), parse(uuid, id));
  }

  @Post('tickets/:id/replies')
  @CustomerApi()
  async replyTicket(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ body: z.string().min(1).max(20000) }), body);
    return this.c.support.reply({ tenantId: me.tenantId, scope: await this.scope(me), ticketId: parse(uuid, id), body: b.body });
  }

  @Post('tickets/:id/close')
  @HttpCode(200)
  @CustomerApi()
  async closeTicket(@Me() me: Principal, @Param('id') id: string) {
    await this.c.support.close(me.tenantId, await this.scope(me), parse(uuid, id));
    return { ok: true };
  }

  // ── service extras
  @Get('services/:id/reinstall')
  @CustomerApi()
  reinstallOptions(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.reinstallOptions(me.tenantId, parse(uuid, id), { customerId: this.cid(me) });
  }

  @Post('services/:id/reinstall')
  @HttpCode(200)
  @CustomerApi()
  reinstall(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ templateId: uuid, password: z.string().min(12).max(128), confirm: z.literal(true) }), body);
    return this.c.extras.requestReinstall({ tenantId: me.tenantId, serviceId: parse(uuid, id), scope: { customerId: this.cid(me) }, templateId: b.templateId, password: b.password, actor: actorOf(me) });
  }

  @Get('services/:id/upgrade')
  @CustomerApi()
  async upgradeOptions(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.upgradeOptions(me.tenantId, parse(uuid, id), { customerId: this.cid(me) });
  }

  @Post('services/:id/upgrade')
  @HttpCode(200)
  @CustomerApi()
  upgrade(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ sku: z.string().min(2) }), body);
    return this.c.extras.requestUpgrade({ tenantId: me.tenantId, serviceId: parse(uuid, id), scope: { customerId: this.cid(me) }, sku: b.sku, actor: actorOf(me) });
  }

  @Get('services/:id/snapshots')
  @CustomerApi()
  snapshots(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.listSnapshots(me.tenantId, parse(uuid, id), { customerId: this.cid(me) });
  }

  @Post('services/:id/snapshots/:action')
  @HttpCode(200)
  @CustomerApi()
  snapshot(@Me() me: Principal, @Param('id') id: string, @Param('action') action: string, @Body() body: unknown) {
    const a = parse(z.enum(['create', 'rollback', 'delete']), action);
    const b = parse(z.object({ name: z.string().min(2).max(40) }), body);
    return this.c.extras.snapshotAction({ tenantId: me.tenantId, serviceId: parse(uuid, id), scope: { customerId: this.cid(me) }, action: `snapshot_${a}`, name: b.name, actor: actorOf(me) });
  }

  @Post('services/:id/console')
  @HttpCode(200)
  @CustomerApi()
  console(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.openConsole(me.tenantId, parse(uuid, id), { customerId: this.cid(me) }, actorOf(me));
  }
}

// ═════════════════════════════════════════════ reseller: support + service extras

@ApiTags('reseller')
@ApiBearerAuth()
@Controller('v1/reseller')
export class ResellerExtrasController {
  constructor(@InjectContainer() private readonly c: Container) {}

  private async scope(me: Principal): Promise<TicketScope> {
    if (me.userId) return { kind: 'reseller', resellerId: me.resellerId!, userId: me.userId, name: await this.c.support.userName(me.userId) };
    const [r] = await this.c.db.select({ name: resellers.name }).from(resellers).where(eq(resellers.id, me.resellerId!));
    return { kind: 'reseller', resellerId: me.resellerId!, name: r?.name ?? 'Reseller' };
  }

  @Get('announcements')
  @ResellerApi()
  announcements(@Me() me: Principal) {
    return this.c.support.listAnnouncements(me.tenantId, 'RESELLERS');
  }

  @Get('support/departments')
  @ResellerApi()
  departments(@Me() me: Principal) {
    return this.c.support.departments(me.tenantId);
  }

  @Get('tickets')
  @ResellerApi()
  async tickets(@Me() me: Principal) {
    return this.c.support.list(me.tenantId, await this.scope(me));
  }

  @Post('tickets')
  @ResellerApi()
  async openTicket(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ departmentId: uuid, subject: z.string().min(3).max(200), body: z.string().min(1).max(20000), priority: priority.optional(), serviceId: uuid.optional() }), body);
    if (b.serviceId) await this.c.serviceOps.get(me.tenantId, b.serviceId, { resellerId: me.resellerId! });
    return this.c.support.open({ tenantId: me.tenantId, scope: await this.scope(me), ...b });
  }

  @Get('tickets/:id')
  @ResellerApi()
  async ticket(@Me() me: Principal, @Param('id') id: string) {
    return this.c.support.get(me.tenantId, await this.scope(me), parse(uuid, id));
  }

  @Post('tickets/:id/replies')
  @ResellerApi()
  async reply(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ body: z.string().min(1).max(20000) }), body);
    return this.c.support.reply({ tenantId: me.tenantId, scope: await this.scope(me), ticketId: parse(uuid, id), body: b.body });
  }

  @Post('tickets/:id/close')
  @HttpCode(200)
  @ResellerApi()
  async close(@Me() me: Principal, @Param('id') id: string) {
    await this.c.support.close(me.tenantId, await this.scope(me), parse(uuid, id));
    return { ok: true };
  }

  @Get('services/:id/reinstall')
  @ResellerApi('services:read')
  reinstallOptions(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.reinstallOptions(me.tenantId, parse(uuid, id), { resellerId: me.resellerId! });
  }

  @Post('services/:id/reinstall')
  @HttpCode(200)
  @ResellerApi('services:write')
  reinstall(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ templateId: uuid, password: z.string().min(12).max(128) }), body);
    return this.c.extras.requestReinstall({ tenantId: me.tenantId, serviceId: parse(uuid, id), scope: { resellerId: me.resellerId! }, ...b, actor: actorOf(me) });
  }

  @Get('services/:id/upgrade')
  @ResellerApi('services:read')
  upgradeOptions(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.upgradeOptions(me.tenantId, parse(uuid, id), { resellerId: me.resellerId! });
  }

  @Get('services/:id/upgrade/quote')
  @ResellerApi('services:read')
  upgradeQuote(@Me() me: Principal, @Param('id') id: string, @Query('sku') sku: string) {
    return this.c.extras.upgradeQuote(me.tenantId, parse(uuid, id), { resellerId: me.resellerId! }, parse(z.string().min(2), sku));
  }

  /** Charges the prorated difference to the wallet, then resizes. Safe to retry: the charge is idempotent per period. */
  @Post('services/:id/upgrade')
  @HttpCode(200)
  @ResellerApi('services:write')
  upgrade(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ sku: z.string().min(2) }), body);
    return this.c.extras.requestUpgrade({ tenantId: me.tenantId, serviceId: parse(uuid, id), scope: { resellerId: me.resellerId! }, sku: b.sku, actor: actorOf(me) });
  }

  @Get('services/:id/snapshots')
  @ResellerApi('services:read')
  snapshots(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.listSnapshots(me.tenantId, parse(uuid, id), { resellerId: me.resellerId! });
  }

  @Post('services/:id/snapshots/:action')
  @HttpCode(200)
  @ResellerApi('services:write')
  snapshot(@Me() me: Principal, @Param('id') id: string, @Param('action') action: string, @Body() body: unknown) {
    const a = parse(z.enum(['create', 'rollback', 'delete']), action);
    const b = parse(z.object({ name: z.string().min(2).max(40) }), body);
    return this.c.extras.snapshotAction({ tenantId: me.tenantId, serviceId: parse(uuid, id), scope: { resellerId: me.resellerId! }, action: `snapshot_${a}`, name: b.name, actor: actorOf(me) });
  }

  @Post('services/:id/console')
  @HttpCode(200)
  @ResellerApi('services:write')
  console(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.openConsole(me.tenantId, parse(uuid, id), { resellerId: me.resellerId! }, actorOf(me));
  }
}

// ═════════════════════════════════════════════ admin: settings, customers, invoices, support, email

@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin')
export class AdminBillingController {
  constructor(@InjectContainer() private readonly c: Container) {}

  private async staff(me: Principal): Promise<TicketScope> {
    return { kind: 'staff', userId: me.userId!, name: await this.c.support.userName(me.userId!) };
  }

  // ── settings
  @Get('settings')
  @Admin()
  async settings(@Me() me: Principal) {
    const s = await this.c.settings.get(this.c.db, me.tenantId);
    return { ...s, email: { smtpConfigured: Boolean(this.c.env.SMTP_URL), from: this.c.env.MAIL_FROM }, gateways: this.c.billing.gatewayNames(), states: STATE_CODES };
  }

  @Put('settings')
  @Admin('settings:write')
  async updateSettings(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({
        brandName: z.string().min(2).max(100).optional(),
        company: z.record(z.unknown()).optional(),
        billing: z.record(z.unknown()).optional(),
        store: z.record(z.unknown()).optional(),
      }),
      body,
    );
    return this.c.settings.update(me.tenantId, b as Parameters<Container['settings']['update']>[1]);
  }

  // ── customers
  @Get('customers')
  @Admin()
  customers(@Me() me: Principal, @Query('q') q?: string) {
    const where = [eq(customers.tenantId, me.tenantId)];
    if (q) {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      where.push(or(ilike(customers.name, like), ilike(customers.email, like), ilike(customers.companyName, like))!);
    }
    return this.c.db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        companyName: customers.companyName,
        ownership: customers.ownership,
        resellerId: customers.resellerId,
        gstin: customers.gstin,
        stateCode: customers.stateCode,
        createdAt: customers.createdAt,
        services: sql<number>`(select count(*)::int from services s where s.customer_id = "customers"."id" and s.status <> 'TERMINATED')`,
        unpaidMinor: sql<string>`(select coalesce(sum(i.total_minor - i.paid_minor),0)::text from invoices i where i.customer_id = "customers"."id" and i.status in ('UNPAID','OVERDUE','PARTIALLY_PAID'))`,
      })
      .from(customers)
      .where(and(...where))
      .orderBy(desc(customers.createdAt))
      .limit(500);
  }

  @Get('customers/:id')
  @Admin()
  async customer(@Me() me: Principal, @Param('id') id: string) {
    const cid = parse(uuid, id);
    const [cust] = await this.c.db.select().from(customers).where(and(eq(customers.id, cid), eq(customers.tenantId, me.tenantId)));
    if (!cust) throw new DomainError('not_found', 'Customer not found', 404);
    const [svcs, invs, tickets] = await Promise.all([
      this.c.db.select().from(services).where(eq(services.customerId, cid)).orderBy(desc(services.createdAt)),
      this.c.billing.list(me.tenantId, { customerId: cid }),
      this.c.support.list(me.tenantId, { kind: 'customer', customerId: cid, userId: '', name: '' }),
    ]);
    return { customer: cust, services: svcs, invoices: invs, tickets };
  }

  @Patch('customers/:id')
  @Admin('billing:manage')
  async updateCustomer(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ ...profileFields, email: z.string().email().max(200) }).partial(), body);
    checkGstin(b.gstin, b.stateCode);
    const [row] = await this.c.db
      .update(customers)
      .set({ ...b, email: b.email?.toLowerCase(), country: b.country?.toUpperCase(), gstin: b.gstin === undefined ? undefined : b.gstin ? b.gstin.toUpperCase() : null, stateCode: b.stateCode === undefined ? undefined : b.stateCode || null })
      .where(and(eq(customers.id, parse(uuid, id)), eq(customers.tenantId, me.tenantId)))
      .returning();
    if (!row) throw new DomainError('not_found', 'Customer not found', 404);
    return row;
  }

  // ── invoices
  @Get('invoices')
  @Admin()
  invoices(@Me() me: Principal, @Query('status') status?: string, @Query('customerId') customerId?: string) {
    return this.c.billing.list(me.tenantId, { status: status ? status.split(',') : undefined, customerId: customerId ? parse(uuid, customerId) : undefined });
  }

  @Get('invoices/:id')
  @Admin()
  invoice(@Me() me: Principal, @Param('id') id: string) {
    return this.c.billing.get(me.tenantId, parse(uuid, id));
  }

  @Get('invoices/:id/pdf')
  @Admin()
  async invoicePdf(@Me() me: Principal, @Param('id') id: string, @Res() res: Response) {
    const pdf = await this.c.billing.pdf(me.tenantId, parse(uuid, id));
    res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="invoice-${id.slice(0, 8)}.pdf"`).send(pdf);
  }

  /** Manual invoice (custom services, one-off charges). */
  @Post('invoices')
  @Admin('billing:manage')
  async createInvoice(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({
        customerId: uuid,
        lines: z.array(z.object({ description: z.string().min(2).max(500), unitMinor: minorUnits, quantity: z.number().int().min(1).max(10000).optional(), taxRateBp: z.number().int().min(0).max(2800), hsnSac: z.string().max(8).optional() })).min(1).max(50),
        dueDate: z.coerce.date().optional(),
        notes: z.string().max(2000).optional(),
        issue: z.boolean().default(true),
      }),
      body,
    );
    return this.c.billing.inTx(async (tx) =>
      this.c.billing.createInvoice(tx, { tenantId: me.tenantId, customerId: b.customerId, kind: 'MANUAL', lines: b.lines, dueDate: b.dueDate, notes: b.notes, issue: b.issue }),
    );
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  @Admin('billing:manage')
  async issueInvoice(@Me() me: Principal, @Param('id') id: string) {
    const inv = await this.c.billing.get(me.tenantId, parse(uuid, id));
    return this.c.billing.inTx((tx) => this.c.billing.issue(tx, inv.id));
  }

  /** Record an offline payment (bank transfer/UPI/cash) after checking it arrived. */
  @Post('invoices/:id/payments')
  @Admin('billing:manage')
  async recordPayment(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ amountMinor: minorUnits, reference: z.string().min(3).max(200) }), body);
    if (b.amountMinor <= 0n) throw new DomainError('invalid_request', 'Amount must be positive', 422);
    return this.c.billing.recordManualPayment({ tenantId: me.tenantId, invoiceId: parse(uuid, id), amountMinor: b.amountMinor, reference: b.reference, actor: actorOf(me) });
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @Admin('billing:manage')
  async voidInvoice(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.string().min(3).max(500) }), body);
    await this.c.billing.void({ tenantId: me.tenantId, invoiceId: parse(uuid, id), reason: b.reason, actor: actorOf(me) });
    return { ok: true };
  }

  @Post('billing/run')
  @HttpCode(200)
  @Admin('billing:manage')
  runBilling(@Me() me: Principal) {
    return this.c.billing.runAutomation(me.tenantId);
  }

  // ── support
  @Get('tickets/counts')
  @Admin()
  ticketCounts(@Me() me: Principal) {
    return this.c.support.counts(me.tenantId);
  }

  @Get('tickets')
  @Admin()
  async tickets(@Me() me: Principal, @Query('status') status?: string) {
    return this.c.support.list(me.tenantId, await this.staff(me), { status: status ? parse(z.array(ticketStatus), status.split(',')) : undefined });
  }

  @Get('tickets/:id')
  @Admin()
  async ticket(@Me() me: Principal, @Param('id') id: string) {
    return this.c.support.get(me.tenantId, await this.staff(me), parse(uuid, id));
  }

  @Post('tickets')
  @Admin('support:manage')
  async openTicket(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(
      z.object({ departmentId: uuid, subject: z.string().min(3).max(200), body: z.string().min(1).max(20000), priority: priority.optional(), customerId: uuid.optional(), resellerId: uuid.optional() }),
      body,
    );
    if (!b.customerId && !b.resellerId) throw new DomainError('invalid_request', 'Choose a customer or reseller', 422);
    return this.c.support.open({ tenantId: me.tenantId, scope: await this.staff(me), departmentId: b.departmentId, subject: b.subject, body: b.body, priority: b.priority, forCustomerId: b.customerId, forResellerId: b.resellerId });
  }

  @Post('tickets/:id/replies')
  @Admin('support:manage')
  async reply(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ body: z.string().min(1).max(20000), internal: z.boolean().optional(), status: ticketStatus.optional() }), body);
    return this.c.support.reply({ tenantId: me.tenantId, scope: await this.staff(me), ticketId: parse(uuid, id), ...b });
  }

  @Patch('tickets/:id')
  @Admin('support:manage')
  updateTicket(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ status: ticketStatus.optional(), priority: priority.optional(), departmentId: uuid.optional() }), body);
    return this.c.support.update({ tenantId: me.tenantId, ticketId: parse(uuid, id), ...b, actor: actorOf(me) });
  }

  @Get('support/departments')
  @Admin()
  departments(@Me() me: Principal) {
    return this.c.support.departments(me.tenantId);
  }

  @Post('support/departments')
  @Admin('settings:write')
  createDepartment(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(2).max(80), description: z.string().max(300).optional() }), body);
    return this.c.support.createDepartment(me.tenantId, b.name, b.description);
  }

  @Get('announcements')
  @Admin()
  announcements(@Me() me: Principal) {
    return this.c.support.listAnnouncements(me.tenantId);
  }

  @Post('announcements')
  @Admin('support:manage')
  createAnnouncement(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ title: z.string().min(3).max(200), body: z.string().min(1).max(20000), audience: z.enum(['ALL', 'CUSTOMERS', 'RESELLERS']).default('ALL'), published: z.boolean().optional() }), body);
    return this.c.support.createAnnouncement(me.tenantId, b);
  }

  @Delete('announcements/:id')
  @Admin('support:manage')
  async deleteAnnouncement(@Me() me: Principal, @Param('id') id: string) {
    await this.c.support.deleteAnnouncement(me.tenantId, parse(uuid, id));
    return { ok: true };
  }

  // ── email
  @Get('emails')
  @Admin()
  emails(@Me() me: Principal) {
    return this.c.email.list(me.tenantId);
  }

  @Post('emails/:id/retry')
  @HttpCode(200)
  @Admin('settings:write')
  async retryEmail(@Me() me: Principal, @Param('id') id: string) {
    await this.c.email.retry(me.tenantId, parse(uuid, id));
    return { ok: true };
  }

  @Get('email-templates')
  @Admin()
  templates(@Me() me: Principal) {
    return this.c.email.listTemplates(me.tenantId);
  }

  @Put('email-templates/:key')
  @Admin('settings:write')
  saveTemplate(@Me() me: Principal, @Param('key') key: string, @Body() body: unknown) {
    const b = parse(z.object({ subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) }), body);
    return this.c.email.saveTemplate(me.tenantId, key, b.subject, b.body);
  }

  @Delete('email-templates/:key')
  @Admin('settings:write')
  async resetTemplate(@Me() me: Principal, @Param('key') key: string) {
    await this.c.email.resetTemplate(me.tenantId, key);
    return { ok: true };
  }

  // ── service extras (staff)
  @Get('services/:id/reinstall')
  @Admin()
  reinstallOptions(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.reinstallOptions(me.tenantId, parse(uuid, id), {});
  }

  @Post('services/:id/reinstall')
  @HttpCode(200)
  @Admin('services:manage')
  reinstall(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ templateId: uuid, password: z.string().min(12).max(128) }), body);
    return this.c.extras.requestReinstall({ tenantId: me.tenantId, serviceId: parse(uuid, id), scope: {}, ...b, actor: actorOf(me) });
  }

  @Get('services/:id/snapshots')
  @Admin()
  snapshots(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.listSnapshots(me.tenantId, parse(uuid, id), {});
  }

  @Post('services/:id/snapshots/:action')
  @HttpCode(200)
  @Admin('services:manage')
  snapshot(@Me() me: Principal, @Param('id') id: string, @Param('action') action: string, @Body() body: unknown) {
    const a = parse(z.enum(['create', 'rollback', 'delete']), action);
    const b = parse(z.object({ name: z.string().min(2).max(40) }), body);
    return this.c.extras.snapshotAction({ tenantId: me.tenantId, serviceId: parse(uuid, id), scope: {}, action: `snapshot_${a}`, name: b.name, actor: actorOf(me) });
  }

  @Post('services/:id/console')
  @HttpCode(200)
  @Admin('services:manage')
  console(@Me() me: Principal, @Param('id') id: string) {
    return this.c.extras.openConsole(me.tenantId, parse(uuid, id), {}, actorOf(me));
  }
}
