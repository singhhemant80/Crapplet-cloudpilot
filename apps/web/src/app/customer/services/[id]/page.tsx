'use client';
import { use } from 'react';
import { ServiceView } from '@/components/service-view';

export default function CustomerService({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ServiceView id={id} base="v1/customer/services" actions={['start', 'shutdown', 'reboot', 'stop']} />;
}
