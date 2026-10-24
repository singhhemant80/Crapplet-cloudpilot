'use client';
import Link from 'next/link';
import { use } from 'react';
import { OrderView } from '@/components/order-view';
import { Button, ErrorNote, Loading, PageHeader } from '@/components/ui';
import { api, useAction, useApi, whileInFlight } from '@/lib/api';
import { IN_FLIGHT, type OrderDetail } from '@/lib/types';

export default function AdminOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const path = `v1/admin/orders/${id}`;
  const { data: order, error } = useApi<OrderDetail>(path, { refetchInterval: whileInFlight(IN_FLIGHT) });
  const approve = useAction(() => api(`v1/admin/orders/${id}/approve`, { method: 'POST' }), [path, 'v1/admin/orders']);
  const retry = useAction(() => api(`v1/admin/orders/${id}/retry`, { method: 'POST' }), [path, 'v1/admin/orders']);
  if (error) return <ErrorNote error={error} />;
  if (!order) return <Loading />;
  return (
    <div>
      <PageHeader
        title={`Order ${order.number}`}
        intro={order.hostname}
        actions={
          <>
            {order.status === 'PAID_OR_AUTHORIZED' && (
              <Button busy={approve.isPending} onClick={() => approve.mutate(undefined)}>
                Approve and provision
              </Button>
            )}
            {order.status === 'NEEDS_ATTENTION' && (
              <Button busy={retry.isPending} onClick={() => retry.mutate(undefined)}>
                Retry provisioning
              </Button>
            )}
            {order.service && order.status === 'ACTIVE' && (
              <Link href={`/admin/services/${order.service.id}`} className="rounded-md border border-line px-3.5 py-2 text-sm hover:bg-idle-bg">
                Open service
              </Link>
            )}
          </>
        }
      />
      <ErrorNote error={approve.error ?? retry.error} />
      {order.status === 'NEEDS_ATTENTION' && (
        <p className="mb-6 rounded-md border border-warn/40 bg-warn-bg p-3 text-sm text-warn">
          Provisioning stopped and the partial VM could not be confirmed as removed, so the reseller&apos;s funds and the IP are still held.
          Check the VM on the hypervisor, then retry.
        </p>
      )}
      <OrderView order={order} showMargin />
    </div>
  );
}
