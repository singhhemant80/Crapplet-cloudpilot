import {
  createAdapter,
  IMPLEMENTED_PROVIDERS,
  type HypervisorAdapter,
  type MockStateStore,
} from '@cloudpilot/hypervisor-sdk';
import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Database } from '../../db/client';
import {
  hypervisorNetworks,
  hypervisorNodes,
  hypervisorProviders,
  hypervisorStorages,
  locations,
  osTemplates,
} from '../../db/schema';
import { decryptSecret, encryptSecret } from '../../common/crypto';
import { Invalid, NotFound } from '../../common/errors';

export class RedisMockStore implements MockStateStore {
  constructor(private readonly redis: Redis) {}
  get(key: string) {
    return this.redis.get(key);
  }
  async set(key: string, value: string) {
    await this.redis.set(key, value);
  }
  incr(key: string) {
    return this.redis.incr(key);
  }
}

export interface CreateProviderInput {
  tenantId: string;
  locationId: string;
  name: string;
  type: string;
  endpoint: string;
  credentials: Record<string, string>;
  caCertificate?: string;
  allowInsecureTls?: boolean;
  options?: Record<string, unknown>;
}

type ProviderRow = typeof hypervisorProviders.$inferSelect;

/** Strips secrets: provider rows leaving this service never include credentials. */
export function publicProvider(p: ProviderRow) {
  const { encryptedCredentials: _omit, ...rest } = p;
  return { ...rest, hasCaCertificate: Boolean(p.caCertificate), caCertificate: undefined };
}

export class HypervisorService {
  constructor(
    private readonly db: Database,
    private readonly encryptionKey: string,
    private readonly mockStore: MockStateStore,
    private readonly opts: { allowMock: boolean; log?: (m: string) => void },
  ) {}

  async create(input: CreateProviderInput) {
    if (!IMPLEMENTED_PROVIDERS.includes(input.type as never)) {
      throw Invalid(`Provider type "${input.type}" is not implemented yet. Implemented: ${IMPLEMENTED_PROVIDERS.join(', ')}`);
    }
    if (input.type === 'mock' && !this.opts.allowMock) throw Invalid('Mock providers are disabled in production');
    const [loc] = await this.db.select().from(locations).where(and(eq(locations.id, input.locationId), eq(locations.tenantId, input.tenantId)));
    if (!loc) throw NotFound('Location');
    const [row] = await this.db
      .insert(hypervisorProviders)
      .values({
        tenantId: input.tenantId,
        locationId: input.locationId,
        name: input.name,
        type: input.type,
        endpoint: input.endpoint,
        encryptedCredentials: encryptSecret(JSON.stringify(input.credentials), this.encryptionKey),
        caCertificate: input.caCertificate,
        allowInsecureTls: input.allowInsecureTls ?? false,
        options: input.options ?? {},
      })
      .returning();
    // Validate this adapter can be constructed (catches bad endpoints/token formats early).
    this.adapterFor(row);
    return row;
  }

  async get(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(hypervisorProviders)
      .where(and(eq(hypervisorProviders.id, id), eq(hypervisorProviders.tenantId, tenantId)));
    if (!row) throw NotFound('Hypervisor provider');
    return row;
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(hypervisorProviders).where(eq(hypervisorProviders.id, id));
    if (!row) throw NotFound('Hypervisor provider');
    return row;
  }

  list(tenantId: string) {
    return this.db.select().from(hypervisorProviders).where(eq(hypervisorProviders.tenantId, tenantId));
  }

  adapterFor(row: ProviderRow): HypervisorAdapter {
    const credentials = JSON.parse(decryptSecret(row.encryptedCredentials, this.encryptionKey)) as Record<string, string>;
    try {
      return createAdapter(
        row.type,
        row.id,
        {
          endpoint: row.endpoint,
          credentials,
          caCertificate: row.caCertificate ?? undefined,
          allowInsecureTls: row.allowInsecureTls,
          options: row.options as Record<string, unknown>,
        },
        { mockStore: this.mockStore, log: this.opts.log },
      );
    } catch (e) {
      throw Invalid((e as Error).message);
    }
  }

