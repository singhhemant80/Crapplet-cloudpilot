'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { Button, ErrorNote, Field, Input, Loading, PageHeader, Section, Select } from '@/components/ui';
import { api, money, newKey, useAction, useApi } from '@/lib/api';
import type { CatalogProduct, OrderDetail } from '@/lib/types';

function NewOrder() {
  const params = useSearchParams();
  const router = useRouter();
  const catalog = useApi<CatalogProduct[]>('v1/reseller/products');
  const [sku, setSku] = useState(params.get('sku') ?? '');
  const product = catalog.data?.find((p) => p.sku === sku) ?? catalog.data?.[0];
  const [locId, setLocId] = useState('');
  const location = product?.locations.find((l) => l.id === locId) ?? product?.locations[0];
  const [cycle, setCycle] = useState('');
  const price = product?.pricing.find((p) => p.cycle === cycle) ?? product?.pricing[0];
  const [templateId, setTemplateId] = useState('');
  const [hostname, setHostname] = useState('');
  const [password, setPassword] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [pickIp, setPickIp] = useState(false);
  const [ip, setIp] = useState('');
  const ips = useApi<Array<{ address: string }>>(pickIp && location?.ipv4PoolId ? `v1/reseller/ipam/pools/${location.ipv4PoolId}/available?limit=100` : null);
  // One idempotency key per form instance: double-clicks and retries cannot create two orders.
  const key = useMemo(() => `portal:${newKey()}`, []);

  const place = useAction(async () => {
    let ipReservationToken: string | undefined;
    if (pickIp && ip && location?.ipv4PoolId) {
      const r = await api<{ token: string }>('v1/reseller/ipam/reservations', { method: 'POST', body: { poolId: location.ipv4PoolId, address: ip } });
      ipReservationToken = r.token;
    }
    return api<OrderDetail>('v1/reseller/orders', {
      method: 'POST',
      idempotencyKey: key,
      body: {
        productSku: product!.sku,
        locationCode: location!.code,
        templateId: templateId || location!.templates[0].id,
        cycle: price!.cycle,
        hostname,
        password: password || undefined,
        sshKeys: sshKey.trim() ? [sshKey.trim()] : undefined,
        ipReservationToken,
      },
    });
  }, ['v1/reseller']);

  if (catalog.error) return <ErrorNote error={catalog.error} />;
  if (!catalog.data) return <Loading />;
  if (!product || !location || !price) return <p className="text-muted">No products are available to order yet.</p>;
  const total = BigInt(price.amountMinor) + BigInt(price.setupFeeMinor);

  return (
    <form
      className="grid gap-10 lg:grid-cols-[1fr_300px]"
      onSubmit={(e) => {
        e.preventDefault();
        place.mutate(undefined, { onSuccess: (o) => router.push(`/reseller/orders/${o.id}`) });
      }}
    >
      <div>
        <Section title="Plan">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Plan">
              <Select value={product.sku} onChange={(e) => setSku(e.target.value)}>
                {catalog.data.map((p) => (
                  <option key={p.sku} value={p.sku}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Datacenter">
              <Select value={location.id} onChange={(e) => (setLocId(e.target.value), setIp(''))}>
                {product.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Billing cycle">
              <Select value={price.cycle} onChange={(e) => setCycle(e.target.value)}>
                {product.pricing.map((p) => (
                  <option key={p.cycle} value={p.cycle}>
                    {p.cycle.toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Section>
        <Section title="Server">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Operating system">
              <Select value={templateId || location.templates[0]?.id} onChange={(e) => setTemplateId(e.target.value)}>
                {location.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Hostname">
              <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="web01.example.com" required />
            </Field>
            <Field label="Root password" hint="12+ characters. Stored encrypted only until the server is built.">
              <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="SSH public key" hint="Optional.">
              <Input value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="ssh-ed25519 AAAA…" />
            </Field>
          </div>
        </Section>
        {location.ipv4PoolId && (
          <Section title="IP address">
            <label className="mb-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pickIp} onChange={(e) => setPickIp(e.target.checked)} />
              Choose a specific IPv4 address
            </label>
            {pickIp &&
              (ips.data ? (
                ips.data.length ? (
                  <Field label="Address" hint="Held for you when you place the order.">
                    <Select value={ip} onChange={(e) => setIp(e.target.value)} className="max-w-xs">
                      <option value="">First free address</option>
                      {ips.data.map((a) => (
                        <option key={a.address}>{a.address}</option>
                      ))}
                    </Select>
                  </Field>
                ) : (
                  <p className="text-sm text-warn">No addresses are free in this datacenter right now.</p>
                )
              ) : (
                <Loading />
              ))}
          </Section>
        )}
      </div>
      <aside className="h-fit rounded-lg border border-line bg-surface p-5 lg:sticky lg:top-8">
        <h2 className="font-semibold">Summary</h2>
        <dl className="num mt-3 flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">{price.cycle.toLowerCase()}</dt>
            <dd>{money(price.amountMinor, price.currency)}</dd>
          </div>
          {price.setupFeeMinor !== '0' && (
            <div className="flex justify-between">
              <dt className="text-muted">Setup</dt>
              <dd>{money(price.setupFeeMinor, price.currency)}</dd>
            </div>
          )}
          <div className="mt-2 flex justify-between border-t border-line pt-2 font-semibold">
            <dt>Held from your wallet</dt>
            <dd>{money(total.toString(), price.currency)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">The amount is held now and only charged once the server is verified as running. If the build fails, it is returned.</p>
        <ErrorNote error={place.error} />
        <Button type="submit" className="mt-4 w-full" busy={place.isPending} disabled={!hostname}>
          Place order
        </Button>
      </aside>
    </form>
  );
}

export default function Page() {
  return (
    <div>
      <PageHeader title="New order" />
      <Suspense>
        <NewOrder />
      </Suspense>
    </div>
  );
}
