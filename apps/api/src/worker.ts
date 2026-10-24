import 'reflect-metadata';
import { ProviderError } from '@cloudpilot/hypervisor-sdk';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { loadEnv } from './config/env';
import { createContainer } from './container';
import { DomainError } from './common/errors';
import { BullMqQueue } from './modules/jobs/bullmq-queue';
import { QUEUE_NAMES, type ServiceOperation } from './modules/jobs/queue';
import { RetryLaterError } from './modules/provisioning/provisioning.service';

/**
 * Background worker process: provisioning, service operations, webhook delivery
 * and periodic maintenance. Run one or more replicas; BullMQ guarantees a job is
 * processed by one worker at a time, and every handler is idempotent.
 */
async function main() {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, base: { proc: 'worker' } });
  let producer: BullMqQueue | undefined;
  const c = createContainer(env, {
    queueFactory: (partial) => (producer = new BullMqQueue(partial.redis, env.PROVISIONING_MAX_ATTEMPTS)),
  });
  const connection = c.redis;

  const provisioning = new Worker(
    QUEUE_NAMES.provisioning,
    async (job) => {
      const { orderId } = job.data as { orderId: string };
      try {
        const out = await c.provisioning.run(orderId);
        log.info({ orderId, out }, 'provisioning finished');
        return out;
      } catch (err) {
        if (err instanceof RetryLaterError) {
          log.warn({ orderId, err: err.message }, 'provisioning attempt failed; will retry');
          throw err;
        }
        log.error({ orderId, err }, 'provisioning crashed');
        throw err;
      }
    },
    { connection, concurrency: 4, lockDuration: 10 * 60_000 },
  );

  const serviceOps = new Worker(
    QUEUE_NAMES.serviceOps,
    async (job) => {
      try {
        return await c.serviceOps.execute(job.data as ServiceOperation);
      } catch (err) {
        if (err instanceof DomainError) throw new UnrecoverableError(`${err.code}: ${err.message}`);
        if (err instanceof ProviderError && !err.retryable) throw new UnrecoverableError(`provider_error: ${err.message}`);
        throw err;
      }
    },
    // Reinstalls and resizes wait for the hypervisor; keep the lock long enough.
    { connection, concurrency: 8, lockDuration: 15 * 60_000 },
  );

  const webhooks = new Worker(
    QUEUE_NAMES.webhooks,
    async (job) => c.webhooks.deliver((job.data as { deliveryId: string }).deliveryId),
    { connection, concurrency: 16 },
  );

  // ── maintenance: outbox sweep, reservation cleanup, stuck orders, ledger reconciliation
  const maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, { connection });
  await maintenanceQueue.upsertJobScheduler('sweep', { every: 60_000 }, { name: 'sweep' });
  await maintenanceQueue.upsertJobScheduler('reconcile', { every: 3_600_000 }, { name: 'reconcile' });
  await maintenanceQueue.upsertJobScheduler('mail', { every: 20_000 }, { name: 'mail' });
  await maintenanceQueue.upsertJobScheduler('billing', { every: 15 * 60_000 }, { name: 'billing' });
  const maintenance = new Worker(
    QUEUE_NAMES.maintenance,
    async (job) => {
      if (job.name === 'sweep') {
        for (const id of await c.webhooks.staleDeliveryIds()) await producer!.enqueueWebhookDelivery(id);
        // Expired checkout reservations (not bound to an order) go back to the pool.
        await c.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('cloudpilot.ip_reason', 'checkout reservation expired', true)`);
          await tx.execute(sql`update ip_addresses set status = 'AVAILABLE', reservation_token = null, reserved_until = null,
            reserved_by_reseller_id = null where status = 'RESERVED' and order_id is null and reserved_until < now()`);
          await tx.execute(sql`update ip_addresses set status = 'AVAILABLE', quarantine_until = null, service_id = null, order_id = null
            where status = 'QUARANTINED' and quarantine_until < now()`);
        });
        // Orders that should be progressing but have no live job (e.g. Redis was flushed).
        const stuck = await c.db.execute(sql`select id from orders
          where status in ('QUEUED','PROVISIONING','CONFIGURING_NETWORK','VERIFYING') and updated_at < now() - interval '20 minutes' limit 50`);
        for (const r of stuck.rows) await producer!.enqueueProvision(r.id as string);
      }
      if (job.name === 'mail') {
        const r = await c.email.deliverPending(100);
        if (r.sent || r.failed) log.info(r, 'email outbox delivered');
      }
      if (job.name === 'billing') {
        // Renewal invoices, overdue reminders, suspension after grace, unpaid order expiry.
        const tenants = await c.db.execute(sql`select id from tenants`);
        for (const t of tenants.rows) {
          try {
            const r = await c.billing.runAutomation(t.id as string);
            log.info({ tenantId: t.id, ...r }, 'billing automation ran');
          } catch (err) {
            log.error({ tenantId: t.id, err }, 'billing automation failed');
          }
        }
      }
      if (job.name === 'reconcile') {
        const tenants = await c.db.execute(sql`select id from tenants`);
        for (const t of tenants.rows) {
          const report = await c.ledger.reconcile(t.id as string);
          if (!report.ok) log.error({ tenantId: t.id, problems: report.problems }, 'LEDGER RECONCILIATION FAILED');
          else log.info({ tenantId: t.id }, 'ledger reconciled');
        }
      }
    },
    { connection, concurrency: 1 },
  );

  for (const w of [provisioning, serviceOps, webhooks, maintenance]) {
    w.on('failed', (job, err) => log.warn({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'));
  }
  log.info('worker started');

  const shutdown = async () => {
    log.info('shutting down');
    await Promise.all([provisioning.close(), serviceOps.close(), webhooks.close(), maintenance.close(), maintenanceQueue.close()]);
    await c.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
