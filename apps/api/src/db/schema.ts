/**
 * CloudPilot primary schema (PostgreSQL, Drizzle ORM).
 *
 * Conventions
 *  - Money is BigInt minor units (paise/cents) — never floating point.
 *  - Columns are snake_case in SQL (drizzle `casing: 'snake_case'`).
 *  - Ledger tables are append-only and zero-sum; enforced by triggers in
 *    drizzle/0001_integrity.sql, not only by application code.
 */
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid().primaryKey().defaultRandom();
const money = () => bigint({ mode: 'bigint' });
const ts = () => timestamp({ withTimezone: true, mode: 'date' });
const created = () => ts().notNull().defaultNow();
const currency = () => char({ length: 3 });

// ─────────────────────────────────────────────── enums

export const userRole = pgEnum('user_role', ['PLATFORM_ADMIN', 'TENANT_ADMIN', 'STAFF', 'RESELLER_ADMIN', 'CUSTOMER']);
export const userStatus = pgEnum('user_status', ['ACTIVE', 'DISABLED']);
export const resellerStatus = pgEnum('reseller_status', ['PENDING', 'ACTIVE', 'SUSPENDED']);
export const resellerModel = pgEnum('reseller_model', ['PREPAID', 'CREDIT', 'COMMISSION']);
export const customerOwnership = pgEnum('customer_ownership', ['RESELLER_OWNED', 'CENTRAL']);
export const providerStatus = pgEnum('provider_status', ['UNVERIFIED', 'CONNECTED', 'ERROR', 'DISABLED']);
export const productType = pgEnum('product_type', [
  'VPS_LINUX', 'VPS_WINDOWS', 'VPS_FOREX', 'VPS_MINECRAFT', 'GPU_CLOUD', 'SHARED_HOSTING', 'RESELLER_HOSTING',
  'DEDICATED', 'COLOCATION', 'OBJECT_STORAGE', 'BACKUP_STORAGE', 'IP_ADDON', 'BANDWIDTH_ADDON', 'SSL', 'DOMAIN', 'CUSTOM',
]);
export const provisioningMode = pgEnum('provisioning_mode', ['AUTOMATIC', 'MANUAL_APPROVAL']);
export const productStatus = pgEnum('product_status', ['DRAFT', 'ACTIVE', 'RETIRED']);
export const billingCycle = pgEnum('billing_cycle', ['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']);
export const ipStatus = pgEnum('ip_status', ['AVAILABLE', 'RESERVED', 'ALLOCATED', 'QUARANTINED', 'RETIRED']);
export const ledgerAccountKind = pgEnum('ledger_account_kind', [
  'RESELLER_AVAILABLE', 'RESELLER_RESERVED', 'RESELLER_CREDIT', 'RESELLER_PROMO',
  'SYSTEM_GATEWAY_CLEARING', 'SYSTEM_BANK_CLEARING', 'SYSTEM_REVENUE', 'SYSTEM_ADJUSTMENTS', 'SYSTEM_PROMO_EXPENSE',
]);
export const ledgerTxType = pgEnum('ledger_tx_type', [
  'DEPOSIT', 'HOLD', 'CAPTURE', 'RELEASE', 'CHARGE', 'REFUND', 'ADJUSTMENT', 'PROMO_GRANT', 'REVERSAL',
]);
export const holdStatus = pgEnum('hold_status', ['HELD', 'CAPTURED', 'RELEASED']);
export const depositMethod = pgEnum('deposit_method', ['GATEWAY', 'BANK_TRANSFER', 'MANUAL_ADJUSTMENT', 'PROMO']);
export const depositStatus = pgEnum('deposit_status', ['AWAITING_PAYMENT', 'UNDER_REVIEW', 'CREDITED', 'REJECTED', 'FAILED', 'EXPIRED']);
export const orderSource = pgEnum('order_source', ['PORTAL', 'API', 'WHMCS', 'ADMIN']);
export const orderStatus = pgEnum('order_status', [
  'PENDING_PAYMENT', 'PAID_OR_AUTHORIZED', 'QUEUED', 'PROVISIONING', 'CONFIGURING_NETWORK', 'VERIFYING',
  'ACTIVE', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED',
]);
export const serviceStatus = pgEnum('service_status', [
  'PENDING', 'PROVISIONING', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'FAILED', 'NEEDS_ATTENTION',
]);
export const integrationPlatform = pgEnum('integration_platform', ['WHMCS', 'BLESTA', 'HOSTBILL', 'WISECP', 'CLIENTEXEC', 'CUSTOM']);
export const deliveryStatus = pgEnum('delivery_status', ['PENDING', 'SUCCEEDED', 'FAILED', 'DEAD']);

