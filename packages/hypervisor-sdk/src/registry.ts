import { MockHypervisorAdapter, type MockFailureConfig, type MockStateStore } from './mock/mock-adapter';
import { ProxmoxAdapter } from './proxmox/proxmox-adapter';
import type { HypervisorAdapter, ProviderConnectionConfig } from './types';

export type ProviderType = 'mock' | 'proxmox' | 'vmware' | 'xcpng' | 'hyperv' | 'openstack' | 'libvirt';

/** Provider types with a working adapter. Others are roadmap items and are rejected explicitly. */
export const IMPLEMENTED_PROVIDERS: ProviderType[] = ['mock', 'proxmox'];

export interface AdapterFactoryDeps {
  mockStore: MockStateStore;
  log?: (msg: string) => void;
}

export function createAdapter(
  type: string,
  providerId: string,
  config: ProviderConnectionConfig,
  deps: AdapterFactoryDeps,
): HypervisorAdapter {
  switch (type) {
    case 'mock':
      return new MockHypervisorAdapter(deps.mockStore, providerId, (config.options?.failures ?? {}) as MockFailureConfig);
    case 'proxmox':
      return new ProxmoxAdapter(config, deps.log);
    default:
      throw new Error(`Provider type "${type}" has no adapter implementation yet`);
  }
}
