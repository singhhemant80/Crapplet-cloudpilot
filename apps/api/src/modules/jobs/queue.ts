/**
 * Durable job abstraction. Production uses BullMQ (Redis); tests use an
 * inline implementation. Job ids are deterministic so that enqueueing the
 * same work twice (duplicate callbacks, retries) collapses into one job.
 */
export type ServiceAction =
  | 'start' | 'stop' | 'shutdown' | 'reboot' | 'suspend' | 'unsuspend' | 'terminate'
  | 'reinstall' | 'upgrade' | 'snapshot_create' | 'snapshot_rollback' | 'snapshot_delete';

export interface ServiceOperation {
  serviceId: string;
  action: ServiceAction;
  reason?: string;
  /**
   * Action parameters. Secrets (reinstall password) are AES-GCM encrypted here because
   * job payloads are stored in Redis.
   */
  params?: Record<string, string | number>;
  actor: { type: 'user' | 'api_key' | 'system'; id?: string | null };
}

export interface OperationResult {
  done: boolean;
  operationId: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface JobQueue {
  enqueueProvision(orderId: string): Promise<void>;
  enqueueWebhookDelivery(deliveryId: string): Promise<void>;
  /** Runs a service operation in the worker; waits up to `waitMs` for completion. */
  runServiceOperation(op: ServiceOperation, opKey: string, waitMs: number): Promise<OperationResult>;
}

export const QUEUE_NAMES = {
  provisioning: 'cp-provisioning',
  serviceOps: 'cp-service-ops',
  webhooks: 'cp-webhooks',
  maintenance: 'cp-maintenance',
} as const;
