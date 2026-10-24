'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button, Dialog, ErrorNote, Field, Input, PageHeader, Select, Status, Table } from '@/components/ui';
import { api, money, toMinor, useAction, useApi } from '@/lib/api';
import type { Balances } from '@/lib/types';

interface Reseller {
  id: string;
  name: string;
  contactEmail: string;
  status: string;
  model: string;
  currency: string;
  balances: Balances;
}

const schema = z
  .object({
    name: z.string().min(2, 'Company name is required'),
    contactEmail: z.string().email('Enter a billing contact email'),
    model: z.enum(['PREPAID', 'CREDIT', 'COMMISSION']),
    currency: z.string().regex(/^[A-Z]{3}$/),
    creditLimit: z.string().optional(),
    priceListId: z.string().optional(),
    adminName: z.string().min(2, 'Name of the person who will sign in'),
    adminEmail: z.string().email('Sign-in email'),
    adminPassword: z.string().min(12, 'At least 12 characters'),
  })
  .refine((v) => v.model !== 'CREDIT' || (v.creditLimit && toMinor(v.creditLimit)), { path: ['creditLimit'], message: 'Credit resellers need a credit limit' });

function CreateReseller({ onDone }: { onDone: () => void }) {
  const lists = useApi<Array<{ id: string; name: string; currency: string }>>('v1/admin/price-lists');
  const { register, handleSubmit, watch, formState } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { model: 'PREPAID', currency: 'INR' },
  });
  const create = useAction(
    (v: z.infer<typeof schema>) =>
      api('v1/admin/resellers', {
        method: 'POST',
        body: {
          name: v.name,
          contactEmail: v.contactEmail,
          model: v.model,
          currency: v.currency,
          creditLimitMinor: v.model === 'CREDIT' ? toMinor(v.creditLimit ?? '') : undefined,
          priceListId: v.priceListId || undefined,
          admin: { name: v.adminName, email: v.adminEmail, password: v.adminPassword },
        },
      }),
    ['v1/admin/resellers'],
  );
  const e = formState.errors;
  return (
    <form onSubmit={handleSubmit((v) => create.mutate(v, { onSuccess: onDone }))} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name" error={e.name?.message}>
          <Input {...register('name')} />
        </Field>
        <Field label="Billing contact" error={e.contactEmail?.message}>
          <Input type="email" {...register('contactEmail')} />
        </Field>
        <Field label="Business model" hint="Prepaid spends wallet balance; credit may go negative up to a limit.">
          <Select {...register('model')}>
            <option value="PREPAID">Prepaid wallet</option>
            <option value="CREDIT">Credit line</option>
            <option value="COMMISSION">Commission (referrals only)</option>
          </Select>
        </Field>
        <Field label="Wallet currency">
          <Select {...register('currency')}>
            <option>INR</option>
            <option>USD</option>
          </Select>
        </Field>
        {watch('model') === 'CREDIT' && (
          <Field label="Credit limit" error={e.creditLimit?.message} hint="In major units, e.g. 50000">
            <Input inputMode="decimal" {...register('creditLimit')} />
          </Field>
        )}
        <Field label="Price list" hint="Leave on default to use the standard wholesale list.">
          <Select {...register('priceListId')}>
            <option value="">Default wholesale list</option>
            {lists.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.currency})
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className="grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">Reseller sign-in</legend>
        <Field label="Name" error={e.adminName?.message}>
          <Input {...register('adminName')} />
        </Field>
        <Field label="Email" error={e.adminEmail?.message}>
          <Input type="email" {...register('adminEmail')} />
        </Field>
        <Field label="Initial password" error={e.adminPassword?.message}>
          <Input type="password" autoComplete="new-password" {...register('adminPassword')} />
        </Field>
      </fieldset>
      <ErrorNote error={create.error} />
      <div className="flex justify-end">
        <Button type="submit" busy={create.isPending}>
          Create reseller
        </Button>
      </div>
    </form>
  );
}

export default function Resellers() {
  const { data, error } = useApi<Reseller[]>('v1/admin/resellers');
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader title="Resellers" intro="Partners who sell our services through their own billing systems." actions={<Button onClick={() => setOpen(true)}>Add reseller</Button>} />
      <ErrorNote error={error} />
      <Table
        rows={data}
        rowKey={(r) => r.id}
        filter={(r) => `${r.name} ${r.contactEmail}`}
        empty="No resellers yet. Add one to start selling wholesale."
        columns={[
          { key: 'n', header: 'Reseller', sort: (r) => r.name, render: (r) => <Link href={`/admin/resellers/${r.id}`} className="text-rack hover:underline">{r.name}</Link> },
          { key: 'm', header: 'Model', render: (r) => r.model.toLowerCase() },
          { key: 's', header: 'Status', render: (r) => <Status value={r.status} /> },
          { key: 'a', header: 'Available', align: 'right', sort: (r) => Number(r.balances.availableMinor), render: (r) => money(r.balances.availableMinor, r.currency) },
          { key: 'h', header: 'Held for orders', align: 'right', render: (r) => money(r.balances.reservedMinor, r.currency) },
          { key: 'c', header: 'Credit used', align: 'right', render: (r) => (r.model === 'CREDIT' ? `${money(r.balances.creditUsedMinor, r.currency)} of ${money(r.balances.creditLimitMinor, r.currency)}` : '—') },
        ]}
      />
      <Dialog open={open} onClose={() => setOpen(false)} title="Add reseller">
        <CreateReseller onDone={() => setOpen(false)} />
      </Dialog>
    </div>
  );
}
