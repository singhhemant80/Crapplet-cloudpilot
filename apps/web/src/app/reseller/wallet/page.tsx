'use client';
import { useState } from 'react';
import { LedgerTable } from '@/components/ledger-table';
import { Button, ErrorNote, Field, Input, PageHeader, Section, Status, Table, Textarea } from '@/components/ui';
import { api, money, newKey, toMinor, useAction, useApi, when } from '@/lib/api';
import type { Balances, Deposit, LedgerLine } from '@/lib/types';

export default function Wallet() {
  const me = useApi<{ currency: string; balances: Balances; paymentGateways: string[] }>('v1/reseller/me');
  const deposits = useApi<Deposit[]>('v1/reseller/wallet/deposits', { refetchInterval: 10_000 });
  const ledger = useApi<LedgerLine[]>('v1/reseller/wallet/ledger');
  const [amount, setAmount] = useState('');
  const [bank, setBank] = useState({ amount: '', ref: '', note: '' });
  const [sent, setSent] = useState<string | null>(null);
  const cur = me.data?.currency ?? 'INR';
  const gateway = me.data?.paymentGateways.includes('razorpay') ? 'razorpay' : me.data?.paymentGateways[0];

  const topup = useAction(async () => {
    const m = toMinor(amount);
    if (!m) throw new Error('Enter an amount like 5000');
    const res = await api<{ checkout?: { checkoutUrl?: string; clientPayload?: unknown } }>('v1/reseller/wallet/topups', {
      method: 'POST',
      body: { gateway, amountMinor: m, externalRef: `portal-${newKey()}` },
    });
    if (res.checkout?.checkoutUrl) window.open(res.checkout.checkoutUrl, '_blank', 'noopener');
    return res;
  }, ['v1/reseller/wallet']);
  const transfer = useAction(() => {
    const m = toMinor(bank.amount);
    if (!m) throw new Error('Enter the amount you transferred');
    return api('v1/reseller/wallet/bank-transfers', { method: 'POST', body: { amountMinor: m, bankReference: bank.ref, note: bank.note || undefined } });
  }, ['v1/reseller/wallet']);

  return (
    <div>
      <PageHeader
        title="Wallet"
        intro="Orders and renewals are paid from this balance."
        actions={
          <a href="/api/cp/v1/reseller/wallet/ledger.csv" className="rounded-md border border-line px-3.5 py-2 text-sm hover:bg-idle-bg">
            Download statement (CSV)
          </a>
        }
      />
      {me.data && (
        <p className="num mb-8 text-sm">
          <span className="text-3xl font-semibold">{money(me.data.balances.availableMinor, cur)}</span>
          <span className="ml-3 text-muted">available · {money(me.data.balances.reservedMinor, cur)} held for orders being built</span>
        </p>
      )}
      <div className="grid gap-10 md:grid-cols-2">
        <Section title="Pay online">
          {gateway ? (
            <form className="flex flex-col gap-3" onSubmit={(e) => (e.preventDefault(), topup.mutate(undefined))}>
              <Field label={`Amount (${cur})`} hint={gateway === 'sandbox' ? 'Sandbox gateway: opens a test checkout, no real money moves.' : 'Credited as soon as the payment gateway confirms it.'}>
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <ErrorNote error={topup.error} />
              <div>
                <Button type="submit" busy={topup.isPending}>
                  Continue to payment
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-muted">Online payment is not set up yet. Use a bank transfer.</p>
          )}
        </Section>
        <Section title="Tell us about a bank transfer">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              transfer.mutate(undefined, { onSuccess: () => (setSent('Thanks — we credit your wallet once the transfer shows in our bank statement.'), setBank({ amount: '', ref: '', note: '' })) });
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Amount (${cur})`}>
                <Input inputMode="decimal" value={bank.amount} onChange={(e) => setBank({ ...bank, amount: e.target.value })} />
              </Field>
              <Field label="UTR / transaction reference">
                <Input value={bank.ref} onChange={(e) => setBank({ ...bank, ref: e.target.value })} />
              </Field>
            </div>
            <Field label="Note for our accounts team" hint="Optional.">
              <Textarea value={bank.note} onChange={(e) => setBank({ ...bank, note: e.target.value })} />
            </Field>
            <ErrorNote error={transfer.error} />
            {sent && <p className="text-sm text-ok">{sent}</p>}
            <div>
              <Button type="submit" variant="secondary" busy={transfer.isPending} disabled={!bank.amount || !bank.ref}>
                Submit for review
              </Button>
            </div>
          </form>
        </Section>
      </div>
      <Section title="Deposits">
        <Table
          rows={deposits.data}
          rowKey={(d) => d.id}
          empty="No deposits yet."
          columns={[
            { key: 'w', header: 'Submitted', render: (d) => when(d.createdAt) },
            { key: 'm', header: 'Method', render: (d) => (d.method === 'GATEWAY' ? 'Online' : 'Bank transfer') },
            { key: 'r', header: 'Reference', render: (d) => d.bankReference ?? '—' },
            { key: 's', header: 'Status', render: (d) => <span title={d.rejectReason ?? undefined}><Status value={d.status} /></span> },
            { key: 'a', header: 'Amount', align: 'right', render: (d) => money(d.amountMinor, d.currency) },
          ]}
        />
      </Section>
      <Section title="Transactions">
        <LedgerTable rows={ledger.data} />
      </Section>
    </div>
  );
}
