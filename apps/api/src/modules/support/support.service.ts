import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { announcements, customers, resellers, services, ticketDepartments, ticketMessages, tickets, users } from '../../db/schema';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { audit, type AuditActor } from '../../common/audit';
import type { EmailService } from '../email/email.service';
import type { SettingsService } from '../settings/settings.service';

type Priority = (typeof tickets.$inferSelect)['priority'];
type Status = (typeof tickets.$inferSelect)['status'];

/** Who is acting on a ticket. Customers and resellers only ever see their own tickets. */
export type TicketScope =
  | { kind: 'staff'; userId: string; name: string }
  | { kind: 'customer'; customerId: string; userId: string; name: string }
  | { kind: 'reseller'; resellerId: string; userId?: string; name: string };

const DEFAULT_DEPARTMENTS = ['Technical support', 'Billing', 'Sales'];

export class SupportService {
  constructor(
    private readonly db: Database,
    private readonly email: EmailService,
    private readonly settings: SettingsService,
  ) {}

  async departments(tenantId: string) {
    let rows = await this.db.select().from(ticketDepartments).where(eq(ticketDepartments.tenantId, tenantId)).orderBy(asc(ticketDepartments.sortOrder));
    if (!rows.length) {
      rows = await this.db
        .insert(ticketDepartments)
        .values(DEFAULT_DEPARTMENTS.map((name, i) => ({ tenantId, name, sortOrder: i })))
        .returning();
    }
    return rows;
  }

  async createDepartment(tenantId: string, name: string, description = '') {
    if (!name.trim()) throw Invalid('Department name is required');
    const [row] = await this.db.insert(ticketDepartments).values({ tenantId, name: name.trim(), description, sortOrder: 99 }).returning();
    return row;
  }

  private scopeWhere(scope: TicketScope) {
    if (scope.kind === 'customer') return eq(tickets.customerId, scope.customerId);
    if (scope.kind === 'reseller') return eq(tickets.resellerId, scope.resellerId);
    return sql`true`;
  }

  async list(tenantId: string, scope: TicketScope, opts: { status?: Status[] } = {}) {
    const where = [eq(tickets.tenantId, tenantId), this.scopeWhere(scope)];
    if (opts.status?.length) where.push(inArray(tickets.status, opts.status));
    return this.db
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        department: ticketDepartments.name,
        customerName: customers.name,
        resellerName: resellers.name,
        lastReplyAt: tickets.lastReplyAt,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .innerJoin(ticketDepartments, eq(ticketDepartments.id, tickets.departmentId))
      .leftJoin(customers, eq(customers.id, tickets.customerId))
      .leftJoin(resellers, eq(resellers.id, tickets.resellerId))
      .where(and(...where))
      .orderBy(desc(tickets.lastReplyAt))
      .limit(500);
  }

