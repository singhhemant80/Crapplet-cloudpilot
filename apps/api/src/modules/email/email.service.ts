import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Database, DbOrTx } from '../../db/client';
import { emailMessages, emailTemplates } from '../../db/schema';
import { Invalid, NotFound } from '../../common/errors';
import type { SettingsService } from '../settings/settings.service';
import { DEFAULT_TEMPLATES, render } from './templates';

export const MAX_EMAIL_ATTEMPTS = 6;

export interface EmailTransport {
  send(msg: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

/** SMTP transport (SMTP_URL, e.g. smtps://user:pass@smtp.zoho.in:465). */
export class SmtpTransport implements EmailTransport {
  private readonly t: Transporter;
  constructor(url: string) {
    this.t = nodemailer.createTransport(url);
  }
  async send(msg: { from: string; to: string; subject: string; text: string }) {
    await this.t.sendMail(msg);
  }
}

/** Test transport that records messages instead of sending them. */
export class MemoryTransport implements EmailTransport {
  sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(msg: { to: string; subject: string; text: string }) {
    this.sent.push(msg);
  }
}

/**
 * Transactional email. `queue()` renders a template and stores the message in the
 * outbox inside the caller's transaction — so an email exists exactly when the
 * business change it describes was committed. The worker delivers and retries.
 */
export class EmailService {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly transport: EmailTransport | null,
    private readonly from: string,
  ) {}

  get configured() {
    return this.transport !== null;
  }

  async template(tx: DbOrTx, tenantId: string, key: string) {
    const def = DEFAULT_TEMPLATES[key];
    if (!def) throw Invalid(`Unknown email template ${key}`);
    const [o] = await tx.select().from(emailTemplates).where(and(eq(emailTemplates.tenantId, tenantId), eq(emailTemplates.key, key)));
    return { subject: o?.subject ?? def.subject, body: o?.body ?? def.body, customized: Boolean(o) };
  }

  async queue(
    tx: DbOrTx,
    p: { tenantId: string; to: string | null | undefined; key: string; vars: Record<string, string | number | null | undefined>; related?: { type: string; id: string } },
  ) {
    if (!p.to) return null;
    const s = await this.settings.get(tx, p.tenantId);
    const t = await this.template(tx, p.tenantId, p.key);
    const vars = { brand: s.brandName, panelUrl: s.company.panelUrl, supportEmail: s.company.supportEmail, ...p.vars };
    const [row] = await tx
      .insert(emailMessages)
      .values({
        tenantId: p.tenantId,
        toAddress: p.to,
        subject: render(t.subject, vars).slice(0, 300),
        body: render(t.body, vars),
        templateKey: p.key,
        relatedType: p.related?.type,
        relatedId: p.related?.id,
      })
      .returning({ id: emailMessages.id });
    return row.id;
  }

  /** Staff notifications go to the company support address from settings. */
  async queueStaff(tx: DbOrTx, tenantId: string, key: string, vars: Record<string, string | number | null | undefined>, related?: { type: string; id: string }) {
    const s = await this.settings.get(tx, tenantId);
    return this.queue(tx, { tenantId, to: s.company.supportEmail, key, vars, related });
  }

  /** Sends due messages. Returns counts; failures are retried on later sweeps up to MAX_EMAIL_ATTEMPTS. */
  async deliverPending(limit = 50) {
    if (!this.transport) return { sent: 0, failed: 0, skipped: true };
    const due = await this.db
      .select()
      .from(emailMessages)
      .where(and(inArray(emailMessages.status, ['QUEUED', 'FAILED']), lt(emailMessages.attempts, MAX_EMAIL_ATTEMPTS)))
      .orderBy(emailMessages.createdAt)
      .limit(limit);
    let sent = 0;
    let failed = 0;
    for (const m of due) {
      // Claim the row so parallel workers never send the same message twice.
      const claimed = await this.db
        .update(emailMessages)
        .set({ attempts: m.attempts + 1 })
        .where(and(eq(emailMessages.id, m.id), eq(emailMessages.attempts, m.attempts), inArray(emailMessages.status, ['QUEUED', 'FAILED'])))
        .returning({ id: emailMessages.id });
      if (!claimed.length) continue;
      try {
        await this.transport.send({ from: this.from, to: m.toAddress, subject: m.subject, text: m.body });
        await this.db.update(emailMessages).set({ status: 'SENT', sentAt: new Date(), lastError: null }).where(eq(emailMessages.id, m.id));
        sent++;
      } catch (err) {
        await this.db.update(emailMessages).set({ status: 'FAILED', lastError: (err as Error).message.slice(0, 500) }).where(eq(emailMessages.id, m.id));
        failed++;
      }
    }
    return { sent, failed, skipped: false };
  }

  list(tenantId: string, limit = 200) {
    return this.db.select().from(emailMessages).where(eq(emailMessages.tenantId, tenantId)).orderBy(desc(emailMessages.createdAt)).limit(limit);
  }

  async retry(tenantId: string, id: string) {
    const rows = await this.db
      .update(emailMessages)
      .set({ status: 'QUEUED', attempts: 0, lastError: null })
      .where(and(eq(emailMessages.id, id), eq(emailMessages.tenantId, tenantId), sql`${emailMessages.status} <> 'SENT'`))
      .returning();
    if (!rows.length) throw NotFound('Unsent email');
  }

  async listTemplates(tenantId: string) {
    const overrides = await this.db.select().from(emailTemplates).where(eq(emailTemplates.tenantId, tenantId));
    return Object.entries(DEFAULT_TEMPLATES).map(([key, def]) => {
      const o = overrides.find((x) => x.key === key);
      return { key, description: def.description, variables: def.variables, subject: o?.subject ?? def.subject, body: o?.body ?? def.body, customized: Boolean(o) };
    });
  }

  async saveTemplate(tenantId: string, key: string, subject: string, body: string) {
    if (!DEFAULT_TEMPLATES[key]) throw Invalid(`Unknown email template ${key}`);
    await this.db
      .insert(emailTemplates)
      .values({ tenantId, key, subject, body })
      .onConflictDoUpdate({ target: [emailTemplates.tenantId, emailTemplates.key], set: { subject, body, updatedAt: new Date() } });
  }

  async resetTemplate(tenantId: string, key: string) {
    await this.db.delete(emailTemplates).where(and(eq(emailTemplates.tenantId, tenantId), eq(emailTemplates.key, key)));
  }
}
