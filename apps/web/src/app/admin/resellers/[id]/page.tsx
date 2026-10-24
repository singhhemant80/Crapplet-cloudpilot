'use client';
import { use, useState } from 'react';
import { LedgerTable } from '@/components/ledger-table';
import { Button, ErrorNote, Facts, Field, Input, Loading, PageHeader, Section, Select, Status } from '@/components/ui';
import { api, money, newKey, toMinor, useAction, useApi } from '@/lib/api';
import type { Balances, LedgerLine } from '@/lib/types';

interface Reseller {
  id: string;
  name: string;
  contactEmail: string;
  status: string;
  model: string;
  currency: string;
  balances: Balances;
}

export default function ResellerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const list = useApi<Reseller[]>('v1/admin/resellers');
  const ledger = useApi<LedgerLine[]>(`v1/admin/resellers/${id}/statement`);
  const r = list.data?.find((x) => x.id === id);
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [memo, setMemo] = useState('');
  const [limit, setLimit] = useState('');
  const adjust = useAction(
    () => {
      const m = toMinor(amount);
      if (!m) throw new Error('Enter an amount like 1500 or 1500.50');
      return api(`v1/admin/resellers/${id}/adjustments`, { method: 'POST', body: { amountMinor: direction === 'debit' ? `-${m}` : m, memo, idempotencyKey: newKey() } });
    },
    ['v1/admin/resellers'],
  );
  const update = useAction((patch: Record<string, unknown>) => api(`v1/admin/resellers/${id}`, { method: 'PATCH', body: patch }), ['v1/admin/resellers']);

  if (list.error) return <ErrorNote error={list.error} />;
  if (!r) return <Loading />;
  const b = r.balances;
  return (
    <div>
      <PageHeader
        title={r.name}
        intro={r.contactEmail}
        actions={
          r.status === 'SUSPENDED' ? (
            <Button busy={update.isPending} onClick={() => update.mutate({ status: 'ACTIVE' })}>
              Reactivate
            </Button>
          ) : (
            <Button variant="secondary" busy={update.isPending} onClick={() => update.mutate({ status: 'SUSPENDED' })}>
              Suspend reseller
            </Button>
          )
        }
      />
      <ErrorNote error={update.error} />
      <div className="grid gap-8 md:grid-cols-2">
        <Section title="Wallet">
          <Facts
            items={[
              ['Status', <Status key="s" value={r.status} />],
              ['Model', r.model.toLowerCase()],
              ['Available', <span key="a" className="num">{money(b.availableMinor, r.currency)}</span>],
              ['Held for open orders', <span key="h" className="num">{money(b.reservedMinor, r.currency)}</span>],
              ...(r.model === 'CREDIT'
                ? ([
                    ['Credit used', <span key="c" className="num">{money(b.creditUsedMinor, r.currency)} of {money(b.creditLimitMinor, r.currency)}</span>],
                  ] as Array<[string, React.ReactNode]>)
                : []),
              ['Can spend now', <span key="sp" className="num font-semibold">{money(b.spendableMinor, r.currency)}</span>],
            ]}
          />
          {r.model === 'CREDIT' && (
            <form
              className="mt-4 flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const m = toMinor(limit);
                if (m) update.mutate({ creditLimitMinor: m });
              }}
            >
              <Field label="New credit limit">
                <Input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="50000" />
              </Field>
              <Button type="submit" variant="secondary">
                Update limit
              </Button>
            </form>
          )}
        </Section>
        <Section title="Manual adjustment">
          <p className="mb-3 text-sm text-muted">Posts a balanced ledger entry against the adjustments account. The reason is kept in the audit log.</p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              adjust.mutate(undefined, { onSuccess: () => (setAmount(''), setMemo('')) });
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Direction">
                <Select value={direction} onChange={(e) => setDirection(e.target.value as 'credit' | 'debit')}>
                  <option value="credit">Add to wallet</option>
                  <option value="debit">Take from wallet</option>
                </Select>
              </Field>
              <Field label={`Amount (${r.currency})`}>
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
            </div>
            <Field label="Reason">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. SLA credit for outage on 12 Oct" />
            </Field>
            <ErrorNote error={adjust.error} />
            <div>
              <Button type="submit" busy={adjust.isPending} disabled={!amount || memo.length < 3}>
                Post adjustment
              </Button>
            </div>
          </form>
        </Section>
      </div>
      <Section title="Ledger">
        <LedgerTable rows={ledger.data} />
      </Section>
    </div>
  );
}
