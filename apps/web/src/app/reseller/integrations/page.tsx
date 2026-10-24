'use client';
import { useState } from 'react';
import { Button, Dialog, ErrorNote, Field, Input, PageHeader, Section, Select, SecretOnce, Status, Table } from '@/components/ui';
import { api, useAction, useApi, when } from '@/lib/api';

const SCOPES = ['products:read', 'orders:read', 'orders:write', 'services:read', 'services:write', 'wallet:read', 'wallet:write', 'ipam:read', 'ipam:write', 'webhooks:manage'];
const EVENTS = ['*', 'deposit.credited', 'deposit.rejected', 'order.created', 'order.failed', 'service.activated', 'service.suspended', 'service.unsuspended', 'service.terminated', 'service.renewed'];

interface Connection {
  id: string;
  platform: string;
  name: string;
  siteUrl: string | null;
  lastSeenAt: string | null;
}
interface Key {
  id: string;
  name: string;
  keyId: string;
  scopes: string[];
  ipAllowlist: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
interface Endpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}
interface Delivery {
  id: string;
  type: string;
  url: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
}

export default function Integrations() {
  const conns = useApi<Connection[]>('v1/reseller/integrations');
  const keys = useApi<Key[]>('v1/reseller/api-keys');
  const hooks = useApi<Endpoint[]>('v1/reseller/webhooks');
  const deliveries = useApi<Delivery[]>('v1/reseller/webhooks/deliveries', { refetchInterval: 15_000 });
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [dialog, setDialog] = useState<'whmcs' | 'key' | 'hook' | null>(null);
  const [f, setF] = useState({ name: '', siteUrl: '', platform: 'WHMCS', ips: '', scopes: ['products:read', 'orders:read', 'orders:write', 'services:read', 'services:write', 'wallet:read'], url: '', events: ['*'] });
  const ipList = () => f.ips.split(/[,\s]+/).filter(Boolean);

  const connect = useAction(
    () => api<{ apiKey: string }>('v1/reseller/integrations', { method: 'POST', body: { platform: f.platform, name: f.name, siteUrl: f.siteUrl || undefined, ipAllowlist: ipList() } }),
    ['v1/reseller/integrations', 'v1/reseller/api-keys'],
  );
  const mkKey = useAction(() => api<{ apiKey: string }>('v1/reseller/api-keys', { method: 'POST', body: { name: f.name, scopes: f.scopes, ipAllowlist: ipList() } }), ['v1/reseller/api-keys']);
  const revoke = useAction((id: string) => api(`v1/reseller/api-keys/${id}`, { method: 'DELETE' }), ['v1/reseller/api-keys']);
  const mkHook = useAction(() => api<{ secret: string }>('v1/reseller/webhooks', { method: 'POST', body: { url: f.url, events: f.events } }), ['v1/reseller/webhooks']);
  const delHook = useAction((id: string) => api(`v1/reseller/webhooks/${id}`, { method: 'DELETE' }), ['v1/reseller/webhooks']);
  const redeliver = useAction((id: string) => api(`v1/reseller/webhooks/deliveries/${id}/retry`, { method: 'POST' }), ['v1/reseller/webhooks/deliveries']);
  const close = () => setDialog(null);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div>
      <PageHeader title="WHMCS & API" intro="Connect your billing system so orders, renewals and suspensions reach us automatically." />
      {secret && (
        <div className="mb-6">
          <SecretOnce label={secret.label} value={secret.value} />
        </div>
      )}
      <ErrorNote error={revoke.error ?? delHook.error ?? redeliver.error} />

      <Section title="Billing systems" aside={<Button onClick={() => (setF({ ...f, name: '' }), setDialog('whmcs'))}>Connect billing system</Button>}>
        <Table
          rows={conns.data}
          rowKey={(c) => c.id}
          empty="Nothing connected yet. Connect WHMCS to sell our servers from your own site."
          columns={[
            { key: 'n', header: 'Name', render: (c) => c.name },
            { key: 'p', header: 'Platform', render: (c) => c.platform },
            { key: 'u', header: 'Site', render: (c) => c.siteUrl ?? '—' },
            { key: 's', header: 'Last contact', render: (c) => (c.lastSeenAt ? when(c.lastSeenAt) : 'Never — use “Test connection” in WHMCS') },
          ]}
        />
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-medium">How to set up WHMCS</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
            <li>Copy the <code>modules/servers/cloudpilot</code> folder from the CloudPilot WHMCS module into your WHMCS installation.</li>
            <li>In WHMCS go to System Settings › Servers, add a server of type CloudPilot, enter this platform&apos;s API address as hostname and the API key as the password, then click Test Connection.</li>
            <li>Create a product with module CloudPilot and enter our product SKU, datacenter code and billing cycle in the module settings.</li>
            <li>Orders paid in WHMCS are then built automatically and charged to your wallet.</li>
          </ol>
        </details>
      </Section>

      <Section title="API keys" aside={<Button variant="secondary" onClick={() => (setF({ ...f, name: '' }), setDialog('key'))}>Create API key</Button>}>
        <Table
          rows={keys.data}
          rowKey={(k) => k.id}
          empty="No API keys."
          columns={[
            { key: 'n', header: 'Name', render: (k) => k.name },
            { key: 'id', header: 'Key ID', render: (k) => <code className="text-xs">cp_{k.keyId}_…</code> },
            { key: 's', header: 'Permissions', render: (k) => <span className="text-xs text-muted">{k.scopes.join(', ')}</span> },
            { key: 'ip', header: 'Allowed IPs', render: (k) => (k.ipAllowlist.length ? k.ipAllowlist.join(', ') : 'Any') },
            { key: 'u', header: 'Last used', render: (k) => when(k.lastUsedAt) },
            { key: 'x', header: '', render: (k) => (k.revokedAt ? <Status value="REVOKED" /> : <Button variant="ghost" onClick={() => revoke.mutate(k.id)}>Revoke</Button>) },
          ]}
        />
      </Section>

      <Section title="Webhooks" aside={<Button variant="secondary" onClick={() => setDialog('hook')}>Add endpoint</Button>}>
        <Table
          rows={hooks.data?.filter((h) => h.active)}
          rowKey={(h) => h.id}
          empty="No webhook endpoints. Add one to be notified when servers go live or deposits clear."
          columns={[
            { key: 'u', header: 'URL', render: (h) => <code className="break-all text-xs">{h.url}</code> },
            { key: 'e', header: 'Events', render: (h) => h.events.join(', ') },
            { key: 'x', header: '', render: (h) => <Button variant="ghost" onClick={() => delHook.mutate(h.id)}>Remove</Button> },
          ]}
        />
        <h3 className="mb-2 mt-6 text-sm font-semibold">Recent deliveries</h3>
        <Table
          rows={deliveries.data}
          rowKey={(d) => d.id}
          empty="No deliveries yet."
          columns={[
            { key: 'w', header: 'When', render: (d) => when(d.createdAt) },
            { key: 't', header: 'Event', render: (d) => <code className="text-xs">{d.type}</code> },
            { key: 's', header: 'Result', render: (d) => <span title={d.lastError ?? undefined}><Status value={d.status} /></span> },
            { key: 'a', header: 'Attempts', align: 'right', render: (d) => `${d.attempts}${d.lastStatusCode ? ` · HTTP ${d.lastStatusCode}` : ''}` },
            { key: 'x', header: '', render: (d) => (['FAILED', 'DEAD'].includes(d.status) ? <Button variant="ghost" onClick={() => redeliver.mutate(d.id)}>Send again</Button> : null) },
          ]}
        />
      </Section>

      <Dialog open={dialog === 'whmcs'} onClose={close} title="Connect billing system">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => (e.preventDefault(), connect.mutate(undefined, { onSuccess: (r) => (setSecret({ label: 'API key for your billing system', value: r.apiKey }), close()) }))}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Platform">
              <Select value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })}>
                {['WHMCS', 'BLESTA', 'HOSTBILL', 'WISECP', 'CLIENTEXEC', 'CUSTOM'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </Field>
            <Field label="Name">
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Main WHMCS" required />
            </Field>
            <Field label="Site address">
              <Input value={f.siteUrl} onChange={(e) => setF({ ...f, siteUrl: e.target.value })} placeholder="https://billing.example.com" />
            </Field>
            <Field label="Server IPs allowed to use the key" hint="Recommended: your WHMCS server's public IP.">
              <Input value={f.ips} onChange={(e) => setF({ ...f, ips: e.target.value })} placeholder="198.51.100.7" />
            </Field>
          </div>
          <ErrorNote error={connect.error} />
          <div className="flex justify-end">
            <Button type="submit" busy={connect.isPending}>
              Connect and create key
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={dialog === 'key'} onClose={close} title="Create API key">
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), mkKey.mutate(undefined, { onSuccess: (r) => (setSecret({ label: 'New API key', value: r.apiKey }), close()) }))}>
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Permissions</legend>
            <div className="grid grid-cols-2 gap-1">
              {SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.scopes.includes(s)} onChange={() => setF({ ...f, scopes: toggle(f.scopes, s) })} />
                  <code className="text-xs">{s}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Allowed IPs" hint="Comma-separated addresses or CIDR ranges. Empty allows any.">
            <Input value={f.ips} onChange={(e) => setF({ ...f, ips: e.target.value })} />
          </Field>
          <ErrorNote error={mkKey.error} />
          <div className="flex justify-end">
            <Button type="submit" busy={mkKey.isPending} disabled={!f.scopes.length}>
              Create key
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={dialog === 'hook'} onClose={close} title="Add webhook endpoint">
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), mkHook.mutate(undefined, { onSuccess: (r) => (setSecret({ label: 'Webhook signing secret', value: r.secret }), close()) }))}>
          <Field label="HTTPS URL">
            <Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://example.com/cloudpilot/webhook" required />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Events</legend>
            <div className="grid grid-cols-2 gap-1">
              {EVENTS.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.events.includes(s)} onChange={() => setF({ ...f, events: toggle(f.events, s) })} />
                  {s === '*' ? 'Everything' : <code className="text-xs">{s}</code>}
                </label>
              ))}
            </div>
          </fieldset>
          <ErrorNote error={mkHook.error} />
          <div className="flex justify-end">
            <Button type="submit" busy={mkHook.isPending} disabled={!f.events.length}>
              Add endpoint
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
