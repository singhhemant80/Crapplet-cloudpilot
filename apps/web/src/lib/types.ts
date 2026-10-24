/** Response shapes of the CloudPilot API (money fields are minor-unit strings). */

export interface Balances {
  currency: string;
  availableMinor: string;
  reservedMinor: string;
  promoMinor: string;
  creditLimitMinor: string;
  creditUsedMinor: string;
  spendableMinor: string;
}

export interface OrderRow {
  id: string;
  number: number;
  status: string;
  source: string;
  hostname: string;
  cycle: string;
  currency: string;
  wholesaleMinor: string;
  setupFeeMinor: string;
  retailMinor: string | null;
  retailCurrency: string | null;
  failureReason: string | null;
  resellerId: string | null;
  productName: string;
  createdAt: string;
}

export interface OrderDetail extends Omit<OrderRow, 'productName'> {
  idempotencyKey: string;
  attempts: number;
  events: Array<{ id: string; status: string; message: string; createdAt: string }>;
  service: ServiceRow | null;
  product: { name: string; sku: string };
  ips: Array<{ address: string; status: string; version: number }>;
}

export interface ServiceRow {
  id: string;
  orderId: string;
  status: string;
  hostname: string;
  vmName?: string;
  cycle: string;
  nextDueDate: string | null;
  renewalMinor: string;
  currency: string;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  productName?: string;
  resellerId?: string | null;
  createdAt: string;
}

export interface ServiceDetail extends ServiceRow {
  product: { name: string; sku: string };
  ips: Array<{ address: string; status: string; version: number }>;
  username: string;
  node: string | null;
  externalVmId: string | null;
  suspendedReason: string | null;
}

export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  type: string;
  description: string;
  specs: { cpuCores: number; memoryMb: number; diskGb: number; bandwidthGb: number | null; ipv4: number; ipv6: number };
  pricing: Array<{ cycle: string; amountMinor: string; setupFeeMinor: string; currency: string }>;
  locations: Array<{ id: string; code: string; name: string; ipv4PoolId: string | null; templates: Array<{ id: string; name: string; osFamily: string }> }>;
}

export interface Deposit {
  id: string;
  method: string;
  gateway: string | null;
  amountMinor: string;
  currency: string;
  status: string;
  bankReference: string | null;
  proofNote: string | null;
  source: string;
  rejectReason: string | null;
  createdAt: string;
}

export interface LedgerLine {
  transactionId: string;
  type: string;
  memo: string;
  account: string;
  amountMinor: string;
  balanceAfterMinor: string;
  currency: string;
  createdAt: string;
  sourceType: string;
  sourceId: string;
}

export const ORDER_FLOW = ['PAID_OR_AUTHORIZED', 'QUEUED', 'PROVISIONING', 'CONFIGURING_NETWORK', 'VERIFYING', 'ACTIVE'] as const;
export const IN_FLIGHT = ['QUEUED', 'PROVISIONING', 'CONFIGURING_NETWORK', 'VERIFYING'];
