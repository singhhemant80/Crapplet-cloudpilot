'use client';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** All browser calls go through the same-origin BFF proxy; tokens never touch JS. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const res = await fetch(`/api/cp/${path.replace(/^\//, '')}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'x-cp-csrf': '1',
      ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

export function useApi<T>(path: string | null, opts: { refetchInterval?: number | false | ((data: T | undefined) => number | false) } = {}) {
  const ri = opts.refetchInterval;
  return useQuery<T, ApiError>({
    queryKey: [path],
    queryFn: () => api<T>(path!),
    enabled: Boolean(path),
    refetchInterval: typeof ri === 'function' ? (q) => ri(q.state.data) : ri,
  });
}

/** Poll every 2s while an order/service is mid-flight, otherwise not at all. */
export const whileInFlight = (statuses: string[]) => (d: { status: string } | undefined) => (d && statuses.includes(d.status) ? 2_000 : false);

/** Mutation that refreshes the given query keys afterwards. */
export function useAction<TVars, TOut = unknown>(fn: (v: TVars) => Promise<TOut>, invalidate: string[] = []) {
  const qc = useQueryClient();
  return useMutation<TOut, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: () => Promise.all(invalidate.map((k) => qc.invalidateQueries({ predicate: (q) => String((q.queryKey as QueryKey)[0]).startsWith(k) }))),
  });
}

export const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

// ───────────────────────── formatting

export function money(minor: string | number | bigint | null | undefined, currency = 'INR') {
  if (minor === null || minor === undefined) return '—';
  const n = Number(BigInt(String(minor))) / 100;
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency }).format(n);
}

/** Parses "1,234.50" in major units into a minor-unit string, or null if invalid. */
export function toMinor(input: string): string | null {
  const clean = input.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  return (BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2))).toString();
}

export function when(d: string | null | undefined) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));
}

export function day(d: string | null | undefined) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(d));
}

export const mb = (m: number) => (m >= 1024 ? `${(m / 1024).toFixed(m % 1024 ? 1 : 0)} GB` : `${m} MB`);
