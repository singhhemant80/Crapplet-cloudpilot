'use client';
import { useState } from 'react';
import { Button, Dialog, ErrorNote, Field, Input, PageHeader, Section, Select, Status, Table } from '@/components/ui';
import { api, mb, money, toMinor, useAction, useApi } from '@/lib/api';

interface Product {
  id: string;
  sku: string;
  name: string;
  type: string;
  status: string;
  provisioning: string;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  ipv4Count: number;
  ipv6Count: number;
  placements: Array<{ id: string; locationId: string; providerId: string; node: string; templateIds: string[]; ipv4PoolId: string | null; vlanTag: number | null; enabled: boolean }>;
  prices: Array<{ id: string; priceListId: string; cycle: string; amountMinor: string; setupFeeMinor: string }>;
}
interface PriceList {
  id: string;
  name: string;
  currency: string;
  isDefaultWholesale: boolean;
}

function NewProduct({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ sku: '', name: '', type: 'VPS_LINUX', cpuCores: '2', memoryMb: '4096', diskGb: '80', bandwidthGb: '2000', provisioning: 'AUTOMATIC' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = useAction(
    () =>
      api('v1/admin/products', {
        method: 'POST',
        body: { ...f, sku: f.sku.toUpperCase(), cpuCores: +f.cpuCores, memoryMb: +f.memoryMb, diskGb: +f.diskGb, bandwidthGb: +f.bandwidthGb, ipv4Count: 1, status: 'DRAFT' },
      }),
    ['v1/admin/products'],
  );
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), create.mutate(undefined, { onSuccess: onDone }))}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={f.name} onChange={set('name')} placeholder="Linux VPS M" required />
        </Field>
        <Field label="SKU" hint="Resellers and WHMCS refer to the product by this code.">
          <Input value={f.sku} onChange={set('sku')} placeholder="VPS-2C4G" required />
        </Field>
        <Field label="Kind">
          <Select value={f.type} onChange={set('type')}>
            <option value="VPS_LINUX">Linux VPS</option>
            <option value="VPS_WINDOWS">Windows VPS</option>
            <option value="VPS_FOREX">Forex VPS</option>
            <option value="VPS_MINECRAFT">Minecraft VPS</option>
            <option value="GPU_CLOUD">GPU cloud server</option>
          </Select>
        </Field>
        <Field label="Provisioning">
          <Select value={f.provisioning} onChange={set('provisioning')}>
            <option value="AUTOMATIC">Automatic after payment</option>
            <option value="MANUAL_APPROVAL">Hold for staff approval</option>
          </Select>
        </Field>
        <Field label="vCPU">
          <Input inputMode="numeric" value={f.cpuCores} onChange={set('cpuCores')} />
        </Field>
        <Field label="Memory (MB)">
          <Input inputMode="numeric" value={f.memoryMb} onChange={set('memoryMb')} />
        </Field>
        <Field label="Disk (GB)">
          <Input inputMode="numeric" value={f.diskGb} onChange={set('diskGb')} />
        </Field>
        <Field label="Monthly bandwidth (GB)">
          <Input inputMode="numeric" value={f.bandwidthGb} onChange={set('bandwidthGb')} />
        </Field>
      </div>
      <p className="text-sm text-muted">New products start as drafts. Map them to a datacenter and give them a price, then publish.</p>
      <ErrorNote error={create.error} />
      <div className="flex justify-end">
        <Button type="submit" busy={create.isPending}>
          Create draft
        </Button>
      </div>
    </form>
  );
}

