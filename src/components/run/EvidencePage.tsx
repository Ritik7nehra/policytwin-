'use client';

import Link from 'next/link';
import { CircleAlert, FlaskConical, ShieldCheck } from 'lucide-react';
import { api, fmtDateTime } from '@/lib/client';
import { useAsync } from '@/lib/hooks';
import { ProvenanceBadge, VerdictBadge } from '../ds/badges';
import { Card } from '../ds/Card';
import { CardSkeleton, EmptyState, ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import type { Verdict } from '@/lib/ui-types';
import { useSession } from '../shell/SessionProvider';

interface Item {
  run_id: string;
  policy_name: string;
  stage: string;
  release_decision: Verdict | null;
  started_at: string;
  read_only: boolean;
  shadow: { mode: 'simulated'; operations: number; failed_operations: number; invariant_checks: number; invariant_failures: number };
  sandbox_proof: { pairs: { pair_id: string; mode: 'simulated' | 'sandbox'; agrees_with_shadow: boolean; recorded_at: string; errors: number }[]; operations: number };
  pairs_total: number | null;
}

export default function EvidencePage() {
  const { runtime } = useSession();
  const { data, error, loading, reload } = useAsync((s) => api<{ runs: Item[] }>('/api/evidence', { signal: s }), []);
  const real = runtime?.lane2_mode === 'sandbox';
  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.1em] text-ink-mute">Evidence</p>
        <h1 className="font-display text-3xl font-bold">What actually ran, and where</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-mute">Two lanes, never blurred. The full run executes every scenario on a simulator. A single pair can then be re-run in the real PayPal Sandbox — only when Sandbox credentials are configured.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Lane 1 · Full run" right={<ProvenanceBadge kind="simulated" />}>
          <p className="text-sm text-ink-mute">Every scenario: create → capture → refund → webhooks on the in-process simulator, then deterministic invariant checks. Fast and repeatable. <b className="text-ink">It is not PayPal.</b></p>
        </Card>
        <Card title="Lane 2 · Sandbox proof" right={<ProvenanceBadge kind={real ? 'sandbox' : 'simulated'} />}>
          <p className="text-sm text-ink-mute">{real ? 'One chosen pair re-run against the real PayPal Sandbox with test money. Resource ids come from PayPal. It never changes the verdict; a disagreement is shown loudly.' : 'No Sandbox credentials are configured here, so a Lane 2 run would use the simulator and be labelled SIMULATED. Configure Sandbox credentials to get real PayPal ids.'}</p>
        </Card>
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-1 gap-3"><CardSkeleton /><CardSkeleton /></div>
      ) : error ? (
        <ErrorRecovery title="Could not load evidence" what={error.message} moneyMoved={NO_MONEY_SHADOW} safeToRetry="Yes. This only reads data." onRetry={reload} />
      ) : !data || data.runs.length === 0 ? (
        <EmptyState icon={<FlaskConical className="h-5 w-5" aria-hidden />} title="No evidence yet">Evidence appears when a run completes.</EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-3" data-testid="evidence-list">
          {data.runs.map((r) => (
            <li key={r.run_id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2"><VerdictBadge v={r.release_decision} /><Link href={`/runs/${r.run_id}`} className="font-display text-base font-bold underline-offset-2 hover:underline">{r.policy_name}</Link></p>
                  <p className="mt-0.5 text-xs text-ink-mute"><span className="font-mono">{r.run_id}</span> · {fmtDateTime(r.started_at)}{r.read_only && ' · shared example'}</p>
                </div>
                <Link href={`/runs/${r.run_id}?tab=inspector`} className="btn-ghost !min-h-8 !px-3 text-xs">Open evidence</Link>
              </div>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
                {([['Payment operations', r.shadow.operations], ['Failed operations', r.shadow.failed_operations], ['Invariant checks', r.shadow.invariant_checks], ['Invariant failures', r.shadow.invariant_failures]] as const).map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-surface-2 px-3 py-2"><dd className="font-display text-xl font-bold tabular-nums">{v}</dd><dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-mute">{k}</dt></div>
                ))}
              </dl>
              <div className="mt-3 border-t border-line pt-3">
                <p className="label !mb-1.5">Lane 2 proofs ({r.sandbox_proof.pairs.length}{r.pairs_total ? ` of ${r.pairs_total} pairs` : ''})</p>
                {r.sandbox_proof.pairs.length === 0 ? (
                  <p className="text-sm text-ink-mute">None yet. Open a pair in the Inspector and choose “Verify in PayPal Sandbox”.</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {r.sandbox_proof.pairs.map((p) => (
                      <li key={p.pair_id}>
                        <Link href={`/runs/${r.run_id}?tab=inspector&pair=${p.pair_id}`} className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs hover:bg-brand-bg/50">
                          <span className="font-mono font-semibold">{p.pair_id}</span>
                          <ProvenanceBadge kind={p.mode === 'sandbox' ? 'sandbox' : 'simulated'} compact />
                          {p.agrees_with_shadow ? <span className="inline-flex items-center gap-1 font-semibold text-pass-ink"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />agrees</span> : <span className="inline-flex items-center gap-1 font-semibold text-block-ink"><CircleAlert className="h-3.5 w-3.5" aria-hidden />disagrees</span>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
