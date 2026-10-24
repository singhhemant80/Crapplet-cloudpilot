'use client';
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ErrorNote, Loading, PageHeader, Section, Table } from '@/components/ui';
import { money, useApi } from '@/lib/api';

interface Row {
  month: string;
  currency: string;
  orders: number;
  wholesale_minor: string;
  retail_minor: string;
  renewalMinor: string;
  marginMinor: string;
  orders_without_retail: number;
  currency_mismatch: number;
}

export default function Margins() {
  const { data, error } = useApi<Row[]>('v1/reseller/reports/margins');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const chart = [...data].reverse().map((r) => ({ month: r.month, Cost: Number(r.wholesale_minor) / 100, Retail: Number(r.retail_minor) / 100 }));
  const missing = data.reduce((a, r) => a + r.orders_without_retail, 0);
  return (
    <div>
      <PageHeader title="Sales & margins" intro="New activated orders per month: what you paid us against the retail price your billing system reported." />
      {missing > 0 && (
        <p className="mb-6 text-sm text-warn">
          {missing} order{missing > 1 ? 's have' : ' has'} no retail price, so margins are understated. The WHMCS module sends it automatically; API users can include <code>retail</code> when ordering.
        </p>
      )}
      {chart.length > 0 && (
        <Section title="By month">
          <div className="h-64 rounded-md border border-line bg-surface p-3">
            <ResponsiveContainer>
              <BarChart data={chart}>
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: 'var(--muted)' }} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--muted)' }} width={60} />
                <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)' }} />
                <Legend />
                <Bar dataKey="Cost" fill="var(--idle)" isAnimationActive={false} />
                <Bar dataKey="Retail" fill="var(--rack)" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}
      <Table
        rows={data}
        rowKey={(r) => `${r.month}-${r.currency}`}
        empty="No activated orders yet."
        columns={[
          { key: 'm', header: 'Month', render: (r) => r.month },
          { key: 'o', header: 'Orders', align: 'right', render: (r) => r.orders },
          { key: 'w', header: 'Our charge', align: 'right', render: (r) => money(r.wholesale_minor, r.currency) },
          { key: 'r', header: 'Your retail', align: 'right', render: (r) => money(r.retail_minor, r.currency) },
          { key: 'g', header: 'Margin', align: 'right', render: (r) => <span className={r.marginMinor.startsWith('-') ? 'text-bad' : 'text-ok'}>{money(r.marginMinor, r.currency)}</span> },
          { key: 'n', header: 'Renewals paid', align: 'right', render: (r) => money(r.renewalMinor, r.currency) },
        ]}
      />
    </div>
  );
}
