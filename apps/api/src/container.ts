import Redis from 'ioredis';
import type { MockStateStore } from '@cloudpilot/hypervisor-sdk';
import { createDatabase, type Database } from './db/client';
import type { Env } from './config/env';
import { LedgerService } from './modules/ledger/ledger.service';
import { IpamService } from './modules/ipam/ipam.service';
import { HypervisorService, RedisMockStore } from './modules/hypervisors/hypervisor.service';
import { CatalogService } from './modules/catalog/catalog.service';
import { WebhookService } from './modules/webhooks/webhook.service';
import { OrderService } from './modules/orders/order.service';
import { ProvisioningService } from './modules/provisioning/provisioning.service';
import { ServiceOpsService } from './modules/services/service-ops.service';
import { DepositService } from './modules/payments/deposit.service';
import { RazorpayGateway, SandboxGateway, type PaymentGateway } from './modules/payments/gateways';
import { AuthService } from './modules/auth/auth.service';
import { ResellerService } from './modules/resellers/reseller.service';
import type { JobQueue } from './modules/jobs/queue';
import { SettingsService } from './modules/settings/settings.service';
import { EmailService, SmtpTransport, type EmailTransport } from './modules/email/email.service';
import { customerNotifiers } from './modules/email/notifiers';
import { BillingService } from './modules/billing/billing.service';
import { SupportService } from './modules/support/support.service';
import { VpsExtrasService } from './modules/services/vps-extras.service';

/**
 * Composition root. Domain services are plain classes; the HTTP layer (NestJS),
 * the worker and the test-suite all build them through this one function so
 * behaviour is identical everywhere.
 */
export interface Container {
  env: Env;
  db: Database;
  redis: Redis;
  queue: JobQueue;
  ledger: LedgerService;
  ipam: IpamService;
  hypervisors: HypervisorService;
  catalog: CatalogService;
  webhooks: WebhookService;
  orders: OrderService;
  provisioning: ProvisioningService;
  serviceOps: ServiceOpsService;
  deposits: DepositService;
  sandboxGateway?: SandboxGateway;
  auth: AuthService;
  resellers: ResellerService;
  settings: SettingsService;
  email: EmailService;
  billing: BillingService;
  support: SupportService;
  extras: VpsExtrasService;
  close(): Promise<void>;
}

export interface ContainerOptions {
  queueFactory: (c: Omit<Container, 'queue'>) => JobQueue;
  mockStore?: MockStateStore;
  gateways?: PaymentGateway[];
  provisioning?: Partial<{ verifyAttempts: number; verifyIntervalMs: number }>;
  /** Override the email transport (tests use MemoryTransport). */
  emailTransport?: EmailTransport | null;
}

export function createContainer(env: Env, opts: ContainerOptions): Container {
  const { db, pool } = createDatabase(env.DATABASE_URL, env.NODE_ENV === 'test' ? 20 : 10);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  let queueRef: JobQueue | undefined;
  const afterCommit = async (ids: string[]) => {
    for (const id of ids) await queueRef!.enqueueWebhookDelivery(id);
  };

  const ledger = new LedgerService(db);
  const ipam = new IpamService(db);
  const hypervisors = new HypervisorService(db, env.APP_ENCRYPTION_KEY, opts.mockStore ?? new RedisMockStore(redis), {
    allowMock: env.NODE_ENV !== 'production',
    log: (m) => console.warn(m),
  });
  const catalog = new CatalogService(db);
  const webhooks = new WebhookService(db, env.APP_ENCRYPTION_KEY, Boolean(env.WEBHOOK_ALLOW_PRIVATE_TARGETS));
  const auth = new AuthService(db, env.JWT_SECRET);
  const resellers = new ResellerService(db, ledger, auth);

  const gateways = new Map<string, PaymentGateway>();
  let sandboxGateway: SandboxGateway | undefined;
  if (env.SANDBOX_GATEWAY_SECRET && env.NODE_ENV !== 'production') {
    sandboxGateway = new SandboxGateway(env.SANDBOX_GATEWAY_SECRET, env.PUBLIC_API_URL);
    gateways.set('sandbox', sandboxGateway);
  }
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET) {
    gateways.set('razorpay', new RazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET));
  }
  for (const g of opts.gateways ?? []) gateways.set(g.name, g);
  const deposits = new DepositService(db, ledger, webhooks, gateways, afterCommit);
  const settings = new SettingsService(db);
  const transport = opts.emailTransport !== undefined ? opts.emailTransport : env.SMTP_URL ? new SmtpTransport(env.SMTP_URL) : null;
  const email = new EmailService(db, settings, transport, env.MAIL_FROM);

  const partial = {
    env,
    db,
    redis,
    ledger,
    ipam,
    hypervisors,
    catalog,
    webhooks,
    auth,
    resellers,
    deposits,
    sandboxGateway,
    settings,
    email,
  } as Omit<Container, 'queue'>;

  // Late-bound queue: services call through a proxy so the queue can reference services.
  const queue: JobQueue = {
    enqueueProvision: (id) => queueRef!.enqueueProvision(id),
    enqueueWebhookDelivery: (id) => queueRef!.enqueueWebhookDelivery(id),
    runServiceOperation: (op, key, wait) => queueRef!.runServiceOperation(op, key, wait),
  };

  const orders = new OrderService(db, ledger, ipam, catalog, webhooks, queue, {
    encryptionKey: env.APP_ENCRYPTION_KEY,
    ipReservationMinutes: env.IP_RESERVATION_MINUTES,
  });
  const provisioning = new ProvisioningService(
    db,
    hypervisors,
    ipam,
    ledger,
    webhooks,
    {
      encryptionKey: env.APP_ENCRYPTION_KEY,
      maxAttempts: env.PROVISIONING_MAX_ATTEMPTS,
      verifyAttempts: opts.provisioning?.verifyAttempts ?? 20,
      verifyIntervalMs: opts.provisioning?.verifyIntervalMs ?? 15_000,
    },
    afterCommit,
  );
  const serviceOps = new ServiceOpsService(db, hypervisors, ipam, ledger, webhooks, afterCommit);
  const billing = new BillingService(db, settings, email, gateways, queue, ipam);
  const support = new SupportService(db, email, settings);
  deposits.setInvoicePaymentHandler(billing);
  orders.setInvoicing(billing);
  const notifiers = customerNotifiers(email, settings);
  provisioning.setNotifier(notifiers);
  serviceOps.setNotifier(notifiers);
  const extras = new VpsExtrasService(db, hypervisors, catalog, ledger, queue, redis, env.APP_ENCRYPTION_KEY);
  extras.setInvoicer(billing);
  serviceOps.setExtras(extras);

  Object.assign(partial, { orders, provisioning, serviceOps, billing, support, extras });
  queueRef = opts.queueFactory(partial);

  return {
    ...(partial as Omit<Container, 'queue'>),
    orders,
    provisioning,
    serviceOps,
    billing,
    support,
    extras,
    queue,
    async close() {
      await (queueRef as { close?: () => Promise<void> }).close?.();
      redis.disconnect();
      await pool.end();
    },
  };
}
