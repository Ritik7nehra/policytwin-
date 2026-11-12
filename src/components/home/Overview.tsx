'use client';

import Link from 'next/link';
import { ArrowRight, FileText, FolderGit2, Play, PlusCircle } from 'lucide-react';
import { useCountUp, useAsync } from '@/lib/hooks';
import { api, relTime } from '@/lib/client';
import type { Overview as OverviewData, OverviewRun } from '@/lib/ui-types';
import { useSession } from '../shell/SessionProvider';
import { useDemo } from '../shell/DemoRunner';
import { VerdictBadge, ProvenanceBadge } from '../ds/badges';
import { Card } from '../ds/Card';
import { CardSkeleton, EmptyState, ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import TwinLab from './TwinLab';
import PipelineStages from './PipelineStages';

function Metric({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: 'bad' | 'good' }) {
  const n = useCountUp(value);
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3" data-testid={`metric-${label.toLowerCase().replace(/\W+/g, '-')}`}>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-mute">{label}</dt>
      <dd className={`mt-1 font-display text-3xl font-bold tabular-nums ${tone === 'bad' ? 'text-block-ink' : tone === 'good' ? 'text-pass-ink' : ''}`}>{n.toLocaleString('en-US')}</dd>
      <dd className="mt-0.5 text-xs text-ink-mute">{sub}</dd>
    </div>
  );
}

function RunRow({ r }: { r: OverviewRun }) {
  return (
    <li>
      <Link href={`/runs/${r.id}`} className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3 transition hover:border-brand/50 hover:bg-brand-bg/40">
        <VerdictBadge v={r.release_decision} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{r.policy_name}</span>
          <span className="block truncate text-xs text-ink-mute">
            {r.parent_run_id ? 'Re-run of corrected policy' : 'Initial run'} · {r.counts ? `${r.counts.passed}/${r.counts.pairs} pairs as expected` : r.stage.toLowerCase()} · {relTime(r.started_at)}
            {r.read_only && ' · shared example'}
          </span>
        </span>
        {r.human_decision && <span className="hidden rounded-full bg-navy px-2 py-0.5 text-[11px] font-semibold text-white sm:inline">{r.human_decision.decision === 'approve' ? 'human approved' : 'human rejected'}</span>}
        <ArrowRight className="h-4 w-4 shrink-0 text-ink-mute" aria-hidden />
      </Link>
    </li>
  );
}

