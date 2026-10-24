'use client';
import clsx from 'clsx';
import { Table } from './ui';
import { money, when } from '@/lib/api';
import type { LedgerLine } from '@/lib/types';

const ACCOUNT: Record<string, string> = {
  RESELLER_AVAILABLE: 'Available',
  RESELLER_RESERVED: 'Held',
  RESELLER_CREDIT: 'Credit line',
  RESELLER_PROMO: 'Promotional',
};

/** One row per ledger entry on the reseller's own accounts, newest first. */
export function LedgerTable({ rows }: { rows: LedgerLine[] | undefined }) {
  return (
    <Table
      rows={rows}
      rowKey={(l) => `${l.transactionId}-${l.account}`}
      filter={(l) => `${l.type} ${l.memo} ${l.sourceId}`}
      empty="No wallet activity yet."
      columns={[
        { key: 'd', header: 'When', render: (l) => <span className="whitespace-nowrap">{when(l.createdAt)}</span> },
        { key: 't', header: 'Type', render: (l) => l.type.toLowerCase().replace('_', ' ') },
        { key: 'm', header: 'Description', render: (l) => l.memo },
        { key: 'acc', header: 'Account', render: (l) => ACCOUNT[l.account] ?? l.account },
        {
          key: 'a',
          header: 'Amount',
          align: 'right',
          render: (l) => <span className={clsx(l.amountMinor.startsWith('-') ? 'text-bad' : 'text-ok')}>{l.amountMinor.startsWith('-') ? '' : '+'}{money(l.amountMinor, l.currency)}</span>,
        },
        { key: 'b', header: 'Balance after', align: 'right', render: (l) => money(l.balanceAfterMinor, l.currency) },
      ]}
    />
  );
}
