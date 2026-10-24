import { and, eq, inArray } from 'drizzle-orm';
import type { Database, DbOrTx } from '../../db/client';
import {
  hypervisorProviders,
  ipPools,
  locations,
  osTemplates,
  priceLists,
  prices,
  productPlacements,
  products,
  resellers,
} from '../../db/schema';
import { DomainError, Invalid, NotFound } from '../../common/errors';

type Cycle = (typeof prices.$inferSelect)['cycle'];
type ProductInsert = typeof products.$inferInsert;

export interface ResolvedPrice {
  amountMinor: bigint;
  setupFeeMinor: bigint;
  currency: string;
  priceListId: string;
  source: 'reseller' | 'default';
}

export class CatalogService {
  constructor(private readonly db: Database) {}

  // ───────────────────────── products

  async createProduct(input: Omit<ProductInsert, 'id' | 'createdAt'>) {
    const isVps = input.type.startsWith('VPS') || input.type === 'GPU_CLOUD';
    if (isVps && (!input.cpuCores || !input.memoryMb || !input.diskGb)) {
      throw Invalid('VPS products need cpuCores, memoryMb and diskGb');
    }
    const [row] = await this.db.insert(products).values(input).returning();
    return row;
  }

  async updateProduct(tenantId: string, id: string, patch: Partial<ProductInsert>) {
    const { tenantId: _t, id: _i, ...safe } = patch;
    const [row] = await this.db
      .update(products)
      .set(safe)
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .returning();
    if (!row) throw NotFound('Product');
    return row;
  }

  async getProduct(tenantId: string, id: string) {
    const row = await this.db.query.products.findFirst({
      where: and(eq(products.id, id), eq(products.tenantId, tenantId)),
      with: { placements: true, prices: true },
    });
    if (!row) throw NotFound('Product');
    return row;
  }

  async getProductBySku(tenantId: string, sku: string) {
    const [row] = await this.db.select().from(products).where(and(eq(products.tenantId, tenantId), eq(products.sku, sku)));
    if (!row) throw NotFound(`Product ${sku}`);
    return row;
  }

  listProducts(tenantId: string) {
    return this.db.query.products.findMany({
      where: eq(products.tenantId, tenantId),
      with: { placements: true, prices: true },
      orderBy: (p, { asc }) => [asc(p.name)],
    });
  }

  /** Maps a product to infrastructure in one location; validates every reference belongs to the tenant. */
  async upsertPlacement(
    tenantId: string,
    productId: string,
    input: {
      locationId: string;
      providerId: string;
      node: string;
      storage?: string;
      bridge?: string;
      vlanTag?: number;
      ipv4PoolId?: string;
      ipv6PoolId?: string;
      templateIds: string[];
      enabled?: boolean;
    },
  ) {
    const product = await this.getProduct(tenantId, productId);
    const [loc] = await this.db.select().from(locations).where(and(eq(locations.id, input.locationId), eq(locations.tenantId, tenantId)));
    if (!loc) throw NotFound('Location');
    const [prov] = await this.db
      .select()
      .from(hypervisorProviders)
      .where(and(eq(hypervisorProviders.id, input.providerId), eq(hypervisorProviders.tenantId, tenantId)));
    if (!prov) throw NotFound('Hypervisor provider');
    if (prov.locationId !== input.locationId) throw Invalid('Provider is in a different location');
    for (const [poolId, version] of [
      [input.ipv4PoolId, 4],
      [input.ipv6PoolId, 6],
    ] as const) {
      if (!poolId) continue;
      const [pool] = await this.db.select().from(ipPools).where(and(eq(ipPools.id, poolId), eq(ipPools.tenantId, tenantId)));
      if (!pool || pool.version !== version) throw Invalid(`ipv${version}PoolId must reference an IPv${version} pool`);
      if (pool.locationId !== input.locationId) throw Invalid('IP pool is in a different location');
    }
    if (product.ipv4Count > 0 && !input.ipv4PoolId) throw Invalid('Product includes IPv4 but no IPv4 pool was given');
    if (product.ipv6Count > 0 && !input.ipv6PoolId) throw Invalid('Product includes IPv6 but no IPv6 pool was given');
    if (!input.templateIds.length) throw Invalid('At least one OS template is required');
    const tpls = await this.db.select().from(osTemplates).where(inArray(osTemplates.id, input.templateIds));
    if (tpls.length !== input.templateIds.length || tpls.some((t) => t.providerId !== input.providerId)) {
      throw Invalid('All templates must belong to the selected provider');
    }
    const values = { productId, ...input, bridge: input.bridge ?? 'vmbr0', enabled: input.enabled ?? true };
    const [row] = await this.db
      .insert(productPlacements)
      .values(values)
      .onConflictDoUpdate({ target: [productPlacements.productId, productPlacements.locationId], set: values })
      .returning();
    return row;
  }

