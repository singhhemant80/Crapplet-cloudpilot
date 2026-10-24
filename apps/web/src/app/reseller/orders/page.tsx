'use client';
import Link from 'next/link';
import { ErrorNote, PageHeader, Status, Table } from '@/components/ui';
import { money, useApi, when } from '@/lib/api';
import type { OrderRow } from '@/lib/types';

export default function ResellerOrders() {
  const { data, error } = useApi<OrderRow[]>('v1/reseller/orders', { refetchInterval: 5_000 });
  return (
    <div>
      <PageHeader
        title="Orders"
        intro="Orders from your WHMCS, the API, or placed here."
        actions={<Link href="/reseller/orders/new" className="rounded-md bg-rack px-3.5 py-2 text-sm font-medium text-rack-ink hover:brightness-110">New order</Link>}
      />
      <ErrorNote error={error} />
      <Table
        rows={data}
        rowKey={(o) => o.id}
        filter={(o) => `${o.number} ${o.hostname} ${o.productName}`}
        empty="No orders yet."
        columns={[
          { key: 'n', header: '#', sort: (o) => o.number, render: (o) => <Link href={`/reseller/orders/${o.id}`} className="text-rack hover:underline">{o.number}</Link> },
          { key: 'h', header: 'Hostname', render: (o) => o.hostname },
          { key: 'p', header: 'Plan', render: (o) => o.productName },
          { key: 'src', header: 'From', render: (o) => o.source },
          { key: 's', header: 'Status', sort: (o) => o.status, render: (o) => <Status value={o.status} /> },
          { key: 'w', header: 'Cost', align: 'right', render: (o) => money(BigInt(o.wholesaleMinor) + BigInt(o.setupFeeMinor), o.currency) },
          { key: 'r', header: 'Retail', align: 'right', render: (o) => (o.retailMinor ? money(o.retailMinor, o.retailCurrency ?? o.currency) : '—') },
          { key: 'c', header: 'Placed', sort: (o) => o.createdAt, render: (o) => when(o.createdAt) },
        ]}
      />
    </div>
  );
}
