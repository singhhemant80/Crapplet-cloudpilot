'use client';
import { ErrorNote, PageHeader, Table } from '@/components/ui';
import { useApi, when } from '@/lib/api';

interface AuditEvent {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export default function Audit() {
  const { data, error } = useApi<AuditEvent[]>('v1/admin/audit');
  return (
    <div>
      <PageHeader title="Audit log" intro="Who did what — sign-ins, money movements, provisioning and configuration changes." />
      <ErrorNote error={error} />
      <Table
        rows={data}
        rowKey={(e) => e.id}
        filter={(e) => `${e.action} ${e.actorType} ${e.targetType} ${e.targetId} ${JSON.stringify(e.metadata)}`}
        empty="No events recorded yet."
        columns={[
          { key: 'w', header: 'When', render: (e) => <span className="whitespace-nowrap">{when(e.createdAt)}</span> },
          { key: 'a', header: 'Action', render: (e) => <code className="text-xs">{e.action}</code> },
          { key: 'by', header: 'By', render: (e) => `${e.actorType.replace('_', ' ')}${e.ip ? ` from ${e.ip}` : ''}` },
          { key: 't', header: 'Target', render: (e) => (e.targetType ? `${e.targetType} ${e.targetId?.slice(0, 8)}` : '—') },
          { key: 'm', header: 'Details', render: (e) => (Object.keys(e.metadata).length ? <code className="break-all text-xs text-muted">{JSON.stringify(e.metadata)}</code> : '') },
        ]}
      />
    </div>
  );
}