// ─────────────────────────────────────────────── tenancy & identity

export const tenants = pgTable('tenants', {
  id: id(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  brandName: text().notNull().default('CloudPilot'),
  settings: jsonb().notNull().default({}),
  createdAt: created(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: uuid().notNull().references(() => tenants.id),
    email: text().notNull(),
    name: text().notNull(),
    passwordHash: text().notNull(),
    role: userRole().notNull(),
    status: userStatus().notNull().default('ACTIVE'),
    resellerId: uuid().references(() => resellers.id),
    customerId: uuid().references(() => customers.id),
    failedLogins: integer().notNull().default(0),
    lockedUntil: ts(),
    lastLoginAt: ts(),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.email)],
);

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid().notNull().references(() => users.id),
  tokenHash: text().notNull().unique(),
  expiresAt: ts().notNull(),
  revokedAt: ts(),
  ip: text(),
  userAgent: text(),
  createdAt: created(),
});

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    tenantId: uuid().notNull(),
    actorType: text().notNull(), // user | api_key | system
    actorId: text(),
    resellerId: uuid(),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    ip: text(),
    metadata: jsonb().notNull().default({}),
    createdAt: created(),
  },
  (t) => [index().on(t.tenantId, t.createdAt), index().on(t.resellerId, t.createdAt)],
);

// ─────────────────────────────────────────────── resellers & customers

export const resellers = pgTable('resellers', {
  id: id(),
  tenantId: uuid().notNull().references(() => tenants.id),
  name: text().notNull(),
  contactEmail: text().notNull(),
  status: resellerStatus().notNull().default('PENDING'),
  model: resellerModel().notNull().default('PREPAID'),
  currency: currency().notNull().default('INR'),
  creditLimitMinor: money().notNull().default(sql`0`),
  lowBalanceThresholdMinor: money().notNull().default(sql`0`),
  priceListId: uuid().references(() => priceLists.id),
  createdAt: created(),
});

export const customers = pgTable(
  'customers',
  {
    id: id(),
    tenantId: uuid().notNull(),
    resellerId: uuid().references(() => resellers.id),
    externalRef: text(),
    name: text().notNull(),
    email: text(),
    ownership: customerOwnership().notNull().default('CENTRAL'),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.resellerId, t.externalRef), index().on(t.tenantId)],
);

// ─────────────────────────────────────────────── infrastructure

export const locations = pgTable(
  'locations',
  {
    id: id(),
    tenantId: uuid().notNull(),
    code: text().notNull(),
    name: text().notNull(),
    country: char({ length: 2 }).notNull(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.code)],
);

export const hypervisorProviders = pgTable(
  'hypervisor_providers',
  {
    id: id(),
    tenantId: uuid().notNull(),
    locationId: uuid().notNull().references(() => locations.id),
    name: text().notNull(),
    type: text().notNull(),
    endpoint: text().notNull(),
    /** AES-256-GCM ciphertext. Never returned by any API. */
    encryptedCredentials: text().notNull(),
    caCertificate: text(),
    allowInsecureTls: boolean().notNull().default(false),
    options: jsonb().notNull().default({}),
    status: providerStatus().notNull().default('UNVERIFIED'),
    version: text(),
    lastCheckedAt: ts(),
    lastError: text(),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.name)],
);

