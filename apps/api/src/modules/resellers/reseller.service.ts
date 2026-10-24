import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { integrationConnections, ledgerAccounts, ledgerEntries, ledgerTransactions, priceLists, resellers } from '../../db/schema';
import { Invalid, NotFound } from '../../common/errors';
import { audit, type AuditActor } from '../../common/audit';
import type { LedgerService } from '../ledger/ledger.service';
import type { AuthService } from '../auth/auth.service';
import { API_SCOPES } from '../auth/auth.service';

type ResellerInsert = typeof resellers.$inferInsert;

export class ResellerService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly auth: AuthService,
  ) {}

  async create(p: {
    tenantId: string;
    name: string;
    contactEmail: string;
    model: ResellerInsert['model'];
    currency: string;
    creditLimitMinor?: bigint;
    priceListId?: string;
    admin?: { email: string; name: string; password: string };
    actor: AuditActor;
  }) {
    if (p.model !== 'CREDIT' && p.creditLimitMinor && p.creditLimitMinor > 0n) throw Invalid('Only CREDIT resellers can have a credit limit');
    if (p.priceListId) await this.assertPriceList(p.tenantId, p.priceListId, p.currency);
    const reseller = await this.db.transaction(async (tx) => {
      const [r] = await tx
        .insert(resellers)
        .values({
          tenantId: p.tenantId,
          name: p.name,
          contactEmail: p.contactEmail,
          model: p.model,
          currency: p.currency,
          creditLimitMinor: p.creditLimitMinor ?? 0n,
          priceListId: p.priceListId,
          status: 'ACTIVE',
        })
        .returning();
      await this.ledger.resellerAccounts(tx, p.tenantId, r.id, p.currency);
      await audit(tx, { tenantId: p.tenantId, actor: p.actor, resellerId: r.id, action: 'reseller.create', targetType: 'reseller', targetId: r.id });
      return r;
    });
    const admin = p.admin
      ? await this.auth.createUser({ tenantId: p.tenantId, ...p.admin, role: 'RESELLER_ADMIN', resellerId: reseller.id })
      : undefined;
    return { reseller, admin };
  }

  private async assertPriceList(tenantId: string, id: string, currency: string) {
    const [pl] = await this.db.select().from(priceLists).where(and(eq(priceLists.id, id), eq(priceLists.tenantId, tenantId)));
    if (!pl) throw NotFound('Price list');
    if (pl.currency !== currency) throw Invalid('Price list currency must match the reseller wallet currency');
  }

  async update(
    tenantId: string,
    id: string,
    patch: { status?: ResellerInsert['status']; creditLimitMinor?: bigint; priceListId?: string | null; lowBalanceThresholdMinor?: bigint; name?: string },
    actor: AuditActor,
  ) {
    const r = await this.get(tenantId, id);
    if (patch.priceListId) await this.assertPriceList(tenantId, patch.priceListId, r.currency);
    if (patch.creditLimitMinor !== undefined && r.model !== 'CREDIT' && patch.creditLimitMinor > 0n) {
      throw Invalid('Only CREDIT resellers can have a credit limit');
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(resellers).set(patch).where(eq(resellers.id, id)).returning();
      if (patch.creditLimitMinor !== undefined) await this.ledger.syncCreditLimit(tx, tenantId, id, r.currency);
      await audit(tx, {
        tenantId,
        actor,
        resellerId: id,
        action: 'reseller.update',
        targetType: 'reseller',
        targetId: id,
        metadata: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
      });
      return row;
    });
  }

  async get(tenantId: string, id: string) {
    const [r] = await this.db.select().from(resellers).where(and(eq(resellers.id, id), eq(resellers.tenantId, tenantId)));
    if (!r) throw NotFound('Reseller');
    return r;
  }

  async list(tenantId: string) {
    const rows = await this.db.select().from(resellers).where(eq(resellers.tenantId, tenantId)).orderBy(resellers.name);
    return Promise.all(rows.map(async (r) => ({ ...r, balances: await this.ledger.balances(this.db, tenantId, r.id, r.currency) })));
  }

  /** Wallet statement: ledger lines touching the reseller's spendable accounts. */
  async statement(tenantId: string, resellerId: string, limit = 200) {
    return this.db
      .select({
        transactionId: ledgerTransactions.id,
        type: ledgerTransactions.type,
        memo: ledgerTransactions.memo,
        sourceType: ledgerTransactions.sourceType,
        sourceId: ledgerTransactions.sourceId,
        account: ledgerAccounts.kind,
        amountMinor: ledgerEntries.amountMinor,
        balanceAfterMinor: ledgerEntries.balanceAfterMinor,
        currency: ledgerAccounts.currency,
        createdAt: ledgerEntries.createdAt,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
      .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.resellerId, resellerId)))
      .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
      .limit(Math.min(limit, 1000));
  }

  /**
   * Margin report: retail revenue the reseller reported (from WHMCS/API) vs. our wholesale
   * charges for activated orders, by month. Retail figures are reseller-supplied and informational.
   */
  async margins(tenantId: string, resellerId: string) {
    const res = await this.db.execute(sql`
      select to_char(date_trunc('month', o.created_at), 'YYYY-MM') as month,
             o.currency,
             count(*)::int as orders,
             sum(o.wholesale_minor + o.setup_fee_minor)::text as wholesale_minor,
             sum(coalesce(o.retail_minor, 0))::text as retail_minor,
             count(*) filter (where o.retail_minor is null)::int as orders_without_retail,
             count(*) filter (where o.retail_currency is not null and o.retail_currency <> o.currency)::int as currency_mismatch
        from orders o
       where o.tenant_id = ${tenantId} and o.reseller_id = ${resellerId} and o.status = 'ACTIVE'
       group by 1, 2 order by 1 desc`);
    const renewals = await this.db.execute(sql`
      select to_char(date_trunc('month', r.created_at), 'YYYY-MM') as month, sum(r.amount_minor)::text as renewal_minor
        from service_renewals r join services s on s.id = r.service_id
       where s.tenant_id = ${tenantId} and s.reseller_id = ${resellerId} group by 1`);
    const rmap = new Map(renewals.rows.map((r) => [r.month as string, r.renewal_minor as string]));
    return res.rows.map((r) => {
      const wholesale = BigInt(r.wholesale_minor as string);
      const retail = BigInt(r.retail_minor as string);
      return { ...r, renewalMinor: rmap.get(r.month as string) ?? '0', marginMinor: (retail - wholesale).toString() };
    });
  }

  /** Registers an external billing installation and issues its API key. */
  async createConnection(p: {
    tenantId: string;
    resellerId: string;
    platform: (typeof integrationConnections.$inferInsert)['platform'];
    name: string;
    siteUrl?: string;
    ipAllowlist?: string[];
    actor: AuditActor;
  }) {
    const [conn] = await this.db
      .insert(integrationConnections)
      .values({ tenantId: p.tenantId, resellerId: p.resellerId, platform: p.platform, name: p.name, siteUrl: p.siteUrl })
      .returning();
    const key = await this.auth.createApiKey({
      tenantId: p.tenantId,
      resellerId: p.resellerId,
      name: `${p.platform}: ${p.name}`,
      scopes: [...API_SCOPES],
      ipAllowlist: p.ipAllowlist,
      actor: p.actor,
    });
    return { connection: conn, apiKey: key.apiKey };
  }

  listConnections(resellerId: string) {
    return this.db.select().from(integrationConnections).where(eq(integrationConnections.resellerId, resellerId));
  }
}
