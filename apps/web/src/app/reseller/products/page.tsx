'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorNote, Field, Input, Loading, PageHeader, Select } from '@/components/ui';
import { mb, money, toMinor, useApi } from '@/lib/api';
import type { CatalogProduct } from '@/lib/types';

/** Retail price & margin calculator for one product. */
function MarginCalc({ p }: { p: CatalogProduct }) {
  const [cycle, setCycle] = useState(p.pricing[0].cycle);
  const [retail, setRetail] = useState('');
  const price = p.pricing.find((x) => x.cycle === cycle)!;
  const retailMinor = toMinor(retail);
  const cost = BigInt(price.amountMinor);
  const margin = retailMinor ? BigInt(retailMinor) - cost : null;
  const pct = retailMinor && BigInt(retailMinor) > 0n ? Number((margin! * 10000n) / BigInt(retailMinor)) / 100 : null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Cycle">
        <Select value={cycle} onChange={(e) => setCycle(e.target.value)}>
          {p.pricing.map((x) => (
            <option key={x.cycle} value={x.cycle}>
              {x.cycle.toLowerCase()}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Your retail price">
        <Input inputMode="decimal" className="w-32" value={retail} onChange={(e) => setRetail(e.target.value)} placeholder="e.g. 899" />
      </Field>
      <div className="num pb-2 text-sm">
        {margin === null ? (
          <span className="text-muted">Enter a price to see your margin</span>
        ) : (
          <span className={margin < 0n ? 'text-bad' : 'text-ok'}>
            Margin {money(margin.toString(), price.currency)} ({pct}%)
          </span>
        )}
      </div>
    </div>
  );
}

export default function ResellerProducts() {
  const { data, error } = useApi<CatalogProduct[]>('v1/reseller/products');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  return (
    <div>
      <PageHeader title="Products & prices" intro="Your wholesale cost for each plan. Set your own retail prices in WHMCS; the calculator shows what you keep." />
      {data.length === 0 && <p className="text-muted">No products are available to your account yet.</p>}
      <ul className="flex flex-col gap-px overflow-hidden rounded-lg border border-line bg-line">
        {data.map((p) => (
          <li key={p.id} className="bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">{p.name}</h2>
                <p className="text-sm text-muted">
                  {p.specs.cpuCores} vCPU · {mb(p.specs.memoryMb)} RAM · {p.specs.diskGb} GB disk{p.specs.bandwidthGb ? ` · ${p.specs.bandwidthGb} GB transfer` : ''} · SKU <code>{p.sku}</code>
                </p>
                <p className="mt-1 text-sm text-muted">
                  {p.locations.map((l) => l.name).join(', ')} · {p.locations.flatMap((l) => l.templates.map((t) => t.name)).join(', ')}
                </p>
              </div>
              <div className="num text-right">
                {p.pricing.map((x) => (
                  <div key={x.cycle} className="text-sm">
                    <span className="font-semibold">{money(x.amountMinor, x.currency)}</span> <span className="text-muted">/ {x.cycle.toLowerCase()}</span>
                    {x.setupFeeMinor !== '0' && <span className="text-muted"> + {money(x.setupFeeMinor, x.currency)} setup</span>}
                  </div>
                ))}
                <Link href={`/reseller/orders/new?sku=${p.sku}`} className="mt-2 inline-block text-sm text-rack hover:underline">
                  Order this plan
                </Link>
              </div>
            </div>
            <div className="mt-4 border-t border-line pt-4">
              <MarginCalc p={p} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