  async get(tenantId: string, scope: TicketScope, id: string) {
    const t = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, id), eq(tickets.tenantId, tenantId), this.scopeWhere(scope)),
      with: { messages: { orderBy: (m, { asc: a }) => [a(m.createdAt)] } },
    });
    if (!t) throw NotFound('Ticket');
    const [dept] = await this.db.select().from(ticketDepartments).where(eq(ticketDepartments.id, t.departmentId));
    // Internal notes never leave the staff view.
    const messages = scope.kind === 'staff' ? t.messages : t.messages.filter((m) => !m.internal);
    let requester: { name: string; email: string | null } | null = null;
    if (t.customerId) {
      const [c] = await this.db.select().from(customers).where(eq(customers.id, t.customerId));
      requester = c ? { name: c.name, email: c.email } : null;
    } else if (t.resellerId) {
      const [r] = await this.db.select().from(resellers).where(eq(resellers.id, t.resellerId));
      requester = r ? { name: r.name, email: r.contactEmail } : null;
    }
    return { ...t, messages, department: dept?.name, requester };
  }

  async open(p: {
    tenantId: string;
    scope: TicketScope;
    departmentId: string;
    subject: string;
    body: string;
    priority?: Priority;
    serviceId?: string;
    /** Staff opening on behalf of someone. */
    forCustomerId?: string;
    forResellerId?: string;
  }) {
    if (!p.subject.trim() || !p.body.trim()) throw Invalid('Subject and message are required');
    const [dept] = await this.db.select().from(ticketDepartments).where(and(eq(ticketDepartments.id, p.departmentId), eq(ticketDepartments.tenantId, p.tenantId)));
    if (!dept?.active) throw Invalid('Choose a department');
    const customerId = p.scope.kind === 'customer' ? p.scope.customerId : p.forCustomerId;
    const resellerId = p.scope.kind === 'reseller' ? p.scope.resellerId : p.forResellerId;
    if (!customerId && !resellerId) throw Invalid('A ticket must belong to a customer or reseller');
    if (p.serviceId) {
      const [svc] = await this.db.select().from(services).where(eq(services.id, p.serviceId));
      const owns = svc && svc.tenantId === p.tenantId && (customerId ? svc.customerId === customerId : svc.resellerId === resellerId);
      if (!owns) throw NotFound('Service');
    }
    return this.db.transaction(async (tx) => {
      const [t] = await tx
        .insert(tickets)
        .values({
          tenantId: p.tenantId,
          departmentId: dept.id,
          customerId,
          resellerId,
          openedByUserId: 'userId' in p.scope ? p.scope.userId : null,
          serviceId: p.serviceId,
          subject: p.subject.trim().slice(0, 200),
          priority: p.priority ?? 'MEDIUM',
          status: p.scope.kind === 'staff' ? 'ANSWERED' : 'OPEN',
        })
        .returning();
      await tx.insert(ticketMessages).values({
        ticketId: t.id,
        authorType: p.scope.kind.toUpperCase(),
        authorUserId: 'userId' in p.scope ? p.scope.userId : null,
        authorName: p.scope.name,
        body: p.body.trim(),
      });
      const s = await this.settings.get(tx, p.tenantId);
      if (p.scope.kind !== 'staff') {
        await this.email.queueStaff(tx, p.tenantId, 'staff.ticket', {
          ticketNumber: t.number,
          subject: t.subject,
          from: p.scope.name,
          message: p.body.trim(),
          ticketUrl: `${s.company.panelUrl}/admin/tickets/${t.id}`,
        }, { type: 'ticket', id: t.id });
      }
      return t;
    });
  }

  async reply(p: { tenantId: string; scope: TicketScope; ticketId: string; body: string; internal?: boolean; status?: Status }) {
    if (!p.body.trim()) throw Invalid('Message is required');
    const internal = p.scope.kind === 'staff' && Boolean(p.internal);
    return this.db.transaction(async (tx) => {
      const [t] = await tx
        .select()
        .from(tickets)
        .where(and(eq(tickets.id, p.ticketId), eq(tickets.tenantId, p.tenantId), this.scopeWhere(p.scope)))
        .for('update');
      if (!t) throw NotFound('Ticket');
      if (t.status === 'CLOSED' && p.scope.kind !== 'staff') {
        // A customer reply reopens a closed ticket.
      }
      await tx.insert(ticketMessages).values({
        ticketId: t.id,
        authorType: p.scope.kind.toUpperCase(),
        authorUserId: 'userId' in p.scope ? (p.scope.userId ?? null) : null,
        authorName: p.scope.name,
        body: p.body.trim(),
        internal,
      });
      const status: Status = internal ? t.status : p.scope.kind === 'staff' ? (p.status ?? 'ANSWERED') : 'CUSTOMER_REPLY';
      await tx
        .update(tickets)
        .set({ status, lastReplyAt: internal ? t.lastReplyAt : new Date(), closedAt: status === 'CLOSED' ? new Date() : null })
        .where(eq(tickets.id, t.id));
      const s = await this.settings.get(tx, p.tenantId);
      if (!internal && p.scope.kind === 'staff') {
        // Notify the requester.
        let to: string | null = null;
        let name = '';
        let url = `${s.company.panelUrl}/customer/tickets/${t.id}`;
        if (t.customerId) {
          const [c] = await tx.select().from(customers).where(eq(customers.id, t.customerId));
          to = c?.email ?? null;
          name = c?.name ?? '';
        } else if (t.resellerId) {
          const [r] = await tx.select().from(resellers).where(eq(resellers.id, t.resellerId));
          to = r?.contactEmail ?? null;
          name = r?.name ?? '';
          url = `${s.company.panelUrl}/reseller/tickets/${t.id}`;
        }
        await this.email.queue(tx, {
          tenantId: p.tenantId,
          to,
          key: 'ticket.reply',
          vars: { name, ticketNumber: t.number, subject: t.subject, message: p.body.trim(), ticketUrl: url },
          related: { type: 'ticket', id: t.id },
        });
      } else if (p.scope.kind !== 'staff') {
        await this.email.queueStaff(tx, p.tenantId, 'staff.ticket', {
          ticketNumber: t.number,
          subject: t.subject,
          from: p.scope.name,
          message: p.body.trim(),
          ticketUrl: `${s.company.panelUrl}/admin/tickets/${t.id}`,
        }, { type: 'ticket', id: t.id });
      }
      return { status };
    });
  }

  async update(p: { tenantId: string; ticketId: string; status?: Status; priority?: Priority; departmentId?: string; actor: AuditActor }) {
    const patch: Partial<typeof tickets.$inferInsert> = {};
    if (p.status) {
      patch.status = p.status;
      patch.closedAt = p.status === 'CLOSED' ? new Date() : null;
    }
    if (p.priority) patch.priority = p.priority;
    if (p.departmentId) patch.departmentId = p.departmentId;
    const rows = await this.db.update(tickets).set(patch).where(and(eq(tickets.id, p.ticketId), eq(tickets.tenantId, p.tenantId))).returning();
    if (!rows.length) throw NotFound('Ticket');
    await audit(this.db, { tenantId: p.tenantId, actor: p.actor, action: 'ticket.update', targetType: 'ticket', targetId: p.ticketId, metadata: patch as Record<string, unknown> });
    return rows[0];
  }

  /** Customers/resellers may close their own tickets. */
  async close(tenantId: string, scope: TicketScope, ticketId: string) {
    const rows = await this.db
      .update(tickets)
      .set({ status: 'CLOSED', closedAt: new Date() })
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId), this.scopeWhere(scope)))
      .returning();
    if (!rows.length) throw NotFound('Ticket');
  }

  async counts(tenantId: string) {
    const r = await this.db.execute(sql`select status, count(*)::int as n from tickets where tenant_id = ${tenantId} group by status`);
    return r.rows as Array<{ status: string; n: number }>;
  }

  // ───────────────────────── announcements

  listAnnouncements(tenantId: string, audience?: 'CUSTOMERS' | 'RESELLERS') {
    const where = [eq(announcements.tenantId, tenantId)];
    if (audience) where.push(eq(announcements.published, true), inArray(announcements.audience, ['ALL', audience]));
    return this.db.select().from(announcements).where(and(...where)).orderBy(desc(announcements.createdAt)).limit(50);
  }

  async createAnnouncement(tenantId: string, p: { title: string; body: string; audience: 'ALL' | 'CUSTOMERS' | 'RESELLERS'; published?: boolean }) {
    if (!p.title.trim() || !p.body.trim()) throw Invalid('Title and text are required');
    const [row] = await this.db.insert(announcements).values({ tenantId, ...p, published: p.published ?? true }).returning();
    return row;
  }

  async deleteAnnouncement(tenantId: string, id: string) {
    const rows = await this.db.delete(announcements).where(and(eq(announcements.id, id), eq(announcements.tenantId, tenantId))).returning();
    if (!rows.length) throw NotFound('Announcement');
  }

  /** Display name for the acting user. */
  async userName(userId: string) {
    const [u] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
    if (!u) throw Conflict('unknown_user', 'User not found');
    return u.name;
  }
}