export default function Overview() {
  const demo = useDemo();
  const { session, runtime } = useSession();
  const { data, error, loading, reload } = useAsync((signal) => api<OverviewData>('/api/overview', { signal }), [session?.actor]);
  const example = session?.public_example;
  const exampleRun = example?.run_ids[example.run_ids.length - 1];
  const t = data?.totals;

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1.05fr_1fr]" aria-labelledby="hero-h">
        <div className="space-y-5 pt-1">
          <p className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand-bg px-3 py-1 text-xs font-bold uppercase tracking-[0.1em] text-brand-ink">Counterfactual testing for financial-policy releases</p>
          <h1 id="hero-h" className="font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
            Test every money rule <span className="bg-gradient-to-r from-brand to-twin-ink bg-clip-text text-transparent">before it reaches real money.</span>
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-ink-mute">
            PayPal PolicyTwin builds <b className="text-ink">matched transaction twins</b> — identical except for one field — runs the current and proposed policy against them, replays the money operations on a simulator, and checks the results with deterministic code. If changing one characteristic changes (or fails to change) the financial outcome, you find out before release.
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary !px-5 !py-2.5 text-base" onClick={demo.open} data-testid="hero-run-demo">
              <Play className="h-4 w-4" aria-hidden /> Run demo scenario
            </button>
            <Link href="/policies/new" className="btn-ghost !px-5 !py-2.5 text-base" data-testid="hero-new-policy">
              <PlusCircle className="h-4 w-4" aria-hidden /> Create a policy change
            </Link>
            {exampleRun && (
              <Link href={`/runs/${exampleRun}`} className="btn-quiet !px-4 !py-2.5 text-base" data-testid="hero-example">
                <FileText className="h-4 w-4" aria-hidden /> See the example report
              </Link>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-mute">
            <ProvenanceBadge kind="synthetic" /> <ProvenanceBadge kind={runtime?.lane2_mode === 'sandbox' ? 'sandbox' : 'simulated'} /> <ProvenanceBadge kind="deterministic" />
            <span>Fictional policies. Synthetic data. Release recommendation — not an approval.</span>
          </div>
        </div>
        <TwinLab />
      </section>

      <PipelineStages />

      <section aria-labelledby="metrics-h" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="metrics-h" className="font-display text-xl font-bold">What has been tested here</h2>
          <p className="text-xs text-ink-mute" data-testid="metrics-scope">Counted from stored runs: {data?.scope ?? 'your workspace + the read-only example'}. No PayPal production data.</p>
        </div>
        {loading && !data ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><CardSkeleton /><CardSkeleton className="hidden sm:block" /><CardSkeleton className="hidden lg:block" /></div>
        ) : error ? (
          <ErrorRecovery title="Could not load the overview" what={error.message} moneyMoved={NO_MONEY_SHADOW} safeToRetry="Yes. This only reads data." onRetry={reload} />
        ) : t ? (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="Policy changes" value={t.policies} sub="in view" />
            <Metric label="Test runs" value={t.runs} sub={`${t.completed_runs} completed · ${t.decided_runs} decided by a human`} />
            <Metric label="Scenarios executed" value={t.scenarios} sub={`${t.pairs} twin pairs`} />
            <Metric label="Critical regressions" value={t.critical_pairs} sub={`${t.verdicts.BLOCK} run${t.verdicts.BLOCK === 1 ? '' : 's'} blocked`} tone={t.critical_pairs ? 'bad' : undefined} />
            <Metric label="Invariant failures" value={t.invariant_failures} sub={`${t.verdicts.PASS} PASS · ${t.verdicts.REVIEW} REVIEW · ${t.verdicts.BLOCK} BLOCK`} tone={t.invariant_failures ? 'bad' : 'good'} />
          </dl>
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Recent policy changes" icon={<FolderGit2 className="h-5 w-5 text-brand-ink" aria-hidden />} right={<Link href="/policies" className="text-sm font-semibold text-brand-ink hover:underline">All policy changes</Link>}>
          {!data ? (
            <CardSkeleton className="!border-0 !p-0 !shadow-none" />
          ) : data.recent_policies.length === 0 ? (
            <EmptyState title="No policy changes yet" action={<><button type="button" className="btn-primary" onClick={demo.open}>Run demo scenario</button><Link className="btn-ghost" href="/policies/new">Create one</Link></>}>
              The guided demo creates a fictional policy and tests it end to end.
            </EmptyState>
          ) : (
            <ul className="space-y-2" data-testid="recent-policies">
              {data.recent_policies.slice(0, 6).map((p) => (
                <li key={p.id} className="rounded-lg border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/policies/${p.id}`} className="font-semibold underline-offset-2 hover:underline">{p.name}</Link>
                    <span className="flex items-center gap-1.5">
                      {p.read_only && <span className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-semibold text-ink-mute">shared example</span>}
                      {p.runs.length === 0 ? <span className="text-xs text-ink-mute">no runs yet</span> : p.runs.map((r) => <VerdictBadge key={r.id} v={r.release_decision} />)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent verdicts" icon={<Play className="h-5 w-5 text-brand-ink" aria-hidden />} right={<Link href="/runs" className="text-sm font-semibold text-brand-ink hover:underline">All test runs</Link>}>
          {!data ? (
            <CardSkeleton className="!border-0 !p-0 !shadow-none" />
          ) : data.recent_runs.length === 0 ? (
            <EmptyState title="No test runs yet">A run produces a release recommendation: PASS, REVIEW or BLOCK.</EmptyState>
          ) : (
            <ul className="space-y-2" data-testid="recent-runs">
              {data.recent_runs.slice(0, 6).map((r) => <RunRow key={r.id} r={r} />)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