export const hypervisorNodes = pgTable(
  'hypervisor_nodes',
  {
    id: id(),
    providerId: uuid().notNull().references(() => hypervisorProviders.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    status: text().notNull(),
    cpuCores: integer(),
    cpuUsage: doublePrecision(),
    memoryTotalBytes: bigint({ mode: 'number' }),
    memoryUsedBytes: bigint({ mode: 'number' }),
    lastSeenAt: created(),
  },
  (t) => [uniqueIndex().on(t.providerId, t.name)],
);

export const hypervisorStorages = pgTable(
  'hypervisor_storages',
  {
    id: id(),
    providerId: uuid().notNull().references(() => hypervisorProviders.id, { onDelete: 'cascade' }),
    node: text().notNull(),
    externalId: text().notNull(),
    type: text().notNull(),
    contentTypes: text().array().notNull(),
    totalBytes: bigint({ mode: 'number' }),
    usedBytes: bigint({ mode: 'number' }),
    shared: boolean().notNull(),
    active: boolean().notNull(),
  },
  (t) => [uniqueIndex().on(t.providerId, t.node, t.externalId)],
);

export const hypervisorNetworks = pgTable(
  'hypervisor_networks',
  {
    id: id(),
    providerId: uuid().notNull().references(() => hypervisorProviders.id, { onDelete: 'cascade' }),
    node: text().notNull(),
    externalId: text().notNull(),
    type: text().notNull(),
    vlanAware: boolean().notNull(),
    active: boolean().notNull(),
  },
  (t) => [uniqueIndex().on(t.providerId, t.node, t.externalId)],
);

export const osTemplates = pgTable(
  'os_templates',
  {
    id: id(),
    providerId: uuid().notNull().references(() => hypervisorProviders.id, { onDelete: 'cascade' }),
    externalId: text().notNull(),
    node: text().notNull(),
    name: text().notNull(),
    kind: text().notNull(),
    osFamily: text().notNull().default('linux'),
    enabled: boolean().notNull().default(true),
  },
  (t) => [uniqueIndex().on(t.providerId, t.externalId)],
);

// ─────────────────────────────────────────────── catalog & pricing

export const products = pgTable(
  'products',
  {
    id: id(),
    tenantId: uuid().notNull(),
    sku: text().notNull(),
    name: text().notNull(),
    type: productType().notNull(),
    description: text().notNull().default(''),
    status: productStatus().notNull().default('DRAFT'),
    provisioning: provisioningMode().notNull().default('AUTOMATIC'),
    cpuCores: integer(),
    memoryMb: integer(),
    diskGb: integer(),
    bandwidthGb: integer(),
    ipv4Count: integer().notNull().default(1),
    ipv6Count: integer().notNull().default(0),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.sku)],
);

/** Maps a commercial product to concrete infrastructure in one location. */
export const productPlacements = pgTable(
  'product_placements',
  {
    id: id(),
    productId: uuid().notNull().references(() => products.id, { onDelete: 'cascade' }),
    locationId: uuid().notNull().references(() => locations.id),
    providerId: uuid().notNull().references(() => hypervisorProviders.id),
    node: text().notNull(),
    storage: text(),
    bridge: text().notNull().default('vmbr0'),
    vlanTag: integer(),
    ipv4PoolId: uuid().references(() => ipPools.id),
    ipv6PoolId: uuid().references(() => ipPools.id),
    templateIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    enabled: boolean().notNull().default(true),
  },
  (t) => [uniqueIndex().on(t.productId, t.locationId)],
);

export const priceLists = pgTable(
  'price_lists',
  {
    id: id(),
    tenantId: uuid().notNull(),
    name: text().notNull(),
    currency: currency().notNull(),
    /** Applied to resellers that have no reseller-specific list. */
    isDefaultWholesale: boolean().notNull().default(false),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.name)],
);

export const prices = pgTable(
  'prices',
  {
    id: id(),
    priceListId: uuid().notNull().references(() => priceLists.id, { onDelete: 'cascade' }),
    productId: uuid().notNull().references(() => products.id, { onDelete: 'cascade' }),
    cycle: billingCycle().notNull(),
    amountMinor: money().notNull(),
    setupFeeMinor: money().notNull().default(sql`0`),
  },
  (t) => [uniqueIndex().on(t.priceListId, t.productId, t.cycle)],
);

