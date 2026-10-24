import { Queue, QueueEvents } from 'bullmq';
import type Redis from 'ioredis';
import { QUEUE_NAMES, type JobQueue, type OperationResult, type ServiceOperation } from './queue';

/** Producer side of the durable queues (used by the API process). */
export class BullMqQueue implements JobQueue {
  private readonly provisioning: Queue;
  private readonly webhooks: Queue;
  private readonly serviceOps: Queue;
  private readonly opsEvents: QueueEvents;

  constructor(connection: Redis, private readonly maxProvisionAttempts: number) {
    const opts = { connection };
    this.provisioning = new Queue(QUEUE_NAMES.provisioning, opts);
    this.webhooks = new Queue(QUEUE_NAMES.webhooks, opts);
    this.serviceOps = new Queue(QUEUE_NAMES.serviceOps, opts);
    this.opsEvents = new QueueEvents(QUEUE_NAMES.serviceOps, { connection: connection.duplicate() });
  }

  async enqueueProvision(orderId: string) {
    // Deterministic job id: duplicate enqueues collapse while the job is waiting/active.
    await this.provisioning.add(
      'provision',
      { orderId },
      {
        jobId: `provision-${orderId}`,
        attempts: this.maxProvisionAttempts,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true, // failure details live in order_events; keeps re-enqueue possible
      },
    );
  }

  async enqueueWebhookDelivery(deliveryId: string) {
    await this.webhooks.add(
      'deliver',
      { deliveryId },
      { jobId: `wh-${deliveryId}`, attempts: 8, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: true },
    );
  }

  async runServiceOperation(op: ServiceOperation, opKey: string, waitMs: number): Promise<OperationResult> {
    const job = await this.serviceOps.add(op.action, op, {
      jobId: `op-${opKey}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 24 * 3600 },
    });
    try {
      const result = await job.waitUntilFinished(this.opsEvents, waitMs);
      return { done: true, operationId: job.id!, result };
    } catch (err) {
      const msg = (err as Error).message;
      if (/timed out/i.test(msg)) return { done: false, operationId: job.id! };
      const [code, ...rest] = msg.split(': ');
      return { done: true, operationId: job.id!, error: { code: rest.length ? code : 'operation_failed', message: rest.join(': ') || msg } };
    }
  }

  async operationStatus(opId: string): Promise<OperationResult | null> {
    const job = await this.serviceOps.getJob(opId);
    if (!job) return null;
    const state = await job.getState();
    if (state === 'completed') return { done: true, operationId: opId, result: job.returnvalue };
    if (state === 'failed') return { done: true, operationId: opId, error: { code: 'operation_failed', message: job.failedReason } };
    return { done: false, operationId: opId };
  }

  async close() {
    await Promise.all([this.provisioning.close(), this.webhooks.close(), this.serviceOps.close(), this.opsEvents.close()]);
  }
}
