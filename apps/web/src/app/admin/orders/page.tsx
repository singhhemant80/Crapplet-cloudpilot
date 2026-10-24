'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ErrorNote, PageHeader, Select, Status, Table } from '@/components/ui';
import { money, useApi, when } from '@/lib/api';
import type { OrderRow } from '@/lib/types';

const FILTERS: Array<[string, string]> = [
  ['', 'All orders'],
  ['QUEUED,PROVISIONING,CONFIGURING_NETWORK,VERIFYING', 'In progress'],
  ['NEEDS_ATTENTION,FAILED', 'Needs attention or failed'],
  ['PAID_OR_AUTHORIZED', 'Awaiting approval'],
  ['ACTIVE', 'Active'],
];

function Orders() {
  const params = useSearchParams();
  const router = useRouter();
  const status = params.get('status') ?? '';
  const { data, error } = useApi<OrderRow[]>(`v1/admin/orders${status ? `?status=${status}` : ''}`, { refetchInterval: 5_000 });
  return (
    <div>
      <PageHeader
        title="Orders & provisioning"
        intro="Every order moves through payment, VM build, network setup and verification before it becomes active."
        actions={
          <Select aria-label="Filter by status" value={status} onChange={(e) => router.replace(`/admin/orders${e.target.value ? `?status=${e.target.value}` : ''}`)}>
            {FILTERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        }
      />
      <ErrorNote error={error} />
      <Table
        rows={data}
        rowKey={(o) => o.id}
        filter={(o) => `${o.number} ${o.hostname} ${o.productName} ${o.status}`}
        empty="No orders in this view."
        columns={[
          { key: 'n', header: '#', sort: (o) => o.number, render: (o) => <Link href={`/admin/orders/${o.id}`} className="text-rack hover:underline">{o.number}</Link> },
          { key: 'h', header: 'Hostname', sort: (o) => o.hostname, render: (o) => o.hostname },
          { key: 'p', header: 'Product', render: (o) => o.productName },
          { key: 'src', header: 'Source', render: (o) => o.source },
          { key: 's', header: 'Status', sort: (o) => o.status, render: (o) => <Status value={o.status} /> },
          { key: 'w', header: 'Wholesale', align: 'right', sort: (o) => Number(o.wholesaleMinor), render: (o) => money(BigInt(o.wholesaleMinor) + BigInt(o.setupFeeMinor), o.currency) },
          { key: 'c', header: 'Placed', sort: (o) => o.createdAt, render: (o) => when(o.createdAt) },
        ]}
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Orders />
    </Suspense>
  );
}
