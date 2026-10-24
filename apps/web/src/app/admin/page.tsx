'use client';
import Link from 'next/link';
import { ErrorNote, Loading, PageHeader, Section, Status, Table } from '@/components/ui';
import { money, useApi, when } from '@/lib/api';
import type { OrderRow } from '@/lib/types';

interface Overview {
  orders: Array<{ status: string; n: number }>;
  services: Array<{ status: string; n: number }>;
  pendingDeposits: number;
  providers: Array<{ status: string; n: number }>;
  ip: Array<{ status: string; n: number }>;
  revenue: Array<{ currency: string; captured_minor: string }>;
  recentOrders: OrderRow[];
}

const count = (rows: Array<{ status: string; n: number }>, ...s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);

export default function AdminOverview() {
  const { data, error } = useApi<Overview>('v1/admin/overview', { refetchInterval: 10_000 });
  const rec = useApi<{ ok: boolean; problems: string[] }>('v1/admin/ledger/reconcile');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;

  const attention = count(data.orders, 'NEEDS_ATTENTION', 'FAILED');
  const inFlight = count(data.orders, 'QUEUED', 'PROVISIONING', 'CONFIGURING_NETWORK', 'VERIFYING');
  const facts: Array<[string, string | number, string?]> = [
    ['Active services', count(data.services, 'ACTIVE'), '/admin/services'],
    ['Provisioning now', inFlight, '/admin/orders'],
    ['Orders needing attention', attention, '/admin/orders?status=NEEDS_ATTENTION,FAILED'],
    ['Deposits to review', data.pendingDeposits, '/admin/deposits'],
    ['Free IPv4 addresses', count(data.ip, 'AVAILABLE'), '/admin/ipam'],
    ['Captured revenue', data.revenue.map((r) => money(r.captured_minor, r.currency)).join(', ') || money(0)],
  ];

  return (
    <div>
      <PageHeader title="Overview" intro="Live state of orders, money and capacity across the platform." />
      <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
        {facts.map(([label, value, href]) => {
          const body = (
            <>
              <div className="num text-2xl font-semibold">{value}</div>
              <div className="text-sm text-muted">{label}</div>
            </>
          );
          return href ? (
            <Link key={label} href={href} className="bg-surface px-4 py-4 hover:bg-paper">
              {body}
            </Link>
          ) : (
            <div key={label} className="bg-surface px-4 py-4">
              {body}
            </div>
          );
        })}
      </div>

      {rec.data && !rec.data.ok && (
        <div role="alert" className="mb-8 rounded-md border border-bad/30 bg-bad-bg p-4 text-sm text-bad">
          <p className="font-semibold">Ledger reconciliation found problems</p>
          <ul className="mt-1 list-disc pl-5">
            {rec.data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {rec.data?.ok && <p className="mb-8 text-sm text-ok">Ledger balanced: every account matches its entries and all open holds.</p>}

      <Section title="Latest orders" aside={<Link href="/admin/orders" className="text-sm text-rack hover:underline">All orders</Link>}>
        <Table
          rows={data.recentOrders}
          rowKey={(o) => o.id}
          empty="No orders yet. They appear here as soon as a reseller or customer places one."
          columns={[
            { key: 'n', header: '#', render: (o) => <Link href={`/admin/orders/${o.id}`} className="text-rack hover:underline">{o.number}</Link> },
            { key: 'h', header: 'Hostname', render: (o) => o.hostname },
            { key: 'p', header: 'Product', render: (o) => o.productName },
            { key: 's', header: 'Status', render: (o) => <Status value={o.status} /> },
            { key: 'w', header: 'Wholesale', align: 'right', render: (o) => money(o.wholesaleMinor, o.currency) },
            { key: 'c', header: 'Placed', render: (o) => when(o.createdAt) },
          ]}
        />
      </Section>
    </div>
  );
}
