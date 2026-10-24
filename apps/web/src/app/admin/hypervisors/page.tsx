'use client';
import { useState } from 'react';
import { Button, Dialog, ErrorNote, Field, Input, PageHeader, Section, Select, Status, Table, Textarea } from '@/components/ui';
import { api, useAction, useApi, when } from '@/lib/api';

interface Provider {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  status: string;
  version: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  locationId: string;
  allowInsecureTls: boolean;
}
interface Inventory {
  nodes: Array<{ id: string; name: string; status: string; cpuCores: number | null; cpuUsage: number | null; memoryTotalBytes: number | null; memoryUsedBytes: number | null }>;
  storages: Array<{ id: string; node: string; externalId: string; type: string; contentTypes: string[]; totalBytes: number | null; usedBytes: number | null; shared: boolean }>;
  networks: Array<{ id: string; node: string; externalId: string; vlanAware: boolean }>;
  templates: Array<{ id: string; externalId: string; name: string; node: string; osFamily: string }>;
}

const gb = (b: number | null) => (b == null ? '—' : `${(b / 2 ** 30).toFixed(0)} GB`);
const pct = (used: number | null, total: number | null) => (used != null && total ? `${Math.round((used / total) * 100)}%` : '—');

function AddProvider({ onDone }: { onDone: () => void }) {
  const locs = useApi<Array<{ id: string; code: string; name: string }>>('v1/admin/locations');
  const [f, setF] = useState({ name: '', type: 'proxmox', endpoint: 'https://', locationId: '', tokenId: '', tokenSecret: '', ca: '', insecure: false });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = useAction(
    () =>
      api<Provider>('v1/admin/hypervisors', {
        method: 'POST',
        body: {
          name: f.name,
          type: f.type,
          endpoint: f.endpoint,
          locationId: f.locationId,
          credentials: f.type === 'proxmox' ? { tokenId: f.tokenId, tokenSecret: f.tokenSecret } : { note: 'mock' },
          caCertificate: f.ca || undefined,
          allowInsecureTls: f.insecure || undefined,
        },
      }),
    ['v1/admin/hypervisors'],
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
        <Field label="Name">
          <Input value={f.name} onChange={set('name')} placeholder="Mumbai PVE cluster" required />
        </Field>
        <Field label="Datacenter">
          <Select value={f.locationId} onChange={set('locationId')} required>
            <option value="">Choose…</option>
            {locs.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type">
          <Select value={f.type} onChange={set('type')}>
            <option value="proxmox">Proxmox VE</option>
            <option value="mock">Mock (development only)</option>
          </Select>
        </Field>
        <Field label="API endpoint" hint="https://host:8006">
          <Input value={f.endpoint} onChange={set('endpoint')} required />
        </Field>
      </div>
      {f.type === 'proxmox' && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="API token ID" hint="user@realm!tokenname">
              <Input value={f.tokenId} onChange={set('tokenId')} placeholder="cloudpilot@pve!automation" autoComplete="off" />
            </Field>
            <Field label="API token secret" hint="Encrypted at rest; never shown again.">
              <Input type="password" value={f.tokenSecret} onChange={set('tokenSecret')} autoComplete="off" />
            </Field>
          </div>
          <Field label="CA certificate (PEM)" hint="Paste the cluster's CA so its self-signed certificate can be verified.">
            <Textarea value={f.ca} onChange={set('ca')} placeholder="-----BEGIN CERTIFICATE-----" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.insecure} onChange={(e) => setF({ ...f, insecure: e.target.checked })} />
            Skip TLS verification (lab clusters only)
          </label>
        </>
      )}
      <ErrorNote error={create.error} />
      <div className="flex justify-end">
        <Button type="submit" busy={create.isPending}>
          Add hypervisor
        </Button>
      </div>
    </form>
  );
}

function InventoryView({ id }: { id: string }) {
  const { data } = useApi<Inventory>(`v1/admin/hypervisors/${id}/inventory`);
  if (!data) return null;
  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-2">
      <Section title="Nodes">
        <Table
          rows={data.nodes}
          rowKey={(n) => n.id}
          empty="No nodes discovered."
          columns={[
            { key: 'n', header: 'Node', render: (n) => n.name },
            { key: 's', header: 'Status', render: (n) => <Status value={n.status} /> },
            { key: 'c', header: 'CPU', align: 'right', render: (n) => `${n.cpuCores ?? '—'} cores · ${n.cpuUsage != null ? Math.round(n.cpuUsage * 100) : '—'}%` },
            { key: 'm', header: 'Memory', align: 'right', render: (n) => `${pct(n.memoryUsedBytes, n.memoryTotalBytes)} of ${gb(n.memoryTotalBytes)}` },
          ]}
        />
      </Section>
      <Section title="Storage">
        <Table
          rows={data.storages}
          rowKey={(s) => s.id}
          empty="No storage discovered."
          columns={[
            { key: 'n', header: 'Storage', render: (s) => `${s.externalId} on ${s.node}` },
            { key: 't', header: 'Type', render: (s) => `${s.type}${s.shared ? ' · shared' : ''}` },
            { key: 'u', header: 'Used', align: 'right', render: (s) => `${pct(s.usedBytes, s.totalBytes)} of ${gb(s.totalBytes)}` },
          ]}
        />
      </Section>
      <Section title="Bridges">
        <Table
          rows={data.networks}
          rowKey={(n) => n.id}
          empty="No bridges discovered."
          columns={[
            { key: 'n', header: 'Bridge', render: (n) => `${n.externalId} on ${n.node}` },
            { key: 'v', header: 'VLAN-aware', render: (n) => (n.vlanAware ? 'Yes' : 'No') },
          ]}
        />
      </Section>
      <Section title="Templates">
        <Table
          rows={data.templates}
          rowKey={(t) => t.id}
          empty="No VM templates found. Convert a cloud-init VM to a template on the cluster, then discover again."
          columns={[
            { key: 'n', header: 'Template', render: (t) => t.name },
            { key: 'i', header: 'VM ID', render: (t) => t.externalId },
            { key: 'o', header: 'OS', render: (t) => t.osFamily },
          ]}
        />
      </Section>
    </div>
  );
}

