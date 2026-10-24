'use client';
import Link from 'next/link';
import { ErrorNote, Loading, PageHeader, Section, Status, Table } from '@/components/ui';
import { money, useApi, when } from '@/lib/api';
import type { Balances, OrderRow } from '@/lib/types';

interface Me {
  name: string;
  status: string;
  model: string;
  currency: string;
  balances: Balances;
  lowBalance: boolean;
}

export default function ResellerHome() {
  const me = useApi<Me>('v1/reseller/me');
  const orders = useApi<OrderRow[]>('v1/reseller/orders', { refetchInterval: 10_000 });
  if (me.error) return <ErrorNote error={me.error} />;
  if (!me.data) return <Loading />;
  const b = me.data.balances;
  const attention = orders.data?.filter((o) => ['FAILED', 'NEEDS_ATTENTION'].includes(o.status)) ?? [];
  return (
    <div>
      <PageHeader title={me.data.name} intro={me.data.model === 'CREDIT' ? 'Credit account' : 'Prepaid wallet account'} />
      <div className="mb-8 flex flex-wrap items-end gap-x-12 gap-y-4 rounded-lg border border-line bg-surface px-6 py-5">
        <div>
          <div className="text-sm text-muted">You can spend</div>
          <div className="num text-4xl font-semibold tracking-tight">{money(b.spendableMinor, b.currency)}</div>
        </div>
        <div className="num text-sm">
          <div>
            <span className="text-muted">Wallet </span>
            {money(b.availableMinor, b.currency)}
          </div>
          <div>
            <span className="text-muted">Held for orders being built </span>
            {money(b.reservedMinor, b.currency)}
          </div>
          {me.data.model === 'CREDIT' && (
            <div>
              <span className="text-muted">Credit used </span>
              {money(b.creditUsedMinor, b.currency)} of {money(b.creditLimitMinor, b.currency)}
            </div>
          )}
        </div>
        <Link href="/reseller/wallet" className="ml-auto rounded-md bg-rack px-3.5 py-2 text-sm font-medium text-rack-ink hover:brightness-110">
          Add funds
        </Link>
      </div>
      {me.data.lowBalance && <p className="mb-6 rounded-md border border-warn/40 bg-warn-bg p-3 text-sm text-warn">Your balance is below your alert threshold. New orders fail once it runs out.</p>}
      {attention.length > 0 && (
        <p className="mb-6 rounded-md border border-bad/30 bg-bad-bg p-3 text-sm text-bad">
          {attention.length} order{attention.length > 1 ? 's' : ''} could not be provisioned. Funds for failed orders are returned to your wallet automatically.
        </p>
      )}
      <Section title="Recent orders" aside={<Link href="/reseller/orders" className="text-sm text-rack hover:underline">All orders</Link>}>
        <Table
          rows={orders.data?.slice(0, 8)}
          rowKey={(o) => o.id}
          empty={<>No orders yet. <Link href="/reseller/orders/new" className="text-rack hover:underline">Place your first order</Link> or connect WHMCS.</>}
          columns={[
            { key: 'n', header: '#', render: (o) => <Link href={`/reseller/orders/${o.id}`} className="text-rack hover:underline">{o.number}</Link> },
            { key: 'h', header: 'Hostname', render: (o) => o.hostname },
            { key: 'p', header: 'Plan', render: (o) => o.productName },
            { key: 's', header: 'Status', render: (o) => <Status value={o.status} /> },
            { key: 'w', header: 'Cost', align: 'right', render: (o) => money(BigInt(o.wholesaleMinor) + BigInt(o.setupFeeMinor), o.currency) },
            { key: 'c', header: 'Placed', render: (o) => when(o.createdAt) },
          ]}
        />
      </Section>
    </div>
  );
}
