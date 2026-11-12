'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Gavel, LayoutGrid, Microscope } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunBundle } from '@/lib/pipeline';
import { api, cx, errMsg } from '@/lib/client';
import { useAsync } from '@/lib/hooks';
import { Chip, ProvenanceBadge, VerdictBadge } from '../ds/badges';
import { CardSkeleton, ErrorRecovery, NO_MONEY_SHADOW, Spinner } from '../ds/feedback';
import { useToast } from '../ds/Toast';
import TwinMatrix from './TwinMatrix';
import ScenarioEvidence from './ScenarioEvidence';
import ScenarioDrawer from './ScenarioDrawer';
import ReleaseGate from './ReleaseGate';

type Tab = 'matrix' | 'inspector' | 'gate';
const TABS: Tab[] = ['matrix', 'inspector', 'gate'];
const TOPBAR = 56;

export default function RunView({ id }: { id: string }) {
  const router = useRouter();
  const path = usePathname();
  const qs = useSearchParams();
  const { push } = useToast();
  const { data: bundle, error, loading, reload } = useAsync((s) => api<RunBundle>(`/api/test-runs/${id}`, { signal: s }), [id]);
  const tabParam = qs.get('tab') as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'matrix';
  const pairParam = qs.get('pair');
  const guided = qs.get('guided') === '1';
  const [drawer, setDrawer] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeErr, setResumeErr] = useState<Error | null>(null);
  const header = useRef<HTMLDivElement>(null);

  const setUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const p = new URLSearchParams(qs.toString());
      for (const [k, v] of Object.entries(patch)) (v === null ? p.delete(k) : p.set(k, v));
      router.replace(`${path}?${p.toString()}`, { scroll: false });
    },
    [qs, router, path],
  );

  // The evidence drawer docks below the sticky header: publish that offset as a CSS variable.
  // On small screens only the tab bar stays pinned (the title block scrolls away), so the page keeps its room.
  useEffect(() => {
    const el = header.current;
    if (!el) return;
    const mq = window.matchMedia('(max-width: 1023px)');
    const set = () => {
      const tabs = el.querySelector<HTMLElement>('[role=tablist]');
      const h = el.getBoundingClientRect().height;
      const compact = mq.matches && !!tabs;
      const tabsH = tabs ? tabs.getBoundingClientRect().height : h;
      el.style.top = mq.matches ? (tabs ? `${TOPBAR - (h - tabsH)}px` : 'auto') : `${TOPBAR}px`;
      document.documentElement.style.setProperty('--run-header-bottom', `${TOPBAR + (compact ? tabsH : h)}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    mq.addEventListener('change', set);
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', set);
      document.documentElement.style.removeProperty('--run-header-bottom');
    };
  }, [bundle?.run.id, tab]);

  // A run that is still working refreshes itself (bounded: stops after ~2 minutes).
  const working = bundle && bundle.run.status !== 'completed' && bundle.run.status !== 'failed' && /ING$/.test(bundle.run.stage);
  useEffect(() => {
    if (!working) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 40) clearInterval(t);
      else reload();
    }, 3000);
    return () => clearInterval(t);
  }, [working, reload]);

  if (error && !bundle) {
    const status = (error as { status?: number }).status;
    return (
      <ErrorRecovery
        title={status === 404 ? 'That test run does not exist' : status === 403 ? 'That test run belongs to another session' : 'Could not open this test run'}
        what={error.message}
        moneyMoved={NO_MONEY_SHADOW}
        safeToRetry="Yes. This only reads data."
        onRetry={status === 404 || status === 403 ? undefined : reload}
        extra={<Link href="/runs" className="btn-ghost">All test runs</Link>}
      />
    );
  }
  if (loading && !bundle) return <div className="space-y-4"><CardSkeleton /><CardSkeleton /></div>;
  if (!bundle) return null;

  const report = bundle.report;
  const completed = bundle.run.status === 'completed' && !!report;
  const selected = pairParam && bundle.pairs.some((p) => p.pair_id === pairParam) ? pairParam : bundle.pairs[0]?.pair_id ?? null;
  const proofs = bundle.sandbox_proofs.length;
  const critical = report?.release.counts.critical ?? 0;
  const label = bundle.version_b.label;

  async function resume() {
    setResuming(true);
    setResumeErr(null);
    try {
      await api(`/api/test-runs/${id}/resume`, { method: 'POST', json: {} });
      push({ title: 'Run resumed', body: 'The run continued from its last completed stage.' });
      reload();
    } catch (e) {
      setResumeErr(e as Error);
    } finally {
      setResuming(false);
    }
  }

  const open = (pid: string) => {
    setUrl({ pair: pid });
    setDrawer(true);
  };
  const toInspector = (pid: string | null) => {
    setDrawer(false);
    setUrl({ tab: 'inspector', ...(pid ? { pair: pid } : {}) });
  };
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const n = e.key === 'ArrowRight' ? TABS[(i + 1) % 3] : e.key === 'ArrowLeft' ? TABS[(i + 2) % 3] : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS[2] : null;
    if (!n) return;
    e.preventDefault();
    setDrawer(false);
    setUrl({ tab: n });
    requestAnimationFrame(() => document.getElementById(`tab-${n}`)?.focus());
  };

  const tabInfo: Record<Tab, { label: string; Icon: typeof LayoutGrid; count?: number; hot?: boolean }> = {
    matrix: { label: 'Transaction twin matrix', Icon: LayoutGrid, count: bundle.pairs.length },
    inspector: { label: 'Scenario inspector', Icon: Microscope },
    gate: { label: 'Release gate', Icon: Gavel, count: critical || undefined, hot: critical > 0 },
  };

  return (
    <div>
      <div ref={header} style={{ top: TOPBAR }} className="sticky z-30 -mx-4 border-b border-line bg-canvas/95 px-4 pb-0 pt-3 backdrop-blur sm:-mx-6 sm:px-6" data-testid="run-header">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <Link href={`/policies/${bundle.policy.id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-ink-mute hover:text-ink hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden />{bundle.policy.name}</Link>
            <h1 className="font-display text-2xl font-bold sm:text-3xl">Version A <span className="text-ink-mute">vs</span> Version {label}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="runtime-badges">
              <Chip mono>{bundle.run.id}</Chip>
              {report && <ProvenanceBadge kind={report.executed_mode === 'sandbox' ? 'sandbox' : 'simulated'} />}
              {report && <Chip tone="plain">{report.ai.mode === 'openai' ? `AI: ${report.ai.model}` : 'AI: deterministic agents'}</Chip>}
              {proofs > 0 && <Chip tone="info">Lane 2 verified: {proofs} pair{proofs === 1 ? '' : 's'}</Chip>}
              {bundle.read_only && <Chip tone="warn">Shared read-only example</Chip>}
              {bundle.parent_run_id && <Link href={`/runs/${bundle.parent_run_id}?tab=gate`}><Chip tone="info">re-run of {bundle.parent_run_id} →</Chip></Link>}
              {bundle.child_run_id && <Link href={`/runs/${bundle.child_run_id}?tab=gate`}><Chip tone="info">re-run as {bundle.child_run_id} →</Chip></Link>}
            </div>
          </div>
          <div className="text-right">
            <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-mute">Release recommendation — not an approval</div>
            <VerdictBadge v={bundle.run.release_decision} big />
          </div>
        </div>
        {completed && (
          <div role="tablist" aria-label="Run sections" onKeyDown={onTabKey} className="-mb-px mt-2 flex gap-1 overflow-x-auto">
            {TABS.map((t) => {
              const I = tabInfo[t];
              const on = tab === t;
              return (
                <button key={t} id={`tab-${t}`} role="tab" type="button" aria-selected={on} aria-controls={`panel-${t}`} tabIndex={on ? 0 : -1} data-testid={`tab-${t}`} onClick={() => { setDrawer(false); setUrl({ tab: t }); }} className={cx('inline-flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-semibold transition', on ? 'border-brand text-ink' : 'border-transparent text-ink-mute hover:text-ink')}>
                  <I.Icon className="h-4 w-4" aria-hidden />
                  {I.label}
                  {I.count !== undefined && <span className={cx('rounded-full px-1.5 text-[11px] font-bold tabular-nums', I.hot ? 'bg-block text-white' : 'bg-surface-2 text-ink-mute')}>{I.count}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Only the content makes room for the docked drawer; the header (and its verdict) keeps the full width. */}
      <div className={cx('pt-5', tab === 'matrix' && drawer && 'lg:pr-[min(36rem,46vw)]')}>
        {!completed ? (
          bundle.run.status === 'failed' || bundle.run.failed_stage ? (
            <ErrorRecovery
              title="This run did not finish"
              what={`${bundle.run.failed_stage ? `Stopped while in “${bundle.run.failed_stage}”. ` : ''}${bundle.run.last_error ?? 'No error detail was recorded.'}`}
              moneyMoved={NO_MONEY_SHADOW}
              safeToRetry="Yes. Resuming continues from the last completed stage and never repeats finished work."
              onRetry={bundle.read_only ? undefined : resume}
              retryLabel={resuming ? 'Resuming…' : 'Resume run'}
              reference={resumeErr ? (resumeErr as { reference?: string }).reference : undefined}
              next={resumeErr ? errMsg(resumeErr) : undefined}
            />
          ) : (
            <div className="card flex items-center gap-3 p-5 text-sm" role="status">
              {working && <Spinner />}
              <span>This run is at stage <b>{bundle.run.stage}</b>{working ? ' and is still working. This page refreshes by itself.' : '.'}</span>
              {!bundle.read_only && !working && <button className="btn-primary ml-auto" onClick={resume} disabled={resuming}>Continue run</button>}
              <button className="btn-quiet" onClick={reload}>Refresh</button>
            </div>
          )
        ) : (
          <>
            <div id="panel-matrix" role="tabpanel" aria-labelledby="tab-matrix" hidden={tab !== 'matrix'}>
              {tab === 'matrix' && <TwinMatrix bundle={bundle} selected={drawer ? selected : null} onSelect={open} />}
            </div>
            <div id="panel-inspector" role="tabpanel" aria-labelledby="tab-inspector" hidden={tab !== 'inspector'}>
              {tab === 'inspector' && <ScenarioEvidence bundle={bundle} pairId={selected} onPairChange={(p) => setUrl({ pair: p })} onChanged={reload} picker />}
            </div>
            <div id="panel-gate" role="tabpanel" aria-labelledby="tab-gate" hidden={tab !== 'gate'}>
              {tab === 'gate' && <ReleaseGate bundle={bundle} onChanged={reload} guided={guided} onInspect={(p) => toInspector(p)} />}
            </div>
          </>
        )}
      </div>

      {completed && tab === 'matrix' && (
        <ScenarioDrawer bundle={bundle} pairId={selected} open={drawer} onClose={() => setDrawer(false)} onPairChange={(p) => setUrl({ pair: p })} onChanged={reload} onOpenInspector={() => toInspector(selected)} />
      )}
    </div>
  );
}