  async testConnection(tenantId: string, id: string) {
    const row = await this.get(tenantId, id);
    const result = await this.adapterFor(row).validateConnection();
    await this.db
      .update(hypervisorProviders)
      .set({
        status: result.ok ? 'CONNECTED' : 'ERROR',
        version: result.version ?? row.version,
        lastError: result.ok ? null : (result.message ?? 'unknown error'),
        lastCheckedAt: new Date(),
      })
      .where(eq(hypervisorProviders.id, id));
    return result;
  }

  /** Pulls nodes, storage, bridges and templates from the provider into the inventory tables. */
  async discover(tenantId: string, id: string) {
    const row = await this.get(tenantId, id);
    const adapter = this.adapterFor(row);
    const [nodes, storage, networks, templates] = await Promise.all([
      adapter.listNodes(),
      adapter.listStorage(),
      adapter.listNetworks(),
      adapter.listTemplates(),
    ]);
    await this.db.transaction(async (tx) => {
      for (const n of nodes) {
        const values = {
          providerId: id,
          name: n.name,
          status: n.status,
          cpuCores: n.cpuCores,
          cpuUsage: n.cpuUsage,
          memoryTotalBytes: n.memoryTotalBytes,
          memoryUsedBytes: n.memoryUsedBytes,
          lastSeenAt: new Date(),
        };
        await tx.insert(hypervisorNodes).values(values).onConflictDoUpdate({ target: [hypervisorNodes.providerId, hypervisorNodes.name], set: values });
      }
      for (const s of storage) {
        const values = {
          providerId: id,
          node: s.node,
          externalId: s.id,
          type: s.type,
          contentTypes: s.contentTypes,
          totalBytes: s.totalBytes,
          usedBytes: s.usedBytes,
          shared: s.shared,
          active: s.active,
        };
        await tx
          .insert(hypervisorStorages)
          .values(values)
          .onConflictDoUpdate({ target: [hypervisorStorages.providerId, hypervisorStorages.node, hypervisorStorages.externalId], set: values });
      }
      for (const n of networks) {
        const values = { providerId: id, node: n.node, externalId: n.id, type: n.type, vlanAware: n.vlanAware, active: n.active };
        await tx
          .insert(hypervisorNetworks)
          .values(values)
          .onConflictDoUpdate({ target: [hypervisorNetworks.providerId, hypervisorNetworks.node, hypervisorNetworks.externalId], set: values });
      }
      for (const t of templates) {
        const values = {
          providerId: id,
          externalId: t.id,
          node: t.node,
          name: t.name,
          kind: t.kind,
          osFamily: /win/i.test(t.name) ? 'windows' : 'linux',
        };
        await tx
          .insert(osTemplates)
          .values(values)
          .onConflictDoUpdate({ target: [osTemplates.providerId, osTemplates.externalId], set: { name: t.name, node: t.node, kind: t.kind } });
      }
      await tx
        .update(hypervisorProviders)
        .set({ status: 'CONNECTED', lastCheckedAt: new Date(), lastError: null })
        .where(eq(hypervisorProviders.id, id));
    });
    return { nodes: nodes.length, storage: storage.length, networks: networks.length, templates: templates.length };
  }

  async inventory(tenantId: string, id: string) {
    await this.get(tenantId, id);
    const [nodes, storages, networks, templates] = await Promise.all([
      this.db.select().from(hypervisorNodes).where(eq(hypervisorNodes.providerId, id)),
      this.db.select().from(hypervisorStorages).where(eq(hypervisorStorages.providerId, id)),
      this.db.select().from(hypervisorNetworks).where(eq(hypervisorNetworks.providerId, id)),
      this.db.select().from(osTemplates).where(eq(osTemplates.providerId, id)),
    ]);
    return { nodes, storages, networks, templates };
  }
}
