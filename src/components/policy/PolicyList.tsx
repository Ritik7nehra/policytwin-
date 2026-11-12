'use client';

import Link from 'next/link';
import { FolderGit2, PlusCircle, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, fmtDateTime } from '@/lib/client';
import { useAsync } from '@/lib/hooks';
import type { Verdict } from '@/lib/ui-types';
import { VerdictBadge } from '../ds/badges';
import { CardSkeleton, EmptyState, ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import { useDemo } from '../shell/DemoRunner';

interface Item {
  id: string;
  name: string;
  description: string;
  created_at: string;
  read_only: boolean;
  runs: { id: string; stage: string; release_decision: Verdict | null; parent_run_id: string | null }[];
}

export default function PolicyList() {
  const demo = useDemo();
  const { data, error, loading, reload } = useAsync((s) => api<{ policies: Item[] }>('/api/policies', { signal: s }), []);
  const [q, setQ] = useState('');
  const shown = useMemo(() => (data?.policies ?? []).filter((p) => `${p.name} ${p.description} ${p.id}`.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-ink-mute">Policy changes</p>
          <h1 className="font-display text-3xl font-bold">Every change you are testing</h1>
        </div>
        <Link href="/policies/new" className="btn-primary" data-testid="list-new-policy"><PlusCircle className="h-4 w-4" aria-hidden /> New policy change</Link>
      </header>

      <div className="relative max-w-md">
        <label htmlFor="policy-search" className="sr-only">Filter policy changes</label>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" aria-hidden />
        <input id="policy-search" className="field !pl-9" placeholder="Filter by name or id" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-1 gap-3"><CardSkeleton /><CardSkeleton /></div>
      ) : error ? (
        <ErrorRecovery title="Could not load policy changes" what={error.message} moneyMoved={NO_MONEY_SHADOW} safeToRetry="Yes. This only reads data." onRetry={reload} />
      ) : shown.length === 0 ? (
        <EmptyState icon={<FolderGit2 className="h-5 w-5" aria-hidden />} title={q ? 'No policy change matches that filter' : 'No policy changes yet'} action={q ? <button className="btn-ghost" onClick={() => setQ('')}>Clear filter</button> : <><button className="btn-primary" onClick={demo.open}>Run demo scenario</button><Link className="btn-ghost" href="/policies/new">Create one</Link></>}>
          {q ? 'Try a different word.' : 'Create a fictional policy change, or run the guided demo.'}
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-3" data-testid="policy-list">
          {shown.map((p) => (
            <li key={p.id} className="card card-lift p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/policies/${p.id}`} className="font-display text-lg font-bold underline-offset-2 hover:underline">{p.name}</Link>
                  <p className="mt-0.5 line-clamp-2 text-sm text-ink-mute">{p.description || 'No description'}</p>
                  <p className="mt-1 text-xs text-ink-mute">Created {fmtDateTime(p.created_at)} · <span className="font-mono">{p.id}</span>{p.read_only && ' · shared read-only example'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {p.runs.length === 0 ? <span className="text-xs text-ink-mute">no runs yet</span> : p.runs.map((r) => (
                    <Link key={r.id} href={`/runs/${r.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs hover:bg-brand-bg/50">
                      <VerdictBadge v={r.release_decision} />
                      <span className="text-ink-mute">{r.parent_run_id ? 're-run' : 'run'}</span>
                      <span className="sr-only">{r.id}</span>
                    </Link>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
