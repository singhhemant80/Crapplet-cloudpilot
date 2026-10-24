import { DomainError } from '../../common/errors';
import type { Container } from '../../container';
import { RetryLaterError } from '../provisioning/provisioning.service';
import type { JobQueue, OperationResult, ServiceOperation } from './queue';

/**
 * Test/dev queue that runs jobs in-process. `mode: 'manual'` records jobs so a
 * test can run them explicitly (to simulate duplicates, crashes, retries).
 */
export class InlineQueue implements JobQueue {
  provisionJobs: string[] = [];
  webhookJobs: string[] = [];

  constructor(
    private readonly c: Omit<Container, 'queue'>,
    private readonly mode: 'manual' | 'immediate' = 'manual',
  ) {}

  async enqueueProvision(orderId: string) {
    this.provisionJobs.push(orderId);
    if (this.mode === 'immediate') await this.runProvision(orderId);
  }

  async enqueueWebhookDelivery(deliveryId: string) {
    this.webhookJobs.push(deliveryId);
  }

  /** Runs a provisioning job; re-runs on RetryLaterError like the real queue would. */
  async runProvision(orderId: string, maxRuns = 10) {
    for (let i = 0; i < maxRuns; i++) {
      try {
        return await this.c.provisioning.run(orderId);
      } catch (err) {
        if (!(err instanceof RetryLaterError)) throw err;
      }
    }
    throw new Error('exceeded runs');
  }

  async runServiceOperation(op: ServiceOperation, opKey: string): Promise<OperationResult> {
    try {
      return { done: true, operationId: opKey, result: await this.c.serviceOps.execute(op) };
    } catch (err) {
      if (err instanceof DomainError) return { done: true, operationId: opKey, error: { code: err.code, message: err.message } };
      return { done: true, operationId: opKey, error: { code: 'operation_failed', message: (err as Error).message } };
    }
  }
}
