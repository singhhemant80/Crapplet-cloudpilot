'use client';
import { useState } from 'react';
import { Button, Dialog, ErrorNote, Field, Input, PageHeader, Section, Select, Status, Table } from '@/components/ui';
import { api, useAction, useApi, when } from '@/lib/api';

interface Pool {
  id: string;
  name: string;
  version: number;
  cidr: string;
  gateway: string | null;
  vlan_tag: number | null;
  location_code: string;
  available: string;
  reserved: string;
  allocated: string;
  quarantined: string;
  total: string;
}
interface Address {
  id: string;
  address: string;
  status: string;
  serviceId: string | null;
  orderId: string | null;
  reservedUntil: string | null;
  quarantineUntil: string | null;
}

function CreatePool({ onDone }: { onDone: () => void }) {
  const locs = useApi<Array<{ id: string; code: string; name: string }>>('v1/admin/locations');
  const [f, setF] = useState({ name: '', locationId: '', cidr: '', gateway: '', nameservers: '1.1.1.1, 8.8.8.8', vlanTag: '', rangeStart: '', rangeEnd: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = useAction(
    () =>
      api<{ imported: number; skippedExisting: number }>('v1/admin/ip-pools', {
        method: 'POST',
        body: {
          name: f.name,
          locationId: f.locationId,
          cidr: f.cidr,
          gateway: f.gateway || undefined,
          nameservers: f.nameservers.split(/[,\s]+/).filter(Boolean),
          vlanTag: f.vlanTag ? Number(f.vlanTag) : undefined,
          rangeStart: f.rangeStart || undefined,
          rangeEnd: f.rangeEnd || undefined,
        },
      }),
    ['v1/admin/ip-pools'],
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Pool name">
          <Input value={f.name} onChange={set('name')} placeholder="Mumbai public v4" required />
        </Field>
        <Field label="Datacenter">
          <Select value={f.locationId} onChange={set('locationId')} required>
            <option value="">Choose…</option>
            {locs.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Subnet (CIDR)" hint="e.g. 203.0.113.0/26 or 2001:db8:10::/64">
          <Input value={f.cidr} onChange={set('cidr')} required />
        </Field>
        <Field label="Gateway">
          <Input value={f.gateway} onChange={set('gateway')} />
        </Field>
        <Field label="First usable address" hint="Optional. Required for large IPv6 subnets.">
          <Input value={f.rangeStart} onChange={set('rangeStart')} />
        </Field>
        <Field label="Last usable address">
          <Input value={f.rangeEnd} onChange={set('rangeEnd')} />
        </Field>
        <Field label="DNS resolvers">
          <Input value={f.nameservers} onChange={set('nameservers')} />
        </Field>
        <Field label="VLAN tag">
          <Input inputMode="numeric" value={f.vlanTag} onChange={set('vlanTag')} />
        </Field>
      </div>
      <ErrorNote error={create.error} />
      <div className="flex justify-end">
        <Button type="submit" busy={create.isPending}>
          Create pool
        </Button>
      </div>
    </form>
  );
}

export default function Ipam() {
  const pools = useApi<Pool[]>('v1/admin/ip-pools');
  const [poolId, setPoolId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const addrs = useApi<Address[]>(poolId ? `v1/admin/ip-pools/${poolId}/addresses${status ? `?status=${status}` : ''}` : null);
  const [adding, setAdding] = useState(false);
  const pool = pools.data?.find((p) => p.id === poolId);
  return (
    <div>
      <PageHeader title="IP addresses" intro="Pools of public addresses. Released addresses rest in quarantine before they are handed out again." actions={<Button onClick={() => setAdding(true)}>Add pool</Button>} />
      <ErrorNote error={pools.error} />
      <Table
        rows={pools.data}
        rowKey={(p) => p.id}
        empty="No IP pools yet. Add the subnets your datacenter routes to you."
        columns={[
          { key: 'n', header: 'Pool', render: (p) => <button className="text-rack hover:underline" onClick={() => setPoolId(p.id)}>{p.name}</button> },
          { key: 'c', header: 'Subnet', render: (p) => <code className="text-xs">{p.cidr}</code> },
          { key: 'l', header: 'Location', render: (p) => p.location_code },
          { key: 'v', header: 'VLAN', render: (p) => p.vlan_tag ?? '—' },
          { key: 'a', header: 'Free', align: 'right', render: (p) => p.available },
          { key: 'u', header: 'In use', align: 'right', render: (p) => p.allocated },
          { key: 'r', header: 'Held', align: 'right', render: (p) => p.reserved },
          { key: 'q', header: 'Quarantine', align: 'right', render: (p) => p.quarantined },
          {
            key: 'bar',
            header: 'Utilisation',
            render: (p) => {
              const used = (Number(p.allocated) + Number(p.reserved)) / Math.max(1, Number(p.total));
              return (
                <div className="h-2 w-28 overflow-hidden rounded-full bg-idle-bg" role="img" aria-label={`${Math.round(used * 100)}% used`}>
                  <div className={used > 0.85 ? 'h-full bg-warn' : 'h-full bg-rack'} style={{ width: `${used * 100}%` }} />
                </div>
              );
            },
          },
        ]}
      />
      {pool && (
        <Section
          title={`Addresses in ${pool.name}`}
          aside={
            <Select aria-label="Filter addresses" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="AVAILABLE">Free</option>
              <option value="RESERVED">Held</option>
              <option value="ALLOCATED">In use</option>
              <option value="QUARANTINED">Quarantine</option>
            </Select>
          }
        >
          <div className="mt-2" />
          <Table
            rows={addrs.data}
            rowKey={(a) => a.id}
            filter={(a) => a.address}
            empty="No addresses in this state."
            columns={[
              { key: 'a', header: 'Address', render: (a) => <code>{a.address}</code> },
              { key: 's', header: 'State', render: (a) => <Status value={a.status} /> },
              {
                key: 'd',
                header: 'Detail',
                render: (a) =>
                  a.status === 'ALLOCATED' ? (
                    <a className="text-rack hover:underline" href={`/admin/services/${a.serviceId}`}>Open service</a>
                  ) : a.status === 'RESERVED' ? (
                    a.orderId ? <a className="text-rack hover:underline" href={`/admin/orders/${a.orderId}`}>Held for an order</a> : `Checkout hold until ${when(a.reservedUntil)}`
                  ) : a.status === 'QUARANTINED' ? (
                    `Free again ${when(a.quarantineUntil)}`
                  ) : (
                    ''
                  ),
              },
            ]}
          />
        </Section>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add IP pool">
        <CreatePool onDone={() => setAdding(false)} />
      </Dialog>
    </div>
  );
}