  async placementFor(tx: DbOrTx, productId: string, locationId: string) {
    const [row] = await tx
      .select()
      .from(productPlacements)
      .where(and(eq(productPlacements.productId, productId), eq(productPlacements.locationId, locationId), eq(productPlacements.enabled, true)));
    return row ?? null;
  }

  // ───────────────────────── pricing

  async createPriceList(tenantId: string, name: string, currency: string, isDefaultWholesale = false, isDefaultRetail = false) {
    if (isDefaultWholesale && isDefaultRetail) throw Invalid('A price list is either the default wholesale list or the default retail list, not both');
    return this.db.transaction(async (tx) => {
      if (isDefaultWholesale) {
        await tx.update(priceLists).set({ isDefaultWholesale: false }).where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.currency, currency)));
      }
      if (isDefaultRetail) {
        await tx.update(priceLists).set({ isDefaultRetail: false }).where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.currency, currency)));
      }
      const [row] = await tx.insert(priceLists).values({ tenantId, name, currency, isDefaultWholesale, isDefaultRetail }).returning();
      return row;
    });
  }

  /** Customer-facing price from the tenant's default retail list. */
  async resolveRetail(tx: DbOrTx, tenantId: string, productId: string, cycle: Cycle, currency: string): Promise<ResolvedPrice> {
    const [product] = await tx.select().from(products).where(and(eq(products.id, productId), eq(products.tenantId, tenantId)));
    if (!product || product.status !== 'ACTIVE') throw new DomainError('product_not_available', 'Product is not available', 422);
    const [row] = await tx
      .select({ price: prices, list: priceLists })
      .from(prices)
      .innerJoin(priceLists, eq(priceLists.id, prices.priceListId))
      .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.isDefaultRetail, true), eq(priceLists.currency, currency), eq(prices.productId, productId), eq(prices.cycle, cycle)));
    if (!row) throw new DomainError('product_not_available', `This plan is not sold on a ${cycle.toLowerCase()} cycle`, 422);
    return { amountMinor: row.price.amountMinor, setupFeeMinor: row.price.setupFeeMinor, currency, priceListId: row.list.id, source: 'default' };
  }

  /** Store catalog: active products with a retail price and at least one enabled placement. */
  async storeCatalog(tenantId: string, currency: string) {
    const all = await this.db.query.products.findMany({
      where: and(eq(products.tenantId, tenantId), eq(products.status, 'ACTIVE')),
      with: { placements: true, prices: true },
      orderBy: (p, { asc }) => [asc(p.memoryMb)],
    });
    const [retail] = await this.db.select().from(priceLists).where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.isDefaultRetail, true), eq(priceLists.currency, currency)));
    if (!retail) return [];
    const out = [];
    for (const p of all) {
      const pricing = p.prices
        .filter((x) => x.priceListId === retail.id)
        .map((x) => ({ cycle: x.cycle, amountMinor: x.amountMinor, setupFeeMinor: x.setupFeeMinor, currency }));
      const enabled = p.placements.filter((pl) => pl.enabled);
      if (!pricing.length || !enabled.length) continue;
      const locs = await this.db.select().from(locations).where(inArray(locations.id, enabled.map((pl) => pl.locationId)));
      const tplIds = [...new Set(enabled.flatMap((pl) => pl.templateIds))];
      const tpls = tplIds.length ? await this.db.select().from(osTemplates).where(inArray(osTemplates.id, tplIds)) : [];
      out.push({
        id: p.id,
        sku: p.sku,
        name: p.name,
        type: p.type,
        description: p.description,
        gstRateBp: p.gstRateBp,
        specs: { cpuCores: p.cpuCores, memoryMb: p.memoryMb, diskGb: p.diskGb, bandwidthGb: p.bandwidthGb, ipv4: p.ipv4Count, ipv6: p.ipv6Count },
        pricing,
        locations: locs.map((l) => {
          const pl = enabled.find((x) => x.locationId === l.id)!;
          return {
            id: l.id,
            code: l.code,
            name: l.name,
            ipv4PoolId: pl.ipv4PoolId,
            templates: tpls.filter((t) => pl.templateIds.includes(t.id)).map((t) => ({ id: t.id, name: t.name, osFamily: t.osFamily })),
          };
        }),
      });
    }
    return out;
  }

  listPriceLists(tenantId: string) {
    return this.db.select().from(priceLists).where(eq(priceLists.tenantId, tenantId));
  }

  async setPrice(tenantId: string, priceListId: string, productId: string, cycle: Cycle, amountMinor: bigint, setupFeeMinor = 0n) {
    const [list] = await this.db.select().from(priceLists).where(and(eq(priceLists.id, priceListId), eq(priceLists.tenantId, tenantId)));
    if (!list) throw NotFound('Price list');
    await this.getProduct(tenantId, productId);
    if (amountMinor < 0n || setupFeeMinor < 0n) throw Invalid('Prices cannot be negative');
    const values = { priceListId, productId, cycle, amountMinor, setupFeeMinor };
    const [row] = await this.db
      .insert(prices)
      .values(values)
      .onConflictDoUpdate({ target: [prices.priceListId, prices.productId, prices.cycle], set: { amountMinor, setupFeeMinor } })
      .returning();
    return row;
  }

  /**
   * Wholesale price for a reseller: reseller-specific list first, then the tenant's
   * default wholesale list in the reseller's currency. A product is eligible for a
   * reseller only if it is ACTIVE and resolvable to a price.
   */
  async resolveWholesale(tx: DbOrTx, tenantId: string, resellerId: string, productId: string, cycle: Cycle): Promise<ResolvedPrice> {
    const [reseller] = await tx.select().from(resellers).where(and(eq(resellers.id, resellerId), eq(resellers.tenantId, tenantId)));
    if (!reseller) throw NotFound('Reseller');
    const [product] = await tx.select().from(products).where(and(eq(products.id, productId), eq(products.tenantId, tenantId)));
    if (!product || product.status !== 'ACTIVE') throw new DomainError('product_not_eligible', 'Product is not available', 422);

    const candidates: Array<{ id: string; source: 'reseller' | 'default' }> = [];
    if (reseller.priceListId) candidates.push({ id: reseller.priceListId, source: 'reseller' });
    const [def] = await tx
      .select()
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.isDefaultWholesale, true), eq(priceLists.currency, reseller.currency)));
    if (def) candidates.push({ id: def.id, source: 'default' });

    for (const c of candidates) {
      const [row] = await tx
        .select({ price: prices, list: priceLists })
        .from(prices)
        .innerJoin(priceLists, eq(priceLists.id, prices.priceListId))
        .where(and(eq(prices.priceListId, c.id), eq(prices.productId, productId), eq(prices.cycle, cycle)));
      if (row) {
        if (row.list.currency !== reseller.currency) {
          throw new DomainError('currency_mismatch', 'Reseller price list currency differs from wallet currency', 422);
        }
        return {
          amountMinor: row.price.amountMinor,
          setupFeeMinor: row.price.setupFeeMinor,
          currency: row.list.currency,
          priceListId: c.id,
          source: c.source,
        };
      }
    }
    throw new DomainError('product_not_eligible', `Product is not priced for this reseller on cycle ${cycle}`, 422);
  }

  /** Catalog as one reseller sees it: only products they can actually buy, with their wholesale prices. */
  async resellerCatalog(tenantId: string, resellerId: string) {
    const all = await this.db.query.products.findMany({
      where: and(eq(products.tenantId, tenantId), eq(products.status, 'ACTIVE')),
      with: { placements: true },
    });
    const cycles: Cycle[] = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONE_TIME'];
    const out = [];
    for (const p of all) {
      const pricing = [];
      for (const cycle of cycles) {
        try {
          const r = await this.resolveWholesale(this.db, tenantId, resellerId, p.id, cycle);
          pricing.push({ cycle, amountMinor: r.amountMinor, setupFeeMinor: r.setupFeeMinor, currency: r.currency });
        } catch {
          /* not priced on this cycle */
        }
      }
      if (!pricing.length) continue;
      const enabled = p.placements.filter((pl) => pl.enabled);
      const locs = enabled.length
        ? await this.db.select().from(locations).where(inArray(locations.id, enabled.map((pl) => pl.locationId)))
        : [];
      const tplIds = [...new Set(enabled.flatMap((pl) => pl.templateIds))];
      const tpls = tplIds.length ? await this.db.select().from(osTemplates).where(inArray(osTemplates.id, tplIds)) : [];
      out.push({
        id: p.id,
        sku: p.sku,
        name: p.name,
        type: p.type,
        description: p.description,
        specs: { cpuCores: p.cpuCores, memoryMb: p.memoryMb, diskGb: p.diskGb, bandwidthGb: p.bandwidthGb, ipv4: p.ipv4Count, ipv6: p.ipv6Count },
        pricing,
        locations: locs.map((l) => ({
          id: l.id,
          code: l.code,
          name: l.name,
          ipv4PoolId: enabled.find((pl) => pl.locationId === l.id)?.ipv4PoolId ?? null,
          templates: tpls
            .filter((t) => enabled.find((pl) => pl.locationId === l.id)?.templateIds.includes(t.id))
            .map((t) => ({ id: t.id, name: t.name, osFamily: t.osFamily })),
        })),
      });
    }
    return out;
  }
}
