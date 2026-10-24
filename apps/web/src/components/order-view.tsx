'use client';
import clsx from 'clsx';
import { Facts, Section, Status } from './ui';
import { money, when } from '@/lib/api';
import { ORDER_FLOW, type OrderDetail } from '@/lib/types';

const LABEL: Record<string, string> = {
  PAID_OR_AUTHORIZED: 'Paid',
  QUEUED: 'Queued',
  PROVISIONING: 'Building VM',
  CONFIGURING_NETWORK: 'Network',
  VERIFYING: 'Verifying',
  ACTIVE: 'Active',
};

/**
 * The provisioning rail: the order's real state machine, drawn as a track.
 * Completed steps are solid, the live step pulses, a failure stops the track in red.
 */
export function ProvisioningRail({ status, events }: { status: string; events: OrderDetail['events'] }) {
  const failed = ['FAILED', 'NEEDS_ATTENTION', 'CANCELLED'].includes(status);
  const reached = new Set(events.map((e) => e.status));
  const currentIdx = ORDER_FLOW.indexOf(status as (typeof ORDER_FLOW)[number]);
  const lastReached = Math.max(...ORDER_FLOW.map((s, i) => (reached.has(s) ? i : -1)));
  const idx = currentIdx >= 0 ? currentIdx : lastReached;
  return (
    <ol className="flex w-full items-start" aria-label="Provisioning progress">
      {ORDER_FLOW.map((step, i) => {
        const done = i < idx || (i === idx && status === 'ACTIVE');
        const live = i === idx && !failed && status !== 'ACTIVE';
        const broke = failed && i === idx + 1;
        return (
          <li key={step} className="flex flex-1 flex-col items-center text-center" aria-current={live ? 'step' : undefined}>
            <div className="flex w-full items-center">
              <span className={clsx('h-0.5 flex-1', i === 0 ? 'invisible' : done || live || i <= idx ? 'bg-rack' : 'bg-line')} />
              <span
                className={clsx(
                  'h-3.5 w-3.5 shrink-0 rounded-full border-2',
                  done && 'border-rack bg-rack',
                  live && 'rail-live border-rack bg-surface',
                  broke && 'border-bad bg-bad',
                  !done && !live && !broke && 'border-line bg-surface',
                )}
              />
              <span className={clsx('h-0.5 flex-1', i === ORDER_FLOW.length - 1 ? 'invisible' : i < idx ? 'bg-rack' : 'bg-line')} />
            </div>
            <span className={clsx('mt-2 text-xs', live || done ? 'text-ink' : broke ? 'font-medium text-bad' : 'text-muted')}>
              {broke ? (status === 'NEEDS_ATTENTION' ? 'Needs attention' : 'Failed') : LABEL[step]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function OrderView({ order, showMargin }: { order: OrderDetail; showMargin?: boolean }) {
  const total = BigInt(order.wholesaleMinor) + BigInt(order.setupFeeMinor);
  return (
    <div>
      <div className="mb-8 rounded-lg border border-line bg-surface px-4 py-6">
        <ProvisioningRail status={order.status} events={order.events} />
        {order.failureReason && <p className="mt-5 text-center text-sm text-bad">{order.failureReason}</p>}
      </div>
      <div className="grid gap-8 md:grid-cols-2">
        <Section title="Order">
          <Facts
            items={[
              ['Status', <Status key="s" value={order.status} />],
              ['Product', `${order.product.name} (${order.product.sku})`],
              ['Hostname', order.hostname],
              ['Billing cycle', order.cycle.toLowerCase()],
              ['Wholesale', <span key="w" className="num">{money(total.toString(), order.currency)}</span>],
              ...(showMargin && order.retailMinor
                ? ([
                    ['Retail (reported)', <span key="r" className="num">{money(order.retailMinor, order.retailCurrency ?? order.currency)}</span>],
                    ['Margin', <span key="m" className="num">{money((BigInt(order.retailMinor) - total).toString(), order.currency)}</span>],
                  ] as Array<[string, React.ReactNode]>)
                : []),
              ['Source', order.source],
              ['External reference', <code key="k" className="break-all text-xs">{order.idempotencyKey}</code>],
              ['Created', when(order.createdAt)],
            ]}
          />
        </Section>
        <Section title="Service">
          <Facts
            items={[
              ['IP addresses', order.ips.length ? order.ips.map((i) => `${i.address} (${i.status.toLowerCase()})`).join(', ') : '—'],
              ['Service', order.service ? <Status key="ss" value={order.service.status} /> : '—'],
              ['Resources', order.service ? `${order.service.cpuCores} vCPU · ${order.service.memoryMb / 1024} GB RAM · ${order.service.diskGb} GB disk` : '—'],
              ['VM', order.service?.vmName ?? '—'],
              ['Next due', order.service?.nextDueDate ? when(order.service.nextDueDate) : '—'],
            ]}
          />
        </Section>
      </div>
      <Section title="Activity">
        <ol className="border-l border-line pl-5">
          {order.events.map((e) => (
            <li key={e.id} className="relative mb-3">
              <span className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-line" />
              <div className="text-sm">{e.message}</div>
              <div className="text-xs text-muted">
                {when(e.createdAt)} · {e.status.replace(/_/g, ' ').toLowerCase()}
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
