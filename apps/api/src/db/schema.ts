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
export const invoiceStatus = pgEnum('invoice_status', ['DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'REFUNDED']);
export const invoiceKind = pgEnum('invoice_kind', ['NEW_ORDER', 'RENEWAL', 'UPGRADE', 'MANUAL']);
export const taxType = pgEnum('tax_type', ['INTRA', 'INTER', 'EXPORT', 'NONE']);
export const paymentStatus = pgEnum('payment_status', ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']);
export const ticketStatus = pgEnum('ticket_status', ['OPEN', 'ANSWERED', 'CUSTOMER_REPLY', 'ON_HOLD', 'CLOSED']);
export const ticketPriority = pgEnum('ticket_priority', ['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
export const emailStatus = pgEnum('email_status', ['QUEUED', 'SENT', 'FAILED']);

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
    // Billing profile (GST invoices)
    companyName: text(),
    phone: text(),
    address1: text(),
    address2: text(),
    city: text(),
    state: text(),
    /** Two-digit GST state code (e.g. 27 Maharashtra); decides CGST+SGST vs IGST. */
    stateCode: char({ length: 2 }),
    country: char({ length: 2 }).notNull().default('IN'),
    postalCode: text(),
    gstin: text(),
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
    /** SAC 998315 = hosting and IT infrastructure provisioning services. */
    hsnSac: text().notNull().default('998315'),
    /** GST rate in basis points (1800 = 18%). Per product, never hard-coded. */
    gstRateBp: integer().notNull().default(1800),
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
    /** Prices shown to direct customers in the store. */
    isDefaultRetail: boolean().notNull().default(false),
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

// ─────────────────────────────────────────────── billing (direct customers)

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    tenantId: uuid().notNull(),
    customerId: uuid().notNull().references(() => customers.id),
    /** Assigned only when issued, sequential per financial year (GST rule 46). */
    number: text(),
    financialYear: text(),
    status: invoiceStatus().notNull().default('DRAFT'),
    kind: invoiceKind().notNull(),
    currency: currency().notNull(),
    issueDate: ts(),
    dueDate: ts(),
    subtotalMinor: money().notNull().default(sql`0`),
    cgstMinor: money().notNull().default(sql`0`),
    sgstMinor: money().notNull().default(sql`0`),
    igstMinor: money().notNull().default(sql`0`),
    taxMinor: money().notNull().default(sql`0`),
    totalMinor: money().notNull().default(sql`0`),
    paidMinor: money().notNull().default(sql`0`),
    taxType: taxType().notNull().default('NONE'),
    placeOfSupply: text(),
    sellerGstin: text(),
    buyerGstin: text(),
    buyerName: text().notNull(),
    buyerAddress: text().notNull().default(''),
    orderId: uuid(),
    serviceId: uuid(),
    periodStart: ts(),
    periodEnd: ts(),
    notes: text().notNull().default(''),
    paidAt: ts(),
    voidedAt: ts(),
    reminderSentAt: ts(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex().on(t.tenantId, t.number),
    index().on(t.customerId, t.createdAt),
    index().on(t.status, t.dueDate),
    // One renewal invoice per service period.
    uniqueIndex('invoices_renewal_period_uq').on(t.serviceId, t.periodStart).where(sql`kind = 'RENEWAL' and status <> 'VOID'`),
  ],
);

export const invoiceLines = pgTable('invoice_lines', {
  id: id(),
  invoiceId: uuid().notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  description: text().notNull(),
  hsnSac: text(),
  quantity: integer().notNull().default(1),
  unitMinor: money().notNull(),
  amountMinor: money().notNull(),
  taxRateBp: integer().notNull().default(0),
  productId: uuid(),
  serviceId: uuid(),
  sortOrder: integer().notNull().default(0),
});

export const invoiceSequences = pgTable(
  'invoice_sequences',
  {
    tenantId: uuid().notNull(),
    financialYear: text().notNull(),
    next: integer().notNull().default(1),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.financialYear)],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    tenantId: uuid().notNull(),
    invoiceId: uuid().notNull().references(() => invoices.id),
    customerId: uuid().notNull(),
    gateway: text().notNull(), // sandbox | razorpay | manual
    amountMinor: money().notNull(),
    currency: currency().notNull(),
    status: paymentStatus().notNull().default('PENDING'),
    gatewayOrderId: text(),
    gatewayPaymentId: text(),
    reference: text(),
    recordedById: uuid(),
    paidAt: ts(),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.gateway, t.gatewayOrderId), uniqueIndex().on(t.gateway, t.gatewayPaymentId), index().on(t.invoiceId)],
);

// ─────────────────────────────────────────────── support

export const ticketDepartments = pgTable('ticket_departments', {
  id: id(),
  tenantId: uuid().notNull(),
  name: text().notNull(),
  description: text().notNull().default(''),
  sortOrder: integer().notNull().default(0),
  active: boolean().notNull().default(true),
});

export const tickets = pgTable(
  'tickets',
  {
    id: id(),
    tenantId: uuid().notNull(),
    number: serial().notNull(),
    departmentId: uuid().notNull().references(() => ticketDepartments.id),
    customerId: uuid().references(() => customers.id),
    resellerId: uuid().references(() => resellers.id),
    openedByUserId: uuid(),
    serviceId: uuid(),
    subject: text().notNull(),
    status: ticketStatus().notNull().default('OPEN'),
    priority: ticketPriority().notNull().default('MEDIUM'),
    lastReplyAt: created(),
    closedAt: ts(),
    createdAt: created(),
  },
  (t) => [index().on(t.tenantId, t.status, t.lastReplyAt), index().on(t.customerId), index().on(t.resellerId)],
);

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: id(),
    ticketId: uuid().notNull().references(() => tickets.id, { onDelete: 'cascade' }),
    authorType: text().notNull(), // STAFF | CUSTOMER | RESELLER | SYSTEM
    authorUserId: uuid(),
    authorName: text().notNull(),
    body: text().notNull(),
    /** Staff-only notes, never shown to customers or resellers. */
    internal: boolean().notNull().default(false),
    createdAt: created(),
  },
  (t) => [index().on(t.ticketId, t.createdAt)],
);

