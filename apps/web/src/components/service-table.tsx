'use client';
import Link from 'next/link';
import { Status, Table } from './ui';
import { day, mb, money } from '@/lib/api';
import type { ServiceRow } from '@/lib/types';

export function ServiceTable({ rows, href, empty }: { rows: ServiceRow[] | undefined; href: (s: ServiceRow) => string; empty: string }) {
  return (
    <Table
      rows={rows}
      rowKey={(s) => s.id}
      filter={(s) => `${s.hostname} ${s.productName} ${s.status}`}
      empty={empty}
      columns={[
        { key: 'h', header: 'Hostname', sort: (s) => s.hostname, render: (s) => <Link href={href(s)} className="text-rack hover:underline">{s.hostname}</Link> },
        { key: 'p', header: 'Plan', render: (s) => s.productName },
        { key: 'r', header: 'Resources', render: (s) => `${s.cpuCores} vCPU · ${mb(s.memoryMb)} · ${s.diskGb} GB` },
        { key: 's', header: 'Status', sort: (s) => s.status, render: (s) => <Status value={s.status} /> },
        { key: 'd', header: 'Next due', sort: (s) => s.nextDueDate ?? '', render: (s) => day(s.nextDueDate) },
        { key: 'm', header: 'Renewal', align: 'right', render: (s) => money(s.renewalMinor, s.currency) },
      ]}
    />
  );
}
