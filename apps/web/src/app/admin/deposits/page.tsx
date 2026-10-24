'use client';
import { useState } from 'react';
import { Button, Dialog, ErrorNote, Field, Input, PageHeader, Select, Status, Table } from '@/components/ui';
import { api, money, toMinor, useAction, useApi, when } from '@/lib/api';
import type { Deposit } from '@/lib/types';

type Row = { deposit: Deposit; resellerName: string };

export default function Deposits() {
  const [status, setStatus] = useState('UNDER_REVIEW');
  const { data, error } = useApi<Row[]>(`v1/admin/deposits${status ? `?status=${status}` : ''}`);
  const [review, setReview] = useState<Row | null>(null);
  const [received, setReceived] = useState('');
  const [reason, setReason] = useState('');
  const approve = useAction(
    (r: Row) => api(`v1/admin/deposits/${r.deposit.id}/approve`, { method: 'POST', body: received ? { receivedAmountMinor: toMinor(received) } : {} }),
    ['v1/admin/deposits', 'v1/admin/resellers'],
  );
  const reject = useAction((r: Row) => api(`v1/admin/deposits/${r.deposit.id}/reject`, { method: 'POST', body: { reason } }), ['v1/admin/deposits']);
  const close = () => (setReview(null), setReceived(''), setReason(''));

  return (
    <div>
      <PageHeader
        title="Deposits"
        intro="Bank transfers are only credited after you confirm the money arrived. Online payments credit automatically once the gateway confirms them."
        actions={
          <Select aria-label="Filter deposits" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="UNDER_REVIEW">Waiting for review</option>
            <option value="AWAITING_PAYMENT">Awaiting online payment</option>
            <option value="CREDITED">Credited</option>
            <option value="REJECTED">Rejected</option>
            <option value="">All</option>
          </Select>
        }
      />
      <ErrorNote error={error} />
      <Table
        rows={data}
        rowKey={(r) => r.deposit.id}
        filter={(r) => `${r.resellerName} ${r.deposit.bankReference ?? ''}`}
        empty={status === 'UNDER_REVIEW' ? 'Nothing to review. New bank-transfer notices appear here.' : 'No deposits in this view.'}
        columns={[
          { key: 'r', header: 'Reseller', render: (r) => r.resellerName },
          { key: 'm', header: 'Method', render: (r) => (r.deposit.method === 'GATEWAY' ? `Online (${r.deposit.gateway})` : 'Bank transfer') },
          { key: 'ref', header: 'Reference', render: (r) => <code className="text-xs">{r.deposit.bankReference ?? '—'}</code> },
          { key: 'a', header: 'Claimed amount', align: 'right', render: (r) => money(r.deposit.amountMinor, r.deposit.currency) },
          { key: 's', header: 'Status', render: (r) => <Status value={r.deposit.status} /> },
          { key: 'c', header: 'Submitted', render: (r) => when(r.deposit.createdAt) },
          {
            key: 'x',
            header: '',
            render: (r) =>
              r.deposit.status === 'UNDER_REVIEW' ? (
                <Button variant="secondary" onClick={() => setReview(r)}>
                  Review
                </Button>
              ) : null,
          },
        ]}
      />
      <Dialog open={review !== null} onClose={close} title="Review bank transfer">
        {review && (
          <div className="flex flex-col gap-4 text-sm">
            <p>
              <b>{review.resellerName}</b> says they sent <b>{money(review.deposit.amountMinor, review.deposit.currency)}</b> with reference{' '}
              <code>{review.deposit.bankReference}</code>.
            </p>
            {review.deposit.proofNote && <p className="rounded-md bg-paper p-3 text-muted">“{review.deposit.proofNote}”</p>}
            <p className="text-muted">Find this reference in the bank statement before approving.</p>
            <Field label="Amount actually received" hint="Leave empty if it matches the claimed amount.">
              <Input inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} />
            </Field>
            <ErrorNote error={approve.error ?? reject.error} />
            <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line pt-4">
              <div className="flex items-end gap-2">
                <Field label="Rejection reason">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not found in statement" />
                </Field>
                <Button variant="secondary" disabled={reason.length < 3} busy={reject.isPending} onClick={() => reject.mutate(review, { onSuccess: close })}>
                  Reject
                </Button>
              </div>
              <Button busy={approve.isPending} onClick={() => approve.mutate(review, { onSuccess: close })}>
                Approve and credit
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