function Placement({ product, onDone }: { product: Product; onDone: () => void }) {
  const locs = useApi<Array<{ id: string; name: string }>>('v1/admin/locations');
  const provs = useApi<Array<{ id: string; name: string; locationId: string }>>('v1/admin/hypervisors');
  const pools = useApi<Array<{ id: string; name: string; version: number; location_id: string }>>('v1/admin/ip-pools');
  const existing = product.placements[0];
  const [f, setF] = useState({
    locationId: existing?.locationId ?? '',
    providerId: existing?.providerId ?? '',
    node: existing?.node ?? '',
    storage: '',
    bridge: 'vmbr0',
    vlanTag: existing?.vlanTag ? String(existing.vlanTag) : '',
    ipv4PoolId: existing?.ipv4PoolId ?? '',
    templateIds: existing?.templateIds ?? ([] as string[]),
  });
  const inv = useApi<{ nodes: Array<{ name: string }>; storages: Array<{ node: string; externalId: string; contentTypes: string[] }>; networks: Array<{ node: string; externalId: string }>; templates: Array<{ id: string; name: string }> }>(
    f.providerId ? `v1/admin/hypervisors/${f.providerId}/inventory` : null,
  );
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      api(`v1/admin/products/${product.id}/placements`, {
        method: 'PUT',
        body: { ...f, storage: f.storage || undefined, vlanTag: f.vlanTag ? Number(f.vlanTag) : undefined, ipv4PoolId: f.ipv4PoolId || undefined },
      }),
    ['v1/admin/products'],
  );
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), save.mutate(undefined, { onSuccess: onDone }))}>
      <div className="grid gap-4 sm:grid-cols-2">
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
        <Field label="Hypervisor">
          <Select value={f.providerId} onChange={set('providerId')} required>
            <option value="">Choose…</option>
            {provs.data?.filter((p) => !f.locationId || p.locationId === f.locationId).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Node">
          <Select value={f.node} onChange={set('node')} required>
            <option value="">Choose…</option>
            {inv.data?.nodes.map((n) => (
              <option key={n.name}>{n.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Disk storage">
          <Select value={f.storage} onChange={set('storage')}>
            <option value="">Template default</option>
            {inv.data?.storages.filter((s) => s.node === f.node && s.contentTypes.includes('images')).map((s) => (
              <option key={s.externalId}>{s.externalId}</option>
            ))}
          </Select>
        </Field>
        <Field label="Bridge">
          <Select value={f.bridge} onChange={set('bridge')}>
            {[...new Set((inv.data?.networks ?? []).filter((n) => !f.node || n.node === f.node).map((n) => n.externalId))].map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
        </Field>
        <Field label="VLAN tag">
          <Input inputMode="numeric" value={f.vlanTag} onChange={set('vlanTag')} />
        </Field>
        <Field label="IPv4 pool">
          <Select value={f.ipv4PoolId} onChange={set('ipv4PoolId')} required={product.ipv4Count > 0}>
            <option value="">Choose…</option>
            {pools.data?.filter((p) => p.version === 4 && (!f.locationId || p.location_id === f.locationId)).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Operating systems offered</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {inv.data?.templates.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={f.templateIds.includes(t.id)}
                onChange={(e) => setF({ ...f, templateIds: e.target.checked ? [...f.templateIds, t.id] : f.templateIds.filter((x) => x !== t.id) })}
              />
              {t.name}
            </label>
          )) ?? <span className="text-sm text-muted">Choose a hypervisor to list its templates.</span>}
        </div>
      </fieldset>
      <ErrorNote error={save.error} />
      <div className="flex justify-end">
        <Button type="submit" busy={save.isPending}>
          Save placement
        </Button>
      </div>
    </form>
  );
}

function SetPrice({ product, lists, onDone }: { product: Product; lists: PriceList[]; onDone: () => void }) {
  const [f, setF] = useState({ priceListId: lists.find((l) => l.isDefaultWholesale)?.id ?? lists[0]?.id ?? '', cycle: 'MONTHLY', amount: '', setup: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(() => {
    const amount = toMinor(f.amount);
    if (!amount) throw new Error('Enter a price like 549 or 549.00');
    return api(`v1/admin/price-lists/${f.priceListId}/prices`, { method: 'PUT', body: { productId: product.id, cycle: f.cycle, amountMinor: amount, setupFeeMinor: toMinor(f.setup || '0') } });
  }, ['v1/admin/products']);
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), save.mutate(undefined, { onSuccess: onDone }))}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Price list">
          <Select value={f.priceListId} onChange={set('priceListId')}>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.currency})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Billing cycle">
          <Select value={f.cycle} onChange={set('cycle')}>
            {['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONE_TIME'].map((c) => (
              <option key={c} value={c}>
                {c.toLowerCase().replace('_', '-')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Wholesale price">
          <Input inputMode="decimal" value={f.amount} onChange={set('amount')} required />
        </Field>
        <Field label="Setup fee">
          <Input inputMode="decimal" value={f.setup} onChange={set('setup')} placeholder="0" />
        </Field>
      </div>
      <ErrorNote error={save.error} />
      <div className="flex justify-end">
        <Button type="submit" busy={save.isPending}>
          Save price
        </Button>
      </div>
    </form>
  );
}

export default function Products() {
  const products = useApi<Product[]>('v1/admin/products');
  const lists = useApi<PriceList[]>('v1/admin/price-lists');
  const [dialog, setDialog] = useState<{ kind: 'new' | 'placement' | 'price' | 'list'; product?: Product } | null>(null);
  const [listName, setListName] = useState('');
  const publish = useAction((p: Product) => api(`v1/admin/products/${p.id}`, { method: 'PATCH', body: { status: p.status === 'ACTIVE' ? 'RETIRED' : 'ACTIVE' } }), ['v1/admin/products']);
  const createList = useAction(() => api('v1/admin/price-lists', { method: 'POST', body: { name: listName, currency: 'INR', isDefaultWholesale: !(lists.data ?? []).length } }), ['v1/admin/price-lists']);
  const listName_ = (id: string) => lists.data?.find((l) => l.id === id);
  const close = () => setDialog(null);

  return (
    <div>
      <PageHeader
        title="Products & pricing"
        intro="What resellers can buy, where it runs, and what it costs them."
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog({ kind: 'list' })}>
              New price list
            </Button>
            <Button onClick={() => setDialog({ kind: 'new' })}>New product</Button>
          </>
        }
      />
      <ErrorNote error={products.error ?? publish.error} />
      <Table
        rows={products.data}
        rowKey={(p) => p.id}
        filter={(p) => `${p.sku} ${p.name}`}
        empty="No products yet. Create a VPS plan to start selling."
        columns={[
          { key: 'n', header: 'Product', sort: (p) => p.name, render: (p) => <div><div>{p.name}</div><code className="text-xs text-muted">{p.sku}</code></div> },
          { key: 'r', header: 'Resources', render: (p) => `${p.cpuCores} vCPU · ${mb(p.memoryMb)} · ${p.diskGb} GB` },
          { key: 'pl', header: 'Runs in', render: (p) => (p.placements.length ? `${p.placements.length} location${p.placements.length > 1 ? 's' : ''}` : <span className="text-warn">Not mapped</span>) },
          {
            key: 'pr',
            header: 'Wholesale',
            render: (p) =>
              p.prices.length ? (
                <ul className="num text-xs">
                  {p.prices.map((x) => (
                    <li key={x.id}>
                      {x.cycle.toLowerCase()}: {money(x.amountMinor, listName_(x.priceListId)?.currency)} <span className="text-muted">({listName_(x.priceListId)?.name})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-warn">No price</span>
              ),
          },
          { key: 's', header: 'Status', render: (p) => <Status value={p.status} /> },
          {
            key: 'x',
            header: '',
            render: (p) => (
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => setDialog({ kind: 'placement', product: p })}>
                  Placement
                </Button>
                <Button variant="ghost" onClick={() => setDialog({ kind: 'price', product: p })} disabled={!lists.data?.length}>
                  Price
                </Button>
                <Button variant="ghost" onClick={() => publish.mutate(p)} disabled={p.status !== 'ACTIVE' && (!p.placements.length || !p.prices.length)}>
                  {p.status === 'ACTIVE' ? 'Retire' : 'Publish'}
                </Button>
              </div>
            ),
          },
        ]}
      />
      <Section title="Price lists">
        <Table
          rows={lists.data}
          rowKey={(l) => l.id}
          empty="No price lists. Create the default wholesale list first."
          columns={[
            { key: 'n', header: 'Name', render: (l) => l.name },
            { key: 'c', header: 'Currency', render: (l) => l.currency },
            { key: 'd', header: 'Used for', render: (l) => (l.isDefaultWholesale ? 'All resellers without their own list' : 'Resellers assigned to it') },
          ]}
        />
      </Section>
      <Dialog open={dialog?.kind === 'new'} onClose={close} title="New product">
        <NewProduct onDone={close} />
      </Dialog>
      <Dialog open={dialog?.kind === 'placement'} onClose={close} title={`Where ${dialog?.product?.name ?? ''} runs`}>
        {dialog?.product && <Placement product={dialog.product} onDone={close} />}
      </Dialog>
      <Dialog open={dialog?.kind === 'price'} onClose={close} title={`Price ${dialog?.product?.name ?? ''}`}>
        {dialog?.product && lists.data && <SetPrice product={dialog.product} lists={lists.data} onDone={close} />}
      </Dialog>
      <Dialog open={dialog?.kind === 'list'} onClose={close} title="New price list">
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), createList.mutate(undefined, { onSuccess: close }))}>
          <Field label="Name" hint="The first list you create becomes the default wholesale list.">
            <Input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="Gold partners INR" required />
          </Field>
          <ErrorNote error={createList.error} />
          <div className="flex justify-end">
            <Button type="submit" busy={createList.isPending}>
              Create list
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
