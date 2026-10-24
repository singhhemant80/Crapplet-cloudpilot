'use client';
import { ServiceTable } from '@/components/service-table';
import { ErrorNote, PageHeader } from '@/components/ui';
import { useApi } from '@/lib/api';
import type { ServiceRow } from '@/lib/types';

export default function ResellerServices() {
  const { data, error } = useApi<ServiceRow[]>('v1/reseller/services');
  return (
    <div>
      <PageHeader title="Services" intro="Servers you have sold. Suspension and termination normally come from your WHMCS automatically." />
      <ErrorNote error={error} />
      <ServiceTable rows={data} href={(s) => `/reseller/services/${s.id}`} empty="No servers yet. They appear here once an order finishes building." />
    </div>
  );
}