function AddLocation({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ code: '', name: '', country: 'IN' });
  const create = useAction(() => api('v1/admin/locations', { method: 'POST', body: { ...f, code: f.code.toUpperCase() } }), ['v1/admin/locations']);
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), create.mutate(undefined, { onSuccess: onDone }))}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Code" hint="Used in the API, e.g. IN-MUM-1">
          <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required />
        </Field>
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Mumbai DC1" required />
        </Field>
        <Field label="Country">
          <Input value={f.country} maxLength={2} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} required />
        </Field>
      </div>
      <ErrorNote error={create.error} />
      <div className="flex justify-end">
        <Button type="submit" busy={create.isPending}>Add datacenter</Button>
      </div>
    </form>
  );
}

export default function Hypervisors() {
  const [addingLoc, setAddingLoc] = useState(false);
  const { data, error } = useApi<Provider[]>('v1/admin/hypervisors');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const test = useAction((id: string) => api<{ ok: boolean; version?: string; message?: string }>(`v1/admin/hypervisors/${id}/test`, { method: 'POST' }), ['v1/admin/hypervisors']);
  const discover = useAction(
    (id: string) => api<{ nodes: number; storage: number; networks: number; templates: number }>(`v1/admin/hypervisors/${id}/discover`, { method: 'POST' }),
    ['v1/admin/hypervisors'],
  );
  return (
    <div>
      <PageHeader title="Hypervisors" intro="Clusters CloudPilot provisions on. Credentials are encrypted and never leave the server." actions={<><Button variant="secondary" onClick={() => setAddingLoc(true)}>Add datacenter</Button><Button onClick={() => setAdding(true)}>Add hypervisor</Button></>} />
      <ErrorNote error={error ?? test.error ?? discover.error} />
      {result && <p className="mb-4 text-sm text-ok">{result}</p>}
      <Table
        rows={data}
        rowKey={(p) => p.id}
        empty="No hypervisors yet. Add a Proxmox cluster to start provisioning."
        columns={[
          { key: 'n', header: 'Name', render: (p) => <button className="text-rack hover:underline" onClick={() => setOpenId(openId === p.id ? null : p.id)}>{p.name}</button> },
          { key: 't', header: 'Type', render: (p) => (p.type === 'mock' ? 'Mock (no real VMs)' : `Proxmox ${p.version ?? ''}`) },
          { key: 'e', header: 'Endpoint', render: (p) => <code className="text-xs">{p.endpoint}</code> },
          { key: 's', header: 'Status', render: (p) => <span title={p.lastError ?? undefined}><Status value={p.status} /></span> },
          { key: 'c', header: 'Checked', render: (p) => when(p.lastCheckedAt) },
          {
            key: 'x',
            header: '',
            render: (p) => (
              <div className="flex gap-2">
                <Button variant="secondary" busy={test.isPending && test.variables === p.id} onClick={() => test.mutate(p.id, { onSuccess: (r) => setResult(r.ok ? `${p.name}: connected (${r.version})` : `${p.name}: ${r.message}`) })}>
                  Test
                </Button>
                <Button
                  variant="secondary"
                  busy={discover.isPending && discover.variables === p.id}
                  onClick={() => discover.mutate(p.id, { onSuccess: (r) => (setOpenId(p.id), setResult(`${p.name}: found ${r.nodes} nodes, ${r.storage} storages, ${r.networks} bridges, ${r.templates} templates`)) })}
                >
                  Discover
                </Button>
              </div>
            ),
          },
        ]}
      />
      {openId && <InventoryView id={openId} key={`${openId}-${discover.submittedAt}`} />}
      <Dialog open={addingLoc} onClose={() => setAddingLoc(false)} title="Add datacenter">
        <AddLocation onDone={() => setAddingLoc(false)} />
      </Dialog>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add hypervisor">
        <AddProvider onDone={() => setAdding(false)} />
      </Dialog>
    </div>
  );
}
