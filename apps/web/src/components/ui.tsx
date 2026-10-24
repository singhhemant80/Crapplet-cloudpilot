'use client';
import clsx from 'clsx';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import type { ApiError } from '@/lib/api';

export function Button({
  variant = 'primary',
  busy,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-rack text-rack-ink hover:brightness-110',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-idle-bg',
        variant === 'danger' && 'bg-bad text-white hover:brightness-110',
        variant === 'ghost' && 'text-rack hover:underline',
        className,
      )}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs text-bad">{error}</span>}
    </label>
  );
}

const control = 'rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-rack focus:outline-none';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(control, props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={clsx(control, props.className)}>
      {children}
    </select>
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(control, 'min-h-24 font-[inherit]', props.className)} />;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'idle' | 'live'> = {
  ACTIVE: 'ok', CONNECTED: 'ok', CREDITED: 'ok', ALLOCATED: 'ok', SUCCEEDED: 'ok', online: 'ok', running: 'ok', AVAILABLE: 'ok',
  QUEUED: 'live', PROVISIONING: 'live', CONFIGURING_NETWORK: 'live', VERIFYING: 'live', PAID_OR_AUTHORIZED: 'live',
  AWAITING_PAYMENT: 'warn', UNDER_REVIEW: 'warn', SUSPENDED: 'warn', NEEDS_ATTENTION: 'warn', RESERVED: 'warn', PENDING: 'warn', UNVERIFIED: 'warn', QUARANTINED: 'warn',
  FAILED: 'bad', ERROR: 'bad', REJECTED: 'bad', DEAD: 'bad', TERMINATED: 'idle', CANCELLED: 'idle', RETIRED: 'idle', DRAFT: 'idle', stopped: 'idle', offline: 'bad',
};

export function Status({ value }: { value: string }) {
  const tone = STATUS_TONE[value] ?? 'idle';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'ok' && 'bg-ok-bg text-ok',
        tone === 'warn' && 'bg-warn-bg text-warn',
        tone === 'bad' && 'bg-bad-bg text-bad',
        tone === 'idle' && 'bg-idle-bg text-idle',
        tone === 'live' && 'bg-idle-bg text-rack',
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full bg-current', tone === 'live' && 'rail-live')} aria-hidden />
      {value.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
    </span>
  );
}

export function PageHeader({ title, intro, actions }: { title: string; intro?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {intro && <p className="mt-1 text-muted">{intro}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ErrorNote({ error }: { error: ApiError | Error | null | undefined }) {
  if (!error) return null;
  const details = (error as ApiError).details;
  return (
    <div role="alert" className="rounded-md border border-bad/30 bg-bad-bg px-3 py-2 text-sm text-bad">
      {error.message}
      {Array.isArray(details) && (
        <ul className="mt-1 list-disc pl-5">
          {(details as Array<{ path: string; message: string }>).map((d, i) => (
            <li key={i}>
              {d.path}: {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{children}</div>;
}

export function Loading() {
  return <div className="py-8 text-sm text-muted">Loading…</div>;
}

/** Plain data table: sortable columns, client-side text filter. */
export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  align?: 'right';
}

export function Table<T>({ rows, columns, filter, empty, rowKey }: { rows: T[] | undefined; columns: Column<T>[]; filter?: (row: T) => string; empty: ReactNode; rowKey: (row: T) => string }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  if (!rows) return <Loading />;
  let view = filter && q ? rows.filter((r) => filter(r).toLowerCase().includes(q.toLowerCase())) : rows;
  const col = columns.find((c) => c.key === sort?.key);
  if (col?.sort && sort) view = [...view].sort((a, b) => (col.sort!(a) > col.sort!(b) ? sort.dir : -sort.dir));
  return (
    <div>
      {filter && rows.length > 8 && (
        <Input aria-label="Filter rows" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3 w-full max-w-xs" />
      )}
      {view.length === 0 ? (
        <Empty>{q ? 'Nothing matches that filter.' : empty}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                {columns.map((c) => (
                  <th key={c.key} className={clsx('px-3 py-2 font-medium', c.align === 'right' && 'text-right')} scope="col">
                    {c.sort ? (
                      <button
                        className="hover:text-ink"
                        onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key ? (-s.dir as 1 | -1) : 1 }))}
                        aria-label={`Sort by ${c.header}`}
                      >
                        {c.header}
                        {sort?.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.map((r) => (
                <tr key={rowKey(r)} className="border-b border-line last:border-0 hover:bg-paper/60">
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('px-3 py-2 align-top max-md:whitespace-nowrap', c.align === 'right' && 'num text-right')}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Accessible modal built on <dialog>. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="m-auto w-[min(560px,calc(100vw-32px))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/40">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="font-semibold">{title}</h2>
        <button onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="p-5">{open && children}</div>
    </dialog>
  );
}

/** Key/value facts laid out as a definition list. */
export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A one-time secret display (API keys, webhook secrets). */
export function SecretOnce({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-warn/40 bg-warn-bg p-3 text-sm">
      <p className="mb-2 font-medium text-warn">{label} — copy it now; it will not be shown again.</p>
      <div className="flex gap-2">
        <code className="flex-1 break-all rounded bg-surface px-2 py-1 text-ink">{value}</code>
        <Button
          variant="secondary"
          onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
