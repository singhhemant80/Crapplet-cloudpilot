'use client';
import { ServiceTable } from '@/components/service-table';
import { ErrorNote, PageHeader } from '@/components/ui';
import { useApi } from '@/lib/api';
import type { ServiceRow } from '@/lib/types';

export default function CustomerHome() {
  const { data, error } = useApi<ServiceRow[]>('v1/customer/services');
  return (
    <div>
      <PageHeader title="Your servers" intro="Start, stop and reboot your servers and see how they are running." />
      <ErrorNote error={error} />
      <ServiceTable rows={data} href={(s) => `/customer/services/${s.id}`} empty="You have no servers yet." />
    </div>
  );
}
