'use client';

import Link from 'next/link';
import { ArrowRight, Download, ExternalLink, Play, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { fmtDateTime, cx } from '@/lib/client';
import { useAsync } from '@/lib/hooks';
import { loadRunList } from '@/lib/lists';
import { VerdictBadge } from '../ds/badges';
import { CardSkeleton, EmptyState, ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import { useDemo } from '../shell/DemoRunner';

export default function RunList({ mode }: { mode: 'runs' | 'reports' }) {
  const demo = useDemo();
  const { data, error, loading, reload } = useAsync((s) => loadRunList(s), []);
  const [q, setQ] = useState('');
  const [v, setV] = useState<'ALL' | 'PASS' | 'REVIEW' | 'BLOCK'>('ALL');
  const rows = useMemo(
    () => (data ?? []).filter((r) => (mode === 'reports' ? r.status === 'completed' : true) && (v === 'ALL' || r.release_decision === v) && `${r.policy_name} ${r.id} ${r.release_decision ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())),
    [data, q, v, mode],
  );
  const title = mode === 'runs' ? 'Test runs' : 'Reports';

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.1em] text-ink-mute">{title}</p>
        <h1 className="font-display text-3xl font-bold">{mode === 'runs' ? 'Every comparison that was run' : 'Shareable release reports'}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-mute">{mode === 'runs' ? 'Open a run to see its transaction twin matrix, the evidence behind each pair, and the release gate.' : 'Each report is a self-contained HTML page: verdict, evidence, synthetic impact and the human decision. Verdicts are recommendations, not approvals.'}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <label htmlFor="run-search" className="sr-only">Filter runs</label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" aria-hidden />
          <input id="run-search" className="field !pl-9" placeholder="Filter by policy, id or verdict" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div role="group" aria-label="Verdict" className="flex gap-1.5">
          {(['ALL', 'PASS', 'REVIEW', 'BLOCK'] as const).map((x) => (
            <button key={x} type="button" aria-pressed={v === x} onClick={() => setV(x)} className={cx('rounded-full border px-3 py-1 text-xs font-semibold', v === x ? 'border-navy bg-navy text-white' : 'border-line-strong bg-surface hover:bg-surface-2')}>{x === 'ALL' ? 'All' : x}</button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-1 gap-3"><CardSkeleton /><CardSkeleton /></div>
      ) : error ? (
        <ErrorRecovery title="Could not load runs" what={error.message} moneyMoved={NO_MONEY_SHADOW} safeToRetry="Yes. This only reads data." onRetry={reload} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Play className="h-5 w-5" aria-hidden />} title={q || v !== 'ALL' ? 'No run matches that filter' : mode === 'runs' ? 'No test runs yet' : 'No completed runs yet'} action={q || v !== 'ALL' ? <button className="btn-ghost" onClick={() => { setQ(''); setV('ALL'); }}>Clear filters</button> : <button className="btn-primary" onClick={demo.open}>Run demo scenario</button>}>
          {mode === 'reports' ? 'A report appears when a run completes.' : 'Start one from a policy change, or run the guided demo.'}
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-3" data-testid={`${mode}-list`}>
          {rows.map((r) => (
            <li key={r.id} className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <VerdictBadge v={r.release_decision} />
                  <div className="min-w-0">
                    <Link href={`/runs/${r.id}`} className="font-display text-base font-bold underline-offset-2 hover:underline">{r.policy_name}</Link>
                    <p className="text-xs text-ink-mute"><span className="font-mono">{r.id}</span> · {r.parent_run_id ? 're-run of corrected policy' : 'initial run'} · {r.stage.toLowerCase()} · {fmtDateTime(r.started_at)}{r.read_only && ' · shared example'}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {mode === 'reports' ? (
                    <>
                      <a className="btn-ghost !min-h-8 !px-3 text-xs" href={`/api/test-runs/${r.id}/report`} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open</a>
                      <a className="btn-ghost !min-h-8 !px-3 text-xs" href={`/api/test-runs/${r.id}/report?download=1`}><Download className="h-3.5 w-3.5" aria-hidden /> Download HTML</a>
                    </>
                  ) : (
                    <Link href={`/runs/${r.id}`} className="btn-ghost !min-h-8 !px-3 text-xs">Open run <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
