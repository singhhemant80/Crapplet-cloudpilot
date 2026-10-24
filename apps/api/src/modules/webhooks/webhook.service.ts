import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database, DbOrTx } from '../../db/client';
import { webhookDeliveries, webhookEndpoints, webhookEvents } from '../../db/schema';
import { decryptSecret, encryptSecret, hmacSha256Hex, randomToken } from '../../common/crypto';
import { Invalid, NotFound } from '../../common/errors';

export const WEBHOOK_EVENT_TYPES = [
  'deposit.credited',
  'deposit.rejected',
  'wallet.low_balance',
  'order.created',
  'order.failed',
  'service.activated',
  'service.suspended',
  'service.unsuspended',
  'service.terminated',
  'service.renewed',
  'ip.assigned',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const MAX_WEBHOOK_ATTEMPTS = 8;

/** Signature header: `t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<body>")>` — receivers reject t older than 5 minutes. */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}

/** SSRF guard: https only, and the hostname must not resolve to private/loopback space. */
export async function assertSafeWebhookUrl(raw: string, allowPrivate: boolean) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Invalid('Invalid webhook URL');
  }
  if (!allowPrivate && url.protocol !== 'https:') throw Invalid('Webhook URL must use https');
  if (url.username || url.password) throw Invalid('Webhook URL must not contain credentials');
  if (allowPrivate) return url;
  const addrs = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw Invalid('Webhook hostname does not resolve');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw Invalid('Webhook URL resolves to a private address');
  return url;
}

export class WebhookService {
  constructor(
    private readonly db: Database,
    private readonly encryptionKey: string,
    private readonly allowPrivate: boolean,
  ) {}

  async createEndpoint(p: { tenantId: string; resellerId: string; url: string; events: string[] }) {
    await assertSafeWebhookUrl(p.url, this.allowPrivate);
    const bad = p.events.filter((e) => e !== '*' && !WEBHOOK_EVENT_TYPES.includes(e as WebhookEventType));
    if (bad.length) throw Invalid(`Unknown event types: ${bad.join(', ')}`);
    const secret = `whsec_${randomToken(32)}`;
    const [row] = await this.db
      .insert(webhookEndpoints)
      .values({ tenantId: p.tenantId, resellerId: p.resellerId, url: p.url, events: p.events, encryptedSecret: encryptSecret(secret, this.encryptionKey) })
      .returning();
    const { encryptedSecret: _s, ...pub } = row;
    return { endpoint: pub, secret }; // secret shown once
  }

  async listEndpoints(resellerId: string) {
    const rows = await this.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.resellerId, resellerId));
    return rows.map(({ encryptedSecret: _s, ...r }) => r);
  }

  async deleteEndpoint(resellerId: string, id: string) {
    const rows = await this.db
      .update(webhookEndpoints)
      .set({ active: false })
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.resellerId, resellerId)))
      .returning();
    if (!rows.length) throw NotFound('Webhook endpoint');
  }

  /**
   * Transactional outbox: records the event and one delivery per subscribed endpoint
   * inside the caller's transaction. Returns delivery ids to enqueue after commit;
   * the worker's sweeper also picks up anything that was never enqueued.
   */
  async emit(tx: DbOrTx, p: { tenantId: string; resellerId: string | null; type: WebhookEventType; data: Record<string, unknown> }) {
    const id = `evt_${randomToken(16)}`;
    await tx.insert(webhookEvents).values({
      id,
      tenantId: p.tenantId,
      resellerId: p.resellerId,
      type: p.type,
      payload: { id, type: p.type, createdAt: new Date().toISOString(), data: p.data },
    });
    if (!p.resellerId) return { eventId: id, deliveryIds: [] as string[] };
    const endpoints = await tx
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.resellerId, p.resellerId), eq(webhookEndpoints.active, true)));
    const targets = endpoints.filter((e) => e.events.includes('*') || e.events.includes(p.type));
    if (!targets.length) return { eventId: id, deliveryIds: [] as string[] };
    const rows = await tx
      .insert(webhookDeliveries)
      .values(targets.map((e) => ({ eventId: id, endpointId: e.id })))
      .returning({ id: webhookDeliveries.id });
    return { eventId: id, deliveryIds: rows.map((r) => r.id) };
  }

  /** Performs one delivery attempt. Throws on retryable failure so the queue applies backoff. */
  async deliver(deliveryId: string, fetchImpl: typeof fetch = fetch): Promise<'delivered' | 'skipped' | 'dead'> {
    const [row] = await this.db
      .select({ d: webhookDeliveries, e: webhookEvents, ep: webhookEndpoints })
      .from(webhookDeliveries)
      .innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.eventId))
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(eq(webhookDeliveries.id, deliveryId));
    if (!row || row.d.status === 'SUCCEEDED' || row.d.status === 'DEAD' || !row.ep.active) return 'skipped';

    const body = JSON.stringify(row.e.payload);
    const secret = decryptSecret(row.ep.encryptedSecret, this.encryptionKey);
    const attempts = row.d.attempts + 1;
    let status: number | undefined;
    let error: string | undefined;
    try {
      await assertSafeWebhookUrl(row.ep.url, this.allowPrivate);
      const res = await fetchImpl(row.ep.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'CloudPilot-Webhooks/1',
          'X-CloudPilot-Event': row.e.type,
          'X-CloudPilot-Event-Id': row.e.id,
          'X-CloudPilot-Delivery': row.d.id,
          'X-CloudPilot-Signature': signWebhook(secret, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message;
    }
    const succeeded = !error;
    const dead = !succeeded && attempts >= MAX_WEBHOOK_ATTEMPTS;
    await this.db
      .update(webhookDeliveries)
      .set({
        attempts,
        status: succeeded ? 'SUCCEEDED' : dead ? 'DEAD' : 'FAILED',
        lastStatusCode: status ?? null,
        lastError: error ?? null,
        deliveredAt: succeeded ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    if (succeeded) return 'delivered';
    if (dead) return 'dead';
    throw new Error(`Webhook delivery failed: ${error}`);
  }

  /** Manual redelivery from the portal (resets DEAD/FAILED). */
  async resetForRetry(resellerId: string, deliveryId: string) {
    const rows = await this.db.execute(sql`
      update webhook_deliveries d set status = 'PENDING', attempts = 0, updated_at = now()
        from webhook_endpoints e
       where d.id = ${deliveryId} and e.id = d.endpoint_id and e.reseller_id = ${resellerId}
         and d.status in ('FAILED','DEAD') returning d.id`);
    if (!rows.rows.length) throw NotFound('Retryable webhook delivery');
  }

  async deliveryLog(resellerId: string, limit = 100) {
    return this.db
      .select({
        id: webhookDeliveries.id,
        eventId: webhookDeliveries.eventId,
        type: webhookEvents.type,
        url: webhookEndpoints.url,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        lastStatusCode: webhookDeliveries.lastStatusCode,
        lastError: webhookDeliveries.lastError,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.eventId))
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(eq(webhookEndpoints.resellerId, resellerId))
      .orderBy(sql`${webhookDeliveries.createdAt} desc`)
      .limit(limit);
  }

  /** Outbox sweeper: deliveries that are PENDING/FAILED and idle for > 1 minute. */
  async staleDeliveryIds(limit = 200) {
    const rows = await this.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(and(inArray(webhookDeliveries.status, ['PENDING', 'FAILED']), lt(webhookDeliveries.updatedAt, sql`now() - interval '1 minute'`)))
      .limit(limit);
    return rows.map((r) => r.id);
  }
}