// ─────────────────────────────────────────────── IPAM

export const ipPools = pgTable(
  'ip_pools',
  {
    id: id(),
    tenantId: uuid().notNull(),
    locationId: uuid().notNull().references(() => locations.id),
    name: text().notNull(),
    version: integer().notNull(),
    cidr: text().notNull(),
    prefixLength: integer().notNull(),
    gateway: text(),
    nameservers: text().array().notNull().default(sql`'{}'::text[]`),
    vlanTag: integer(),
    customerSelectable: boolean().notNull().default(true),
    quarantineHours: integer().notNull().default(72),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.name)],
);

export const ipAddresses = pgTable(
  'ip_addresses',
  {
    id: id(),
    tenantId: uuid().notNull(),
    poolId: uuid().notNull().references(() => ipPools.id, { onDelete: 'restrict' }),
    address: text().notNull(),
    status: ipStatus().notNull().default('AVAILABLE'),
    reservationToken: text().unique(),
    reservedUntil: ts(),
    reservedByResellerId: uuid(),
    orderId: uuid(),
    serviceId: uuid(),
    quarantineUntil: ts(),
    rdns: text(),
    updatedAt: created(),
  },
  (t) => [
    uniqueIndex().on(t.tenantId, t.address),
    index().on(t.poolId, t.status),
    index().on(t.serviceId),
    index().on(t.orderId),
  ],
);

export const ipAllocationEvents = pgTable('ip_allocation_events', {
  id: id(),
  ipAddressId: uuid().notNull().references(() => ipAddresses.id),
  fromStatus: ipStatus().notNull(),
  toStatus: ipStatus().notNull(),
  orderId: uuid(),
  serviceId: uuid(),
  reason: text().notNull(),
  createdAt: created(),
});

// ─────────────────────────────────────────────── ledger (double entry)

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: id(),
    tenantId: uuid().notNull(),
    code: text().notNull(),
    kind: ledgerAccountKind().notNull(),
    resellerId: uuid(),
    currency: currency().notNull(),
    balanceMinor: money().notNull().default(sql`0`),
    /** DB CHECK: balance_minor >= min_balance_minor (null = unbounded system account). */
    minBalanceMinor: money(),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.code, t.currency), index().on(t.resellerId)],
);

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: id(),
    tenantId: uuid().notNull(),
    resellerId: uuid(),
    type: ledgerTxType().notNull(),
    currency: currency().notNull(),
    amountMinor: money().notNull(),
    idempotencyKey: text().notNull(),
    sourceType: text().notNull(),
    sourceId: text().notNull(),
    actorType: text().notNull(),
    actorId: text(),
    memo: text().notNull().default(''),
    reversalOfId: uuid().unique(),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.idempotencyKey), index().on(t.resellerId, t.createdAt)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    transactionId: uuid().notNull().references(() => ledgerTransactions.id),
    accountId: uuid().notNull().references(() => ledgerAccounts.id),
    /** Signed; entries of one transaction sum to zero (deferred constraint trigger). */
    amountMinor: money().notNull(),
    balanceAfterMinor: money().notNull(),
    createdAt: created(),
  },
  (t) => [index().on(t.accountId, t.createdAt), index().on(t.transactionId)],
);

export const walletHolds = pgTable('wallet_holds', {
  id: id(),
  tenantId: uuid().notNull(),
  resellerId: uuid().notNull(),
  orderId: uuid().notNull().unique(),
  currency: currency().notNull(),
  amountMinor: money().notNull(),
  cashMinor: money().notNull(),
  creditMinor: money().notNull(),
  status: holdStatus().notNull().default('HELD'),
  createdAt: created(),
  settledAt: ts(),
});

