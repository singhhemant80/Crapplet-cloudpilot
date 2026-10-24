/**
 * Provider-neutral virtualization contract.
 *
 * Rules every adapter MUST follow:
 *  - Report capabilities truthfully. If an operation is not in `capabilities()`,
 *    calling it must throw UnsupportedOperationError — never simulate success.
 *  - Throw ProviderError on any provider-side failure. Never return a "success"
 *    shape for an operation the provider rejected or that timed out.
 *  - Creation must be idempotent with respect to `CreateInstanceSpec.name`:
 *    `findInstanceByName` lets the caller detect a VM created by a previous,
 *    interrupted attempt before creating another one.
 */

export type ResourceKind = 'vm' | 'lxc' | 'docker' | 'baremetal';

export type Capability =
  | 'discovery.nodes'
  | 'discovery.storage'
  | 'discovery.networks'
  | 'discovery.templates'
  | 'instance.create'
  | 'instance.clone'
  | 'instance.delete'
  | 'instance.power'
  | 'instance.resize'
  | 'instance.reinstall'
  | 'network.ipconfig'
  | 'network.vlan'
  | 'snapshot'
  | 'backup'
  | 'console.vnc'
  | 'metrics'
  | 'migration'
  | 'credentials.reset'
  | 'tasks';

export interface ProviderConnectionConfig {
  /** Base URL of the provider API, e.g. https://pve1.example.net:8006 */
  endpoint: string;
  /** Provider-specific credential bag. Always decrypted on the backend only. */
  credentials: Record<string, string>;
  /** PEM CA bundle for self-signed provider certificates. Preferred over disabling TLS. */
  caCertificate?: string;
  /** Development only. Adapters log a warning when enabled. */
  allowInsecureTls?: boolean;
  timeoutMs?: number;
  /** Free-form provider options (default storage, bridge, etc.). */
  options?: Record<string, unknown>;
}

export interface ConnectionCheck {
  ok: boolean;
  version?: string;
  message?: string;
}

export interface NodeInfo {
  name: string;
  status: 'online' | 'offline' | 'unknown';
  cpuCores?: number;
  cpuUsage?: number; // 0..1
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  uptimeSeconds?: number;
}

export interface StorageInfo {
  node: string;
  id: string;
  type: string;
  contentTypes: string[];
  totalBytes?: number;
  usedBytes?: number;
  active: boolean;
  shared: boolean;
}

export interface NetworkInfo {
  node: string;
  id: string; // e.g. vmbr0
  type: string;
  vlanAware: boolean;
  active: boolean;
  cidr?: string;
}

export interface TemplateInfo {
  id: string; // provider reference (Proxmox: vmid)
  node: string;
  name: string;
  kind: ResourceKind;
  cloudInit?: boolean;
}

export interface IpAssignment {
  version: 4 | 6;
  address: string;
  prefixLength: number;
  gateway?: string;
}

export interface CreateInstanceSpec {
  /** Deterministic, unique name. Used for idempotent re-detection. */
  name: string;
  kind: ResourceKind;
  node: string;
  templateId: string;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  storage?: string;
  bridge?: string;
  vlanTag?: number;
  /** Optional preferred provider id (Proxmox vmid). Adapter may allocate when absent. */
  preferredId?: string;
  ips: IpAssignment[];
  nameservers?: string[];
  sshKeys?: string[];
  username?: string;
  /** Plaintext password: passed straight to provider, never logged or persisted. */
  password?: string;
  tags?: string[];
}

export interface InstanceRef {
  node: string;
  id: string;
}

export type PowerState = 'running' | 'stopped' | 'paused' | 'unknown';

export interface InstanceStatus {
  ref: InstanceRef;
  name: string;
  power: PowerState;
  cpuCores?: number;
  memoryMb?: number;
  uptimeSeconds?: number;
  /** IPs reported from inside the guest (guest agent) when available. */
  guestIps?: string[];
  /** IP configuration as stored in provider config (cloud-init). */
  configuredIps?: string[];
  locked?: boolean;
}

export interface TaskRef {
  node: string;
  id: string;
}

export interface TaskStatus {
  done: boolean;
  ok: boolean;
  message?: string;
}

export interface ConsoleSession {
  protocol: 'vnc' | 'spice' | 'serial';
  /** Provider ticket. The backend proxies it; never hand provider tokens to browsers. */
  ticket: string;
  port?: number;
  expiresAt: Date;
}

export interface SnapshotInfo {
  name: string;
  description?: string;
  createdAt?: Date;
}

/** Where the backend proxy connects for a console session (never sent to browsers). */
export interface ConsoleUpstream {
  url: string;
  headers: Record<string, string>;
  caCertificate?: string;
  rejectUnauthorized: boolean;
}

export interface MetricsSample {
  at: Date;
  cpu?: number;
  memoryUsedBytes?: number;
  netInBytes?: number;
  netOutBytes?: number;
  diskReadBytes?: number;
  diskWriteBytes?: number;
}

export interface HypervisorAdapter {
  readonly providerType: string;
  capabilities(): ReadonlySet<Capability>;

  validateConnection(): Promise<ConnectionCheck>;
  listNodes(): Promise<NodeInfo[]>;
  listStorage(node?: string): Promise<StorageInfo[]>;
  listNetworks(node?: string): Promise<NetworkInfo[]>;
  listTemplates(): Promise<TemplateInfo[]>;

  findInstanceByName(name: string): Promise<InstanceRef | null>;
  createInstance(spec: CreateInstanceSpec): Promise<InstanceRef>;
  getInstanceStatus(ref: InstanceRef): Promise<InstanceStatus>;
  start(ref: InstanceRef): Promise<void>;
  stop(ref: InstanceRef): Promise<void>;
  shutdown(ref: InstanceRef): Promise<void>;
  reboot(ref: InstanceRef): Promise<void>;
  deleteInstance(ref: InstanceRef): Promise<void>;
  configureNetwork(ref: InstanceRef, ips: IpAssignment[], opts?: { bridge?: string; vlanTag?: number; nameservers?: string[] }): Promise<void>;
  resize(ref: InstanceRef, spec: { cpuCores?: number; memoryMb?: number; diskGb?: number }): Promise<void>;
  createSnapshot(ref: InstanceRef, name: string, description?: string): Promise<void>;
  listSnapshots(ref: InstanceRef): Promise<SnapshotInfo[]>;
  rollbackSnapshot(ref: InstanceRef, name: string): Promise<void>;
  deleteSnapshot(ref: InstanceRef, name: string): Promise<void>;
  openConsole(ref: InstanceRef): Promise<ConsoleSession>;
  /** WebSocket endpoint for a console session opened with openConsole (capability 'console.vnc'). */
  consoleUpstream(ref: InstanceRef, session: ConsoleSession): ConsoleUpstream;
  getMetrics(ref: InstanceRef, timeframe: 'hour' | 'day' | 'week'): Promise<MetricsSample[]>;
}
