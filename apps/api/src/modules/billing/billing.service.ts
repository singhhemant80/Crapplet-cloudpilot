import { and, desc, eq, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { Database, DbOrTx, Tx } from '../../db/client';
import { customers, invoiceLines, invoiceSequences, invoices, orders, payments, products, services } from '../../db/schema';
import { Conflict, DomainError, Invalid, NotFound, isUniqueViolation } from '../../common/errors';
import { audit, type AuditActor } from '../../common/audit';
import type { SettingsService } from '../settings/settings.service';
import { STATE_CODES } from '../settings/settings.service';
import type { EmailService } from '../email/email.service';
import type { PaymentGateway, VerifiedPaymentEvent } from '../payments/gateways';
import type { JobQueue } from '../jobs/queue';
import type { IpamService } from '../ipam/ipam.service';
import { addCycle, transitionOrder } from '../orders/order.service';
import { computeTax, financialYear, invoiceNumber } from './gst';

type Invoice = typeof invoices.$inferSelect;
type Kind = Invoice['kind'];

export interface InvoiceLineInput {
  description: string;
  unitMinor: bigint;
  quantity?: number;
  hsnSac?: string | null;
  taxRateBp: number;
  productId?: string | null;
  serviceId?: string | null;
}

const SYSTEM: AuditActor = { type: 'system', id: 'billing' };
const DAY = 86_400_000;

export function formatMoney(minor: bigint | string, currency: string) {
  const n = Number(BigInt(minor)) / 100;
  return `${currency} ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const dateStr = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');

/**
 * Invoicing for direct (non-reseller) customers.
 *
 * - Invoices are created as DRAFT and numbered only when issued: numbers are gap-free
 *   and sequential per financial year (row-locked counter), as GST requires.
 * - Issued invoices are immutable in the database (trigger); corrections = void + reissue.
 * - Payments are recorded per gateway payment id (unique), so a duplicate webhook can
 *   never apply the same payment twice.
 * - Paying an invoice drives the business outcome in the same transaction: a new order
 *   is released for provisioning, a renewal extends the due date, an overdue suspension
 *   is lifted.
 */
export class BillingService {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly email: EmailService,
    private readonly gateways: Map<string, PaymentGateway>,
    private readonly queue: JobQueue,
    private readonly ipam: IpamService,
  ) {}

  // ───────────────────────────────────────── creation

  /** Creates and issues an invoice inside the caller's transaction. */
  async createInvoice(
    tx: Tx,
    p: {
      tenantId: string;
      customerId: string;
      kind: Kind;
      lines: InvoiceLineInput[];
      dueDate?: Date;
      orderId?: string;
      serviceId?: string;
      periodStart?: Date;
      periodEnd?: Date;
      notes?: string;
      issue?: boolean;
      sendEmail?: boolean;
    },
  ) {
    if (!p.lines.length) throw Invalid('An invoice needs at least one line');
    const [cust] = await tx.select().from(customers).where(and(eq(customers.id, p.customerId), eq(customers.tenantId, p.tenantId)));
    if (!cust) throw NotFound('Customer');
    const s = await this.settings.get(tx, p.tenantId);
    const lineAmounts = p.lines.map((l) => {
      const qty = l.quantity ?? 1;
      if (qty < 1 || l.unitMinor < 0n) throw Invalid('Invalid invoice line');
      return { ...l, quantity: qty, amountMinor: l.unitMinor * BigInt(qty) };
    });
    const tax = computeTax(
      { sellerGstin: s.company.gstin, sellerStateCode: s.company.stateCode, buyerCountry: cust.country, buyerStateCode: cust.stateCode },
      lineAmounts.map((l) => ({ amountMinor: l.amountMinor, taxRateBp: l.taxRateBp })),
    );
    const taxed = tax.taxType === 'INTRA' || tax.taxType === 'INTER';
    const buyerAddress = [cust.companyName, cust.address1, cust.address2, [cust.city, cust.state, cust.postalCode].filter(Boolean).join(' '), cust.country]
      .filter(Boolean)
      .join('\n');
    const now = new Date();
    const [inv] = await tx
      .insert(invoices)
      .values({
        tenantId: p.tenantId,
        customerId: p.customerId,
        kind: p.kind,
        currency: s.billing.currency,
        status: 'DRAFT',
        subtotalMinor: tax.subtotalMinor,
        cgstMinor: tax.cgstMinor,
        sgstMinor: tax.sgstMinor,
        igstMinor: tax.igstMinor,
        taxMinor: tax.taxMinor,
        totalMinor: tax.totalMinor,
        taxType: tax.taxType,
        placeOfSupply: tax.placeOfSupply,
        sellerGstin: s.company.gstin || null,
        buyerGstin: cust.gstin || null,
        buyerName: cust.companyName || cust.name,
        buyerAddress,
        orderId: p.orderId,
        serviceId: p.serviceId,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        notes: p.notes ?? '',
        dueDate: p.dueDate ?? new Date(now.getTime() + s.billing.dueDays * DAY),
      })
      .returning();
    await tx.insert(invoiceLines).values(
      lineAmounts.map((l, i) => ({
        invoiceId: inv.id,
        description: l.description,
        hsnSac: l.hsnSac ?? null,
        quantity: l.quantity,
        unitMinor: l.unitMinor,
        amountMinor: l.amountMinor,
        taxRateBp: taxed ? l.taxRateBp : 0,
        productId: l.productId ?? null,
        serviceId: l.serviceId ?? null,
        sortOrder: i,
      })),
    );
    if (p.issue === false) return inv;
    return this.issue(tx, inv.id, p.sendEmail ?? true);
  }

  /** DRAFT → UNPAID with the next gap-free number of the financial year. Zero-total invoices are marked PAID. */
  async issue(tx: Tx, invoiceId: string, sendEmail = true) {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
    if (!inv) throw NotFound('Invoice');
    if (inv.status !== 'DRAFT') return inv;
    const s = await this.settings.get(tx, inv.tenantId);
    const now = new Date();
    const fy = financialYear(now);
    const [seq] = await tx
      .insert(invoiceSequences)
      .values({ tenantId: inv.tenantId, financialYear: fy, next: 2 })
      .onConflictDoUpdate({ target: [invoiceSequences.tenantId, invoiceSequences.financialYear], set: { next: sql`${invoiceSequences.next} + 1` } })
      .returning({ next: invoiceSequences.next });
    const number = invoiceNumber(s.billing.invoicePrefix, fy, seq.next - 1);
    const free = inv.totalMinor === 0n;
    const [issued] = await tx
      .update(invoices)
      .set({ number, financialYear: fy, issueDate: now, status: free ? 'PAID' : 'UNPAID', paidAt: free ? now : null })
      .where(eq(invoices.id, invoiceId))
      .returning();
    if (free) await this.onPaid(tx, issued);
    else if (sendEmail) await this.notifyCreated(tx, issued);
    return issued;
  }

  private async notifyCreated(tx: DbOrTx, inv: Invoice) {
    const [cust] = await tx.select().from(customers).where(eq(customers.id, inv.customerId));
    const s = await this.settings.get(tx, inv.tenantId);
    await this.email.queue(tx, {
      tenantId: inv.tenantId,
      to: cust?.email,
      key: 'invoice.created',
      vars: {
        name: cust?.name,
        invoiceNumber: inv.number,
        total: formatMoney(inv.totalMinor, inv.currency),
        dueDate: dateStr(inv.dueDate),
        invoiceUrl: `${s.company.panelUrl}/customer/invoices/${inv.id}`,
      },
      related: { type: 'invoice', id: inv.id },
    });
  }

  // ───────────────────────────────────────── reads

  async get(tenantId: string, id: string, customerId?: string) {
    const where = [eq(invoices.id, id), eq(invoices.tenantId, tenantId)];
    if (customerId) where.push(eq(invoices.customerId, customerId));
    const inv = await this.db.query.invoices.findFirst({
      where: and(...where),
      with: { lines: { orderBy: (l, { asc }) => [asc(l.sortOrder)] }, payments: { orderBy: (p, { asc }) => [asc(p.createdAt)] } },
    });
    if (!inv) throw NotFound('Invoice');
    if (customerId && inv.status === 'DRAFT') throw NotFound('Invoice');
    return inv;
  }

  list(tenantId: string, opts: { customerId?: string; status?: string[]; limit?: number } = {}) {
    const where = [eq(invoices.tenantId, tenantId)];
    if (opts.customerId) where.push(eq(invoices.customerId, opts.customerId), ne(invoices.status, 'DRAFT'));
    if (opts.status?.length) where.push(inArray(invoices.status, opts.status as Invoice['status'][]));
    return this.db
      .select({
        id: invoices.id,
        number: invoices.number,
        status: invoices.status,
        kind: invoices.kind,
        currency: invoices.currency,
        totalMinor: invoices.totalMinor,
        paidMinor: invoices.paidMinor,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        buyerName: invoices.buyerName,
        customerId: invoices.customerId,
        orderId: invoices.orderId,
        serviceId: invoices.serviceId,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .where(and(...where))
      .orderBy(desc(invoices.createdAt))
      .limit(Math.min(opts.limit ?? 200, 1000));
  }

  // ───────────────────────────────────────── payments

  /** Starts an online payment for the outstanding balance; credited only by the verified webhook. */
  async startPayment(p: { tenantId: string; invoiceId: string; customerId: string; gateway: string }) {
    const gw = this.gateways.get(p.gateway);
    if (!gw) throw Invalid(`Payment gateway "${p.gateway}" is not configured`);
    const inv = await this.get(p.tenantId, p.invoiceId, p.customerId);
    if (!['UNPAID', 'OVERDUE', 'PARTIALLY_PAID'].includes(inv.status)) throw Conflict('invoice_not_payable', `Invoice is ${inv.status}`);
    const due = inv.totalMinor - inv.paidMinor;
    const [pay] = await this.db
      .insert(payments)
      .values({ tenantId: p.tenantId, invoiceId: inv.id, customerId: inv.customerId, gateway: gw.name, amountMinor: due, currency: inv.currency })
      .returning();
    const checkout = await gw.createCheckout({ depositId: pay.id, amountMinor: due, currency: inv.currency, description: `Invoice ${inv.number}` });
    await this.db.update(payments).set({ gatewayOrderId: checkout.gatewayOrderId }).where(eq(payments.id, pay.id));
    return { paymentId: pay.id, checkout };
  }

  async findPaymentByGatewayOrder(gateway: string, gatewayOrderId: string) {
    const [p] = await this.db.select().from(payments).where(and(eq(payments.gateway, gateway), eq(payments.gatewayOrderId, gatewayOrderId)));
    return p ?? null;
  }

  /**
   * Called (inside the webhook's transaction) when a verified gateway event refers to an
   * invoice payment rather than a wallet deposit. Returns a result label for the event log.
   */
  async applyGatewayEvent(tx: Tx, gateway: string, ev: VerifiedPaymentEvent): Promise<string | null> {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.gateway, gateway), eq(payments.gatewayOrderId, ev.gatewayOrderId)))
      .for('update');
    if (!pay) return null;
    if (ev.outcome === 'ignored') return 'ignored';
    if (pay.status === 'SUCCEEDED') return 'already_paid';
    if (ev.outcome === 'failed') {
      await tx.update(payments).set({ status: 'FAILED', gatewayPaymentId: ev.gatewayPaymentId }).where(eq(payments.id, pay.id));
      return 'marked_failed';
    }
    if (ev.amountMinor !== pay.amountMinor || ev.currency !== pay.currency) {
      await audit(tx, { tenantId: pay.tenantId, actor: { type: 'system', id: gateway }, action: 'payment.amount_mismatch', targetType: 'payment', targetId: pay.id, metadata: { eventId: ev.eventId } });
      return `amount_mismatch (expected ${pay.amountMinor} ${pay.currency}, got ${ev.amountMinor} ${ev.currency})`;
    }
    await tx.update(payments).set({ status: 'SUCCEEDED', gatewayPaymentId: ev.gatewayPaymentId, paidAt: new Date() }).where(eq(payments.id, pay.id));
    await this.applyToInvoice(tx, pay.invoiceId, pay.amountMinor);
    return 'invoice_paid';
  }

  /** Staff records a payment received outside the gateways (bank transfer, cash, UPI to account). */
  async recordManualPayment(p: { tenantId: string; invoiceId: string; amountMinor: bigint; reference: string; actor: AuditActor }) {
    if (p.amountMinor <= 0n) throw Invalid('Amount must be positive');
    if (!p.reference.trim()) throw Invalid('A payment reference (UTR, cheque no.) is required');
    await this.inTx(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, p.invoiceId), eq(invoices.tenantId, p.tenantId))).for('update');
      if (!inv) throw NotFound('Invoice');
      if (!['UNPAID', 'OVERDUE', 'PARTIALLY_PAID'].includes(inv.status)) throw Conflict('invoice_not_payable', `Invoice is ${inv.status}`);
      if (p.amountMinor > inv.totalMinor - inv.paidMinor) throw Invalid('Amount exceeds the balance due');
      try {
        await tx.insert(payments).values({
          tenantId: p.tenantId,
          invoiceId: inv.id,
          customerId: inv.customerId,
          gateway: 'manual',
          amountMinor: p.amountMinor,
          currency: inv.currency,
          status: 'SUCCEEDED',
          gatewayPaymentId: p.reference.trim().toUpperCase(),
          reference: p.reference.trim(),
          recordedById: p.actor.type === 'user' ? (p.actor.id ?? null) : null,
          paidAt: new Date(),
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw Conflict('duplicate_reference', 'This payment reference was already recorded');
        throw err;
      }
      await audit(tx, { tenantId: p.tenantId, actor: p.actor, action: 'invoice.manual_payment', targetType: 'invoice', targetId: inv.id, metadata: { amountMinor: p.amountMinor.toString(), reference: p.reference } });
      await this.applyToInvoice(tx, inv.id, p.amountMinor);
    });
  }

  private async applyToInvoice(tx: Tx, invoiceId: string, amount: bigint) {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
    const paid = inv.paidMinor + amount;
    const full = paid >= inv.totalMinor;
    const [updated] = await tx
      .update(invoices)
      .set({ paidMinor: paid, status: full ? 'PAID' : 'PARTIALLY_PAID', paidAt: full ? new Date() : null })
      .where(eq(invoices.id, invoiceId))
      .returning();
    const [cust] = await tx.select().from(customers).where(eq(customers.id, inv.customerId));
    await this.email.queue(tx, {
      tenantId: inv.tenantId,
      to: cust?.email,
      key: 'invoice.paid',
      vars: { name: cust?.name, invoiceNumber: inv.number, amount: formatMoney(amount, inv.currency) },
      related: { type: 'invoice', id: inv.id },
    });
    if (full) await this.onPaid(tx, updated);
  }

  /** Business consequences of a fully paid invoice. Queue work is scheduled after commit by the caller's flow. */
  private async onPaid(tx: Tx, inv: Invoice) {
    if (inv.orderId) {
      const [o] = await tx.select().from(orders).where(eq(orders.id, inv.orderId)).for('update');
      if (o?.status === 'PENDING_PAYMENT') {
        const [prod] = await tx.select().from(products).where(eq(products.id, o.productId));
        await transitionOrder(tx, o.id, 'PAID_OR_AUTHORIZED', `Invoice ${inv.number} paid`);
        if (prod.provisioning === 'AUTOMATIC') {
          await transitionOrder(tx, o.id, 'QUEUED', 'Queued for provisioning');
          this.afterCommit(tx, () => this.queue.enqueueProvision(o.id));
        }
      }
    }
    if (inv.kind === 'UPGRADE' && inv.serviceId) {
      const [line] = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
      if (line?.productId) {
        const serviceId = inv.serviceId;
        this.afterCommit(tx, () =>
          this.queue
            .runServiceOperation({ serviceId, action: 'upgrade', actor: SYSTEM, params: { productId: line.productId! } }, `upgrade-${serviceId}-${inv.id}`, 1)
            .then(() => undefined),
        );
      }
    }
    if (inv.kind === 'RENEWAL' && inv.serviceId && inv.periodEnd) {
      const [svc] = await tx.select().from(services).where(eq(services.id, inv.serviceId)).for('update');
      // Only move the due date forward (never back if invoices are paid out of order).
      if (svc && (!svc.nextDueDate || svc.nextDueDate < inv.periodEnd)) {
        await tx.update(services).set({ nextDueDate: inv.periodEnd, updatedAt: new Date() }).where(eq(services.id, svc.id));
      }
      if (svc?.status === 'SUSPENDED' && svc.suspendedReason?.startsWith('Overdue')) {
        const stillOverdue = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(eq(invoices.serviceId, svc.id), inArray(invoices.status, ['OVERDUE'])));
        if (!stillOverdue.length) {
          this.afterCommit(tx, () =>
            this.queue.runServiceOperation({ serviceId: svc.id, action: 'unsuspend', actor: SYSTEM }, `unsuspend-${svc.id}-${inv.id}`, 1).then(() => undefined),
          );
        }
      }
    }
  }

  /** Customer upgrade: an UPGRADE invoice whose payment queues the resize (see onPaid). */
  async createUpgradeInvoice(p: { tenantId: string; customerId: string; serviceId: string; productId: string; description: string; unitMinor: bigint; hsnSac: string; taxRateBp: number }) {
    return this.inTx((tx) =>
      this.createInvoice(tx, {
        tenantId: p.tenantId,
        customerId: p.customerId,
        kind: 'UPGRADE',
        serviceId: p.serviceId,
        dueDate: new Date(),
        lines: [{ description: p.description, unitMinor: p.unitMinor, hsnSac: p.hsnSac, taxRateBp: p.taxRateBp, productId: p.productId, serviceId: p.serviceId }],
      }),
    );
  }

  // Deferred actions run once the surrounding transaction commits (never for rolled-back work).
  private pending = new WeakMap<object, Array<() => Promise<void>>>();
  private afterCommit(tx: Tx, fn: () => Promise<void>) {
    const list = this.pending.get(tx) ?? [];
    list.push(fn);
    this.pending.set(tx, list);
  }
  /** Runs `fn` in a transaction, then executes the queued after-commit actions. */
  gatewayNames() {
    return [...this.gateways.keys()];
  }

  /** Customer cancels a store order that has not been paid yet: voids its invoice and frees the IP. */
  async cancelUnpaidOrderFor(p: { tenantId: string; orderId: string; customerId: string; reason: string; actor: AuditActor }) {
    const [o] = await this.db.select().from(orders).where(and(eq(orders.id, p.orderId), eq(orders.tenantId, p.tenantId), eq(orders.customerId, p.customerId)));
    if (!o) throw NotFound('Order');
    if (o.status !== 'PENDING_PAYMENT') throw Conflict('order_not_cancellable', 'Only unpaid orders can be cancelled');
    const [inv] = await this.db.select().from(invoices).where(and(eq(invoices.orderId, o.id), eq(invoices.kind, 'NEW_ORDER')));
    if (inv && inv.paidMinor > 0n) throw Conflict('order_partially_paid', 'This order has a payment; contact billing support');
    if (inv && inv.status !== 'VOID') return this.void({ tenantId: p.tenantId, invoiceId: inv.id, reason: p.reason, actor: p.actor });
    await this.db.transaction((tx) => this.cancelUnpaidOrder(tx, o.id, p.reason));
  }

  async inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    let txRef: Tx | undefined;
    const result = await this.db.transaction(async (tx) => {
      txRef = tx;
      return fn(tx);
    });
    const actions = (txRef && this.pending.get(txRef)) ?? [];
    for (const a of actions) await a().catch((e) => console.error('after-commit action failed', e));
    return result;
  }
  /** For callers that own the transaction (e.g. the webhook handler). */
  takeAfterCommit(tx: Tx) {
    const a = this.pending.get(tx) ?? [];
    this.pending.delete(tx);
    return a;
  }

  async void(p: { tenantId: string; invoiceId: string; reason: string; actor: AuditActor }) {
    if (!p.reason.trim()) throw Invalid('A reason is required');
    await this.inTx(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, p.invoiceId), eq(invoices.tenantId, p.tenantId))).for('update');
      if (!inv) throw NotFound('Invoice');
      if (inv.paidMinor > 0n) throw Conflict('invoice_has_payments', 'Invoices with payments cannot be voided; refund first');
      if (inv.status === 'VOID') return;
      await tx.update(invoices).set({ status: 'VOID', voidedAt: new Date(), notes: `${inv.notes}\nVoided: ${p.reason}`.trim() }).where(eq(invoices.id, inv.id));
      if (inv.orderId) await this.cancelUnpaidOrder(tx, inv.orderId, `Invoice voided: ${p.reason}`);
      await audit(tx, { tenantId: p.tenantId, actor: p.actor, action: 'invoice.void', targetType: 'invoice', targetId: inv.id, metadata: { reason: p.reason } });
    });
  }

  private async cancelUnpaidOrder(tx: Tx, orderId: string, reason: string) {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (o?.status !== 'PENDING_PAYMENT') return;
    await this.ipam.releaseForOrder(tx, orderId, 'unpaid order cancelled');
    await transitionOrder(tx, orderId, 'CANCELLED', reason, { encryptedSecret: null });
    await tx.update(services).set({ status: 'FAILED', updatedAt: new Date() }).where(eq(services.orderId, orderId));
  }

  // ───────────────────────────────────────── automation (run by the worker)

  /**
   * Renewal invoices, overdue marking + reminders, suspension after the grace period,
   * optional termination, and expiry of unpaid new orders. Safe to run repeatedly:
   * each step is guarded by state and unique constraints.
   */
  async runAutomation(tenantId: string, now = new Date()) {
    const s = await this.settings.get(this.db, tenantId);
    const b = s.billing;
    const out = { renewals: 0, overdue: 0, suspended: 0, terminated: 0, cancelledOrders: 0 };

    // 1. Renewal invoices for direct-customer services due within the lead time.
    const due = await this.db
      .select({ svc: services, product: products })
      .from(services)
      .innerJoin(products, eq(products.id, services.productId))
      .where(
        and(
          eq(services.tenantId, tenantId),
          isNull(services.resellerId),
          inArray(services.status, ['ACTIVE', 'SUSPENDED']),
          ne(services.cycle, 'ONE_TIME'),
          lte(services.nextDueDate, new Date(now.getTime() + b.renewalLeadDays * DAY)),
        ),
      );
    for (const { svc, product } of due) {
      if (!svc.customerId || !svc.nextDueDate) continue;
      const periodEnd = addCycle(svc.nextDueDate, svc.cycle)!;
      try {
        await this.inTx((tx) =>
          this.createInvoice(tx, {
            tenantId,
            customerId: svc.customerId!,
            kind: 'RENEWAL',
            serviceId: svc.id,
            periodStart: svc.nextDueDate!,
            periodEnd,
            dueDate: svc.nextDueDate!,
            lines: [
              {
                description: `${product.name} — ${svc.hostname} (${dateStr(svc.nextDueDate)} to ${dateStr(periodEnd)})`,
                unitMinor: svc.renewalMinor,
                hsnSac: product.hsnSac,
                taxRateBp: product.gstRateBp,
                productId: product.id,
                serviceId: svc.id,
              },
            ],
          }),
        );
        out.renewals++;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // already invoiced for this period
      }
    }

    // 2. Mark overdue + reminder.
    const lapsed = await this.db
      .update(invoices)
      .set({ status: 'OVERDUE' })
      .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.status, ['UNPAID', 'PARTIALLY_PAID']), lt(invoices.dueDate, now), ne(invoices.kind, 'NEW_ORDER')))
      .returning();
    for (const inv of lapsed) {
      out.overdue++;
      const [cust] = await this.db.select().from(customers).where(eq(customers.id, inv.customerId));
      await this.email.queue(this.db, {
        tenantId,
        to: cust?.email,
        key: 'invoice.overdue',
        vars: {
          name: cust?.name,
          invoiceNumber: inv.number,
          total: formatMoney(inv.totalMinor - inv.paidMinor, inv.currency),
          dueDate: dateStr(inv.dueDate),
          suspendDate: b.autoSuspend ? dateStr(new Date(inv.dueDate!.getTime() + b.graceDays * DAY)) : 'never',
          invoiceUrl: `${s.company.panelUrl}/customer/invoices/${inv.id}`,
        },
        related: { type: 'invoice', id: inv.id },
      });
    }

    // 3. Suspend after the grace period; 4. optional termination.
    const overdue = await this.db
      .select({ inv: invoices, svc: services })
      .from(invoices)
      .innerJoin(services, eq(services.id, invoices.serviceId))
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, 'OVERDUE')));
    for (const { inv, svc } of overdue) {
      const age = now.getTime() - inv.dueDate!.getTime();
      if (b.autoSuspend && svc.status === 'ACTIVE' && age >= b.graceDays * DAY) {
        const r = await this.queue.runServiceOperation(
          { serviceId: svc.id, action: 'suspend', reason: `Overdue invoice ${inv.number}`, actor: SYSTEM },
          `overdue-suspend-${svc.id}-${inv.id}`,
          1,
        );
        if (!r.error) out.suspended++;
      }
      if (b.autoTerminateDays > 0 && svc.status === 'SUSPENDED' && age >= b.autoTerminateDays * DAY) {
        const r = await this.queue.runServiceOperation(
          { serviceId: svc.id, action: 'terminate', reason: `Unpaid invoice ${inv.number} for ${b.autoTerminateDays} days`, actor: SYSTEM },
          `overdue-terminate-${svc.id}-${inv.id}`,
          1,
        );
        if (!r.error) out.terminated++;
      }
    }

    // 5. Unpaid new orders expire: release the reserved IP and cancel.
    const stale = await this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.kind, 'NEW_ORDER'),
          inArray(invoices.status, ['UNPAID']),
          lt(invoices.issueDate, new Date(now.getTime() - b.orderPaymentWindowHours * 3_600_000)),
        ),
      );
    for (const inv of stale) {
      await this.void({ tenantId, invoiceId: inv.id, reason: `Not paid within ${b.orderPaymentWindowHours} hours`, actor: SYSTEM });
      out.cancelledOrders++;
    }
    return out;
  }

  // ───────────────────────────────────────── PDF

  async pdf(tenantId: string, invoiceId: string, customerId?: string): Promise<Buffer> {
    const inv = await this.get(tenantId, invoiceId, customerId);
    const s = await this.settings.get(this.db, tenantId);
    const { renderInvoicePdf } = await import('./invoice-pdf');
    return renderInvoicePdf(inv, s, STATE_CODES);
  }

  ensurePayable(inv: Invoice) {
    if (!['UNPAID', 'OVERDUE', 'PARTIALLY_PAID'].includes(inv.status)) throw new DomainError('invoice_not_payable', `Invoice is ${inv.status}`, 409);
  }
}