export const deposits = pgTable(
  'deposits',
  {
    id: id(),
    tenantId: uuid().notNull(),
    resellerId: uuid().notNull().references(() => resellers.id),
    method: depositMethod().notNull(),
    gateway: text(),
    amountMinor: money().notNull(),
    currency: currency().notNull(),
    status: depositStatus().notNull(),
    bankReference: text(),
    proofNote: text(),
    gatewayOrderId: text(),
    gatewayPaymentId: text(),
    source: text().notNull().default('PORTAL'), // PORTAL | API | WHMCS
    externalRef: text(),
    reviewedById: uuid(),
    reviewedAt: ts(),
    rejectReason: text(),
    ledgerTransactionId: uuid(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex().on(t.gateway, t.gatewayOrderId),
    uniqueIndex().on(t.gateway, t.gatewayPaymentId),
    uniqueIndex().on(t.resellerId, t.externalRef),
    // A bank reference can only be claimed once per tenant (prevents double credit of one transfer).
    uniqueIndex('deposits_bank_reference_uq').on(t.tenantId, t.bankReference).where(sql`bank_reference is not null and status <> 'REJECTED'`),
    index().on(t.tenantId, t.status),
  ],
);

/** Every inbound gateway webhook, deduplicated by gateway event id. */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: id(),
    gateway: text().notNull(),
    eventId: text().notNull(),
    signatureValid: boolean().notNull(),
    payload: jsonb().notNull(),
    processedAt: ts(),
    result: text(),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.gateway, t.eventId)],
);

// ─────────────────────────────────────────────── orders & services

export const orders = pgTable(
  'orders',
  {
    id: id(),
    tenantId: uuid().notNull(),
    number: serial().notNull(),
    resellerId: uuid().references(() => resellers.id),
    customerId: uuid().references(() => customers.id),
    source: orderSource().notNull(),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    productId: uuid().notNull().references(() => products.id),
    locationId: uuid().notNull().references(() => locations.id),
    templateId: uuid().notNull().references(() => osTemplates.id),
    cycle: billingCycle().notNull(),
    hostname: text().notNull(),
    status: orderStatus().notNull(),
    currency: currency().notNull(),
    wholesaleMinor: money().notNull(),
    setupFeeMinor: money().notNull().default(sql`0`),
    retailMinor: money(),
    retailCurrency: currency(),
    failureReason: text(),
    /** Encrypted provisioning secrets (root password). Wiped when the order reaches a terminal state. */
    encryptedSecret: text(),
    sshKeys: text().array().notNull().default(sql`'{}'::text[]`),
    attempts: integer().notNull().default(0),
    createdAt: created(),
    updatedAt: created(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.resellerId, t.idempotencyKey), index().on(t.tenantId, t.status)],
);

export const orderEvents = pgTable(
  'order_events',
  {
    id: id(),
    orderId: uuid().notNull().references(() => orders.id, { onDelete: 'cascade' }),
    status: orderStatus().notNull(),
    message: text().notNull(),
    createdAt: created(),
  },
  (t) => [index().on(t.orderId, t.createdAt)],
);

export const services = pgTable(
  'services',
  {
    id: id(),
    tenantId: uuid().notNull(),
    resellerId: uuid().references(() => resellers.id),
    customerId: uuid().references(() => customers.id),
    orderId: uuid().notNull().unique().references(() => orders.id),
    productId: uuid().notNull().references(() => products.id),
    providerId: uuid().references(() => hypervisorProviders.id),
    status: serviceStatus().notNull().default('PENDING'),
    hostname: text().notNull(),
    /** Deterministic provider-side name; the idempotency handle for VM creation. */
    vmName: text().notNull().unique(),
    node: text(),
    externalVmId: text(),
    cpuCores: integer().notNull(),
    memoryMb: integer().notNull(),
    diskGb: integer().notNull(),
    username: text().notNull().default('cloud'),
    cycle: billingCycle().notNull(),
    renewalMinor: money().notNull(),
    currency: currency().notNull(),
    nextDueDate: ts(),
    suspendedReason: text(),
    terminatedAt: ts(),
    createdAt: created(),
    updatedAt: created(),
  },
  (t) => [index().on(t.tenantId, t.status), index().on(t.resellerId)],
);

