'use client';
import { use } from 'react';
import { ServiceView } from '@/components/service-view';

export default function ResellerService({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ServiceView id={id} base="v1/reseller/services" actions={['start', 'shutdown', 'reboot', 'stop', 'suspend', 'unsuspend', 'terminate']} canRenew />;
}
