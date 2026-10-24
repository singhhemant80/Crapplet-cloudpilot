'use client';
import { ServiceTable } from '@/components/service-table';
import { ErrorNote, PageHeader } from '@/components/ui';
import { useApi } from '@/lib/api';
import type { ServiceRow } from '@/lib/types';

export default function AdminServices() {
  const { data, error } = useApi<ServiceRow[]>('v1/admin/services');
  return (
    <div>
      <PageHeader title="Services" intro="Provisioned servers across all resellers and customers." />
      <ErrorNote error={error} />
      <ServiceTable rows={data} href={(s) => `/admin/services/${s.id}`} empty="No services yet. Services appear once an order finishes provisioning." />
    </div>
  );
}
