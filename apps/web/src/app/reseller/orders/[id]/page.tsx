'use client';
import Link from 'next/link';
import { use } from 'react';
import { OrderView } from '@/components/order-view';
import { ErrorNote, Loading, PageHeader } from '@/components/ui';
import { useApi, whileInFlight } from '@/lib/api';
import { IN_FLIGHT, type OrderDetail } from '@/lib/types';

export default function ResellerOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useApi<OrderDetail>(`v1/reseller/orders/${id}`, { refetchInterval: whileInFlight(IN_FLIGHT) });
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  return (
    <div>
      <PageHeader
        title={`Order ${data.number}`}
        intro={data.hostname}
        actions={
          data.service && data.status === 'ACTIVE' ? (
            <Link href={`/reseller/services/${data.service.id}`} className="rounded-md bg-rack px-3.5 py-2 text-sm font-medium text-rack-ink">
              Manage server
            </Link>
          ) : undefined
        }
      />
      {data.status === 'FAILED' && (
        <p className="mb-6 rounded-md border border-line bg-surface p-3 text-sm">The server could not be built. The amount held for it has been returned to your wallet.</p>
      )}
      {data.status === 'NEEDS_ATTENTION' && (
        <p className="mb-6 rounded-md border border-warn/40 bg-warn-bg p-3 text-sm text-warn">Our team is looking at this order. The amount stays held until it is resolved.</p>
      )}
      <OrderView order={data} showMargin />
    </div>
  );
}
