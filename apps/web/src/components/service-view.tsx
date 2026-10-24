'use client';
import { useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button, Dialog, ErrorNote, Facts, Field, Input, Loading, PageHeader, Section, Status } from './ui';
import { api, day, mb, money, newKey, useAction, useApi } from '@/lib/api';
import type { ServiceDetail } from '@/lib/types';

type Action = 'start' | 'stop' | 'shutdown' | 'reboot' | 'suspend' | 'unsuspend' | 'terminate';

const ACTION_LABEL: Record<Action, string> = {
  start: 'Start',
  stop: 'Force stop',
  shutdown: 'Shut down',
  reboot: 'Reboot',
  suspend: 'Suspend',
  unsuspend: 'Unsuspend',
  terminate: 'Terminate',
};

/**
 * Service page shared by admin, reseller and customer areas. `base` is the API
 * prefix (e.g. "v1/reseller/services") and `actions` the operations this role may run.
 */
export function ServiceView({ id, base, actions, canRenew }: { id: string; base: string; actions: Action[]; canRenew?: boolean }) {
  const path = `${base}/${id}`;
  const svc = useApi<ServiceDetail>(path);
  const live = useApi<{ power: string; uptimeSeconds?: number; providerType: string }>(svc.data?.status === 'ACTIVE' || svc.data?.status === 'SUSPENDED' ? `${path}/status` : null, {
    refetchInterval: 15_000,
  });
  const metrics = useApi<Array<{ at: string; cpu?: number; memoryUsedBytes?: number }>>(svc.data?.status === 'ACTIVE' ? `${path}/metrics` : null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const run = useAction(
    (a: Action) =>
      api<{ done: boolean; result?: unknown }>(`${path}/actions/${a}`, {
        method: 'POST',
        idempotencyKey: newKey(),
        body: a === 'terminate' ? { confirm: svc.data?.hostname, reason: 'Terminated from control panel' } : {},
      }),
    [path, `${path}/status`, base],
  );
  const renew = useAction(() => api(`${path}/renew`, { method: 'POST', idempotencyKey: `portal-${id}-${svc.data?.nextDueDate}` }), [path]);

  if (svc.error) return <ErrorNote error={svc.error} />;
  if (!svc.data) return <Loading />;
  const s = svc.data;
  const destructive = (a: Action) => a === 'terminate' || a === 'suspend' || a === 'stop';
  const available = actions.filter((a) => {
    if (s.status === 'SUSPENDED') return a === 'unsuspend' || a === 'terminate';
    if (s.status !== 'ACTIVE') return false;
    if (a === 'unsuspend') return false;
    if (a === 'start') return live.data?.power !== 'running';
    if (a === 'stop' || a === 'shutdown' || a === 'reboot') return live.data?.power === 'running';
    return true;
  });

  const trigger = (a: Action) => {
    setNote(null);
    if (destructive(a)) return setConfirm(a);
    run.mutate(a, { onSuccess: (r) => setNote(r.done ? `${ACTION_LABEL[a]} completed.` : `${ACTION_LABEL[a]} is still running; the status updates shortly.`) });
  };

  const series = (metrics.data ?? []).map((m) => ({ t: new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), cpu: Math.round((m.cpu ?? 0) * 1000) / 10 }));

  return (
    <div>
      <PageHeader
        title={s.hostname}
        intro={`${s.product.name} · ${s.ips.map((i) => i.address).join(', ') || 'no IP yet'}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {available.map((a) => (
              <Button key={a} variant={a === 'terminate' ? 'danger' : 'secondary'} busy={run.isPending && run.variables === a} onClick={() => trigger(a)}>
                {ACTION_LABEL[a]}
              </Button>
            ))}
            {canRenew && (s.status === 'ACTIVE' || s.status === 'SUSPENDED') && (
              <Button busy={renew.isPending} onClick={() => renew.mutate(undefined, { onSuccess: () => setNote('Renewed for one more billing period.') })}>
                Renew one period ({money(s.renewalMinor, s.currency)})
              </Button>
            )}
          </div>
        }
      />
      <ErrorNote error={run.error ?? renew.error} />
      {note && <p className="mb-4 text-sm text-ok">{note}</p>}

      <div className="grid gap-8 md:grid-cols-2">
        <Section title="Status">
          <Facts
            items={[
              ['Service', <Status key="s" value={s.status} />],
              ['Power', live.data ? <Status key="p" value={live.data.power} /> : '—'],
              ...(s.suspendedReason ? ([['Suspended because', s.suspendedReason]] as Array<[string, string]>) : []),
              ['Next due', day(s.nextDueDate)],
              ['Renewal price', money(s.renewalMinor, s.currency)],
              ['Billing cycle', s.cycle.toLowerCase()],
            ]}
          />
        </Section>
        <Section title="Server">
          <Facts
            items={[
              ['Resources', `${s.cpuCores} vCPU · ${mb(s.memoryMb)} RAM · ${s.diskGb} GB disk`],
              ['IP addresses', s.ips.map((i) => `${i.address} (IPv${i.version})`).join(', ') || '—'],
              ['Login user', s.username],
              ['Hypervisor', live.data ? `${live.data.providerType}${s.node ? ` · ${s.node}` : ''}${s.externalVmId ? ` · VM ${s.externalVmId}` : ''}` : (s.node ?? '—')],
            ]}
          />
        </Section>
      </div>

      {series.length > 0 && (
        <Section title="CPU, last hour" aside={live.data?.providerType === 'mock' ? <span className="text-xs text-muted">Synthetic data from the mock hypervisor</span> : undefined}>
          <div className="h-48 rounded-md border border-line bg-surface p-3">
            <ResponsiveContainer>
              <AreaChart data={series}>
                <XAxis dataKey="t" tick={{ fontSize: 11, fill: 'var(--muted)' }} interval="preserveStartEnd" />
                <YAxis unit="%" width={40} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
                <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)' }} />
                <Area dataKey="cpu" stroke="var(--rack)" fill="var(--rack)" fillOpacity={0.12} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      <Dialog open={confirm !== null} onClose={() => (setConfirm(null), setTyped(''))} title={confirm ? `${ACTION_LABEL[confirm]} ${s.hostname}?` : ''}>
        {confirm === 'terminate' ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              The virtual machine and its disks are deleted on the hypervisor and its IP addresses go into quarantine. This cannot be undone.
            </p>
            <Field label={`Type ${s.hostname} to confirm`}>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </Field>
          </div>
        ) : (
          <p className="text-sm">
            {confirm === 'suspend'
              ? 'The server is powered off and stays off until it is unsuspended.'
              : 'This cuts power immediately, like pulling the plug. Unsaved data in the server may be lost.'}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={confirm === 'terminate' && typed !== s.hostname}
            onClick={() => {
              const a = confirm!;
              setConfirm(null);
              setTyped('');
              run.mutate(a, { onSuccess: (r) => setNote(r.done ? `${ACTION_LABEL[a]} completed.` : `${ACTION_LABEL[a]} is still running.`) });
            }}
          >
            {confirm ? ACTION_LABEL[confirm] : ''}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
