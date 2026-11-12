'use client';

import { Activity, Database, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { api, relTime } from '@/lib/client';
import { useAsync } from '@/lib/hooks';
import type { HealthInfo } from '@/lib/ui-types';
import { cx } from '@/lib/client';
import { Card } from '../ds/Card';
import { Chip, ProvenanceBadge } from '../ds/badges';
import { CardSkeleton, ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import { useSession } from '../shell/SessionProvider';

const TONE = { healthy: 'good', degraded: 'warn', unavailable: 'bad' } as const;
const BREAKER: Record<string, { tone: 'good' | 'warn' | 'bad'; text: string }> = {
  closed: { tone: 'good', text: 'closed — calls flow normally' },
  half_open: { tone: 'warn', text: 'half-open — testing recovery' },
  open: { tone: 'bad', text: 'open — calls are being refused for a cool-down' },
};

export default function StatusPage() {
  const { session } = useSession();
  const { data, error, loading, reload } = useAsync((s) => api<HealthInfo>('/api/health', { signal: s }), []);
  useEffect(() => {
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [reload]);
  const rt = data?.runtime;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-ink-mute">System status</p>
          <h1 className="font-display text-3xl font-bold">Modes, dependencies and queue</h1>
        </div>
        <button type="button" className="btn-ghost" onClick={reload}><RefreshCw className={cx('h-4 w-4', loading && 'animate-spin')} aria-hidden /> Refresh</button>
      </header>

      {error && !data ? (
        <ErrorRecovery title="Status is unavailable" what={error.message} moneyMoved={NO_MONEY_SHADOW} safeToRetry="Yes." onRetry={reload} />
      ) : !data || !rt ? (
        <div className="grid gap-4 md:grid-cols-2"><CardSkeleton /><CardSkeleton /></div>
      ) : (
        <>
          <p role="status" data-testid="status-overall" className={cx('flex items-center gap-2 rounded-xl border p-4 text-sm font-semibold', data.status === 'healthy' ? 'border-pass/40 bg-pass-bg text-pass-ink' : data.status === 'degraded' ? 'border-review/40 bg-review-bg text-review-ink' : 'border-block/40 bg-block-bg text-block-ink')}>
            <Activity className="h-5 w-5" aria-hidden />
            {data.status === 'healthy' ? 'All systems normal.' : data.status === 'degraded' ? 'Degraded: a dependency is failing. The app is falling back where it safely can.' : 'Unavailable.'}
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="What is real, what is simulated" bodyClass="space-y-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><span>Full run (Lane 1)</span><ProvenanceBadge kind="simulated" /></div>
              <div className="flex flex-wrap items-center justify-between gap-2"><span>Single-pair proof (Lane 2)</span><ProvenanceBadge kind={rt.lane2_mode === 'sandbox' ? 'sandbox' : 'simulated'} /></div>
              <div className="flex flex-wrap items-center justify-between gap-2"><span>Agents</span><ProvenanceBadge kind={rt.ai_mode === 'openai' ? 'ai' : 'deterministic'} /></div>
              <p className="text-xs text-ink-mute">{rt.lane2_label}. {rt.ai_mode === 'openai' ? `Model: ${rt.ai_model}.` : 'No AI key configured: every agent uses its deterministic implementation.'}</p>
            </Card>
            <Card title="Platform" icon={<Database className="h-5 w-5 text-brand-ink" aria-hidden />} bodyClass="space-y-2 text-sm">
              <div className="flex justify-between gap-2"><span>Database</span><Chip tone={data.checks.database === 'ok' ? 'good' : 'bad'}>{rt.db_mode === 'postgres' ? 'PostgreSQL' : 'In-memory'} · {data.checks.database}</Chip></div>
              <div className="flex justify-between gap-2"><span>Access control</span><Chip tone={data.auth.configured ? 'good' : 'bad'}>{data.checks.access_control}</Chip></div>
              <div className="flex justify-between gap-2"><span>Overall</span><Chip tone={TONE[data.status]}>{data.status}</Chip></div>
              {session?.usage && session.limits && <div className="flex justify-between gap-2"><span>Your quota</span><span>{session.usage.runs}/{session.limits.maxRunsPerSession} runs · {session.usage.policies}/{session.limits.maxPoliciesPerSession} policies</span></div>}
            </Card>
            <Card title="Dependency circuit breakers" bodyClass="space-y-2 text-sm">
              {data.dependencies.length === 0 ? <p className="text-ink-mute">No dependency has been called yet in this process, so no breaker exists.</p> : data.dependencies.map((d) => (
                <div key={d.name} data-testid={`breaker-${d.name}`} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2"><b className="capitalize">{d.name}</b><Chip tone={BREAKER[d.state]?.tone ?? 'plain'}>{BREAKER[d.state]?.text ?? d.state}</Chip></div>
                  <p className="mt-1 text-xs text-ink-mute">{d.consecutive_failures} consecutive failure{d.consecutive_failures === 1 ? '' : 's'}{d.last_success_at ? ` · last success ${relTime(d.last_success_at)}` : ' · no success yet'}</p>
                </div>
              ))}
            </Card>
            <Card title="Webhook job queue" bodyClass="text-sm">
              {data.queue ? (
                <dl className="grid grid-cols-4 gap-2 text-center">
                  {(['queued', 'running', 'failed', 'done'] as const).map((k) => <div key={k} className="rounded-lg bg-surface-2 px-2 py-2"><dd className="font-display text-xl font-bold tabular-nums">{data.queue![k]}</dd><dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-mute">{k}</dt></div>)}
                </dl>
              ) : <p className="text-ink-mute">Queue statistics are unavailable.</p>}
              <p className="mt-3 text-xs text-ink-mute">Verified PayPal webhooks are stored first, then processed by a durable job with retries and back-off.</p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