export const serviceRenewals = pgTable(
  'service_renewals',
  {
    id: id(),
    serviceId: uuid().notNull().references(() => services.id),
    idempotencyKey: text().notNull(),
    periodStart: ts().notNull(),
    periodEnd: ts().notNull(),
    amountMinor: money().notNull(),
    ledgerTransactionId: uuid().notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.serviceId, t.idempotencyKey)],
);

// ─────────────────────────────────────────────── API & integrations

export const apiCredentials = pgTable('api_credentials', {
  id: id(),
  tenantId: uuid().notNull(),
  resellerId: uuid().references(() => resellers.id),
  name: text().notNull(),
  keyId: text().notNull().unique(),
  secretHash: text().notNull(),
  scopes: text().array().notNull(),
  ipAllowlist: text().array().notNull().default(sql`'{}'::text[]`),
  lastUsedAt: ts(),
  expiresAt: ts(),
  revokedAt: ts(),
  createdAt: created(),
});

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: id(),
    tenantId: uuid().notNull(),
    resellerId: uuid().notNull().references(() => resellers.id),
    platform: integrationPlatform().notNull(),
    name: text().notNull(),
    siteUrl: text(),
    lastSeenAt: ts(),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.resellerId, t.name)],
);

export const externalProductMappings = pgTable(
  'external_product_mappings',
  {
    id: id(),
    connectionId: uuid().notNull().references(() => integrationConnections.id, { onDelete: 'cascade' }),
    externalProductId: text().notNull(),
    productId: uuid().notNull().references(() => products.id),
    retailMinor: money(),
    retailCurrency: currency(),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.connectionId, t.externalProductId)],
);

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: id(),
  tenantId: uuid().notNull(),
  resellerId: uuid().notNull().references(() => resellers.id),
  url: text().notNull(),
  encryptedSecret: text().notNull(),
  events: text().array().notNull(),
  active: boolean().notNull().default(true),
  createdAt: created(),
});

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text().primaryKey(), // evt_<random>
    tenantId: uuid().notNull(),
    resellerId: uuid(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: created(),
  },
  (t) => [index().on(t.resellerId, t.createdAt)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    eventId: text().notNull().references(() => webhookEvents.id),
    endpointId: uuid().notNull().references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    status: deliveryStatus().notNull().default('PENDING'),
    attempts: integer().notNull().default(0),
    lastStatusCode: integer(),
    lastError: text(),
    deliveredAt: ts(),
    createdAt: created(),
    updatedAt: created(),
  },
  (t) => [uniqueIndex().on(t.eventId, t.endpointId)],
);

// ─────────────────────────────────────────────── relations (query API)

export const ordersRelations = relations(orders, ({ one, many }) => ({
  product: one(products, { fields: [orders.productId], references: [products.id] }),
  service: one(services, { fields: [orders.id], references: [services.orderId] }),
  events: many(orderEvents),
}));
export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
}));
export const servicesRelations = relations(services, ({ one }) => ({
  product: one(products, { fields: [services.productId], references: [products.id] }),
  order: one(orders, { fields: [services.orderId], references: [orders.id] }),
}));
export const productsRelations = relations(products, ({ many }) => ({
  placements: many(productPlacements),
  prices: many(prices),
}));
export const productPlacementsRelations = relations(productPlacements, ({ one }) => ({
  product: one(products, { fields: [productPlacements.productId], references: [products.id] }),
}));
export const pricesRelations = relations(prices, ({ one }) => ({
  product: one(products, { fields: [prices.productId], references: [products.id] }),
  priceList: one(priceLists, { fields: [prices.priceListId], references: [priceLists.id] }),
}));
export const ledgerTransactionsRelations = relations(ledgerTransactions, ({ many }) => ({
  entries: many(ledgerEntries),
}));
export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  transaction: one(ledgerTransactions, { fields: [ledgerEntries.transactionId], references: [ledgerTransactions.id] }),
  account: one(ledgerAccounts, { fields: [ledgerEntries.accountId], references: [ledgerAccounts.id] }),
}));