export const announcements = pgTable('announcements', {
  id: id(),
  tenantId: uuid().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  audience: text().notNull().default('ALL'), // ALL | CUSTOMERS | RESELLERS
  published: boolean().notNull().default(true),
  createdAt: created(),
});

// ─────────────────────────────────────────────── email

/** Admin overrides of the built-in templates (keys in modules/email/templates.ts). */
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: id(),
    tenantId: uuid().notNull(),
    key: text().notNull(),
    subject: text().notNull(),
    body: text().notNull(),
    updatedAt: created(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.key)],
);

/** Outbox: every notification is stored, then sent by the worker (and retried). */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: id(),
    tenantId: uuid().notNull(),
    toAddress: text().notNull(),
    subject: text().notNull(),
    body: text().notNull(),
    templateKey: text(),
    status: emailStatus().notNull().default('QUEUED'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    relatedType: text(),
    relatedId: text(),
    sentAt: ts(),
    createdAt: created(),
  },
  (t) => [index().on(t.status, t.createdAt), index().on(t.tenantId, t.createdAt)],
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

export const invoicesRelations = relations(invoices, ({ many }) => ({
  lines: many(invoiceLines),
  payments: many(payments),
}));
export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
}));
export const paymentsRelations = relations(payments, ({ one }) => ({
  invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }),
}));
export const ticketsRelations = relations(tickets, ({ many }) => ({
  messages: many(ticketMessages),
}));
export const ticketMessagesRelations = relations(ticketMessages, ({ one }) => ({
  ticket: one(tickets, { fields: [ticketMessages.ticketId], references: [tickets.id] }),
}));
