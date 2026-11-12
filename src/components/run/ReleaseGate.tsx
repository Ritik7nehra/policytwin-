'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, GitCompare, History, ListChecks, Scale } from 'lucide-react';
import { useState } from 'react';
import type { RunBundle } from '@/lib/pipeline';
import { api, fmtDateTime } from '@/lib/client';
import { CATEGORY_LABEL } from '@/lib/policy/view';
import { Chip, SeverityBadge, VerdictBadge, type Verdict } from '../ds/badges';
import { Card } from '../ds/Card';
import { ConfirmationDialog } from '../ds/overlays';
import { PolicyDiff } from '../ds/policy';
import { useToast } from '../ds/Toast';
import { HumanDecisionPanel, ImpactPanel, ReleaseVerdict } from './panels';

export default function ReleaseGate({ bundle, onChanged, guided, onInspect }: { bundle: RunBundle; onChanged: () => void; guided: boolean; onInspect: (pairId: string) => void }) {
  const router = useRouter();
  const { push } = useToast();
  const r = bundle.report!;
  const rel = r.release;
  const id = bundle.run.id;
  const [note, setNote] = useState('');
  const [dlg, setDlg] = useState<null | 'repair' | 'approve' | 'reject'>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const critical = r.pair_results.filter((p) => p.severity === 'critical');
  const hd = r.human_decision;
  const ro = bundle.read_only;
  const needNote = rel.decision === 'REVIEW' && note.trim().length < 10;
  const repair = r.repair;
  const polC = repair?.policy ?? null;
  const polB = bundle.version_b.structured_policy_json;

  async function approveRepair() {
    setBusy(true);
    setErr(null);
    try {
      const out = await api<{ run_id: string; release_decision: Verdict | null }>(`/api/test-runs/${id}/approve-repair`, { json: { note } });
      push({ title: 'Repair approved — all scenarios re-run', body: `Version C was tested again: ${out.release_decision ?? 'result pending'}. You still decide on the release.` });
      setDlg(null);
      router.push(`/runs/${out.run_id}?tab=gate`);
    } catch (e) {
      setErr(e as Error);
      setDlg(null);
      setBusy(false);
    }
  }
  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/test-runs/${id}/decision`, { json: { decision, note } });
      push({ title: decision === 'approve' ? 'Release approved by you' : 'Release rejected by you', body: 'Recorded in the audit trail with your session identity.' });
      setDlg(null);
      onChanged();
    } catch (e) {
      setErr(e as Error);
      setDlg(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="release-gate">
      {guided && !hd && (
        <div role="status" data-testid="guided-banner" className="flex flex-wrap items-center gap-3 rounded-xl border border-brand/30 bg-brand-bg p-4 text-sm">
          <ListChecks className="h-5 w-5 shrink-0 text-brand-ink" aria-hidden />
          <p className="min-w-0 flex-1"><b>Guided demo — your turn.</b> {rel.decision === 'BLOCK' ? 'The proposed policy was blocked. Read the critical findings, then review the suggested correction and approve it to re-run every scenario.' : 'Read the evidence, then record your own decision at the bottom of this page.'}</p>
        </div>
      )}
      {ro && <p className="rounded-xl border border-review/40 bg-review-bg p-3 text-sm text-review-ink">This is the shared read-only example. Decisions and re-runs are disabled here; run the demo to try them in your own workspace.</p>}

      <ReleaseVerdict bundle={bundle} />

      {critical.length > 0 && (
        <Card title="Critical regressions" icon={<Scale className="h-5 w-5 text-block-ink" aria-hidden />} right={<Chip tone="bad">{critical.length}</Chip>}>
          <ul className="space-y-3" data-testid="critical-list">
            {critical.map((p) => (
              <li key={p.pair_id} className="rounded-xl border border-block/30 bg-block-bg/50 p-3.5 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2"><b>{p.pair_id} — {p.label}</b><SeverityBadge s={p.severity} /></div>
                <p>{r.narrative.finding_explanations.find((e) => e.pair_id === p.pair_id)?.text ?? p.headline}</p>
                {p.failed_invariants.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{p.failed_invariants.map((c) => <Chip key={c} tone="bad" mono>{c}</Chip>)}</div>}
                <button type="button" className="btn-ghost mt-3 !min-h-8 !px-3 text-xs" onClick={() => onInspect(p.pair_id)}>Open evidence <ArrowRight className="h-3.5 w-3.5" aria-hidden /></button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ImpactPanel report={r} />

      {repair && (
        <Card title="Recommended policy correction" icon={<GitCompare className="h-5 w-5 text-brand-ink" aria-hidden />} right={<Chip tone={repair.status === 'approved' ? 'good' : 'info'}>{repair.status === 'approved' ? 'approved & re-run' : `proposed by ${repair.generated_by === 'llm' ? 'AI' : 'code'}`}</Chip>}>
          <div className="grid gap-4 md:grid-cols-2">
            <div><div className="label">Proposed (Version {bundle.version_b.label})</div><blockquote className="rounded-lg border-l-4 border-block bg-block-bg/50 px-4 py-3 text-sm">{bundle.version_b.source_text}</blockquote></div>
            <div><div className="label">Corrected (Version C)</div><blockquote className="rounded-lg border-l-4 border-pass bg-pass-bg/60 px-4 py-3 text-sm" data-testid="corrected-text">{repair.source_text}</blockquote></div>
          </div>
          {polB && polC && <div className="mt-4"><h3 className="label">What changes (B → C)</h3><PolicyDiff a={polB} b={polC} /></div>}
          <div className="mt-4 overflow-x-auto rounded-xl border border-line" tabIndex={0} role="region" aria-label="Policy correction table (scrolls sideways on narrow screens)">
            <table className="w-full min-w-[32rem] text-left text-xs">
              <caption className="sr-only">Changes between the proposed and the corrected policy</caption>
              <thead><tr className="border-b border-line bg-surface-2 uppercase tracking-wide text-ink-mute"><th className="px-3 py-2">Field</th><th className="px-3 py-2">From</th><th className="px-3 py-2">To</th><th className="px-3 py-2">Why</th></tr></thead>
              <tbody>{repair.changes.map((c) => <tr key={c.field} className="border-b border-line align-top last:border-0"><td className="px-3 py-1.5 font-mono">{c.field}</td><td className="px-3 py-1.5">{c.from}</td><td className="px-3 py-1.5 font-semibold">{c.to}</td><td className="px-3 py-1.5">{c.reason}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-ink-mute">{repair.rationale}</p>
          {!repair.text_matches_structure && <p className="mt-2 text-sm font-semibold text-review-ink">⚠ The corrected text does not round-trip to the corrected structure — review before approving.</p>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {repair.status === 'proposed' && !r.superseded_by ? (
              !ro && (
                <button type="button" className="btn-primary" onClick={() => setDlg('repair')} disabled={busy} data-testid="approve-repair">
                  Approve repair & re-run all scenarios
                </button>
              )
            ) : (
              r.superseded_by && <Link className="btn-ghost" href={`/runs/${r.superseded_by}?tab=gate`}>Open the re-run <ArrowRight className="h-4 w-4" aria-hidden /></Link>
            )}
            <span className="text-xs text-ink-mute">The AI proposes; a human approves; the corrected policy must pass every scenario again.</span>
          </div>
        </Card>
      )}

      <Card title="Test coverage" icon={<ListChecks className="h-5 w-5 text-brand-ink" aria-hidden />}>
        <div className="flex flex-wrap gap-2" data-testid="coverage">
          {rel.coverage.required.map((c) => {
            const ok = rel.coverage.covered.includes(c);
            return <Chip key={c} tone={ok ? 'good' : 'warn'}>{ok ? '✓ covered' : '✗ missing'}: {CATEGORY_LABEL[c] ?? c}</Chip>;
          })}
          {rel.coverage.required.length === 0 && <span className="text-sm text-ink-mute">No required categories.</span>}
        </div>
        <p className="mt-3 text-xs text-ink-mute">{Math.round(rel.coverage.ratio * 100)}% of required categories executed. Also covered: {rel.coverage.covered.filter((c) => !rel.coverage.required.includes(c)).map((c) => CATEGORY_LABEL[c] ?? c).join(', ') || '—'}.</p>
      </Card>

      <Card title="Run history" icon={<History className="h-5 w-5 text-brand-ink" aria-hidden />}>
        <ol className="space-y-2 text-sm" data-testid="run-lineage">
          {bundle.parent_run_id && <li><Link className="font-semibold text-brand-ink hover:underline" href={`/runs/${bundle.parent_run_id}?tab=gate`}>Earlier run {bundle.parent_run_id}</Link> <span className="text-ink-mute">— the policy before correction</span></li>}
          <li className="flex flex-wrap items-center gap-2"><VerdictBadge v={bundle.run.release_decision} /> <b>This run</b> <span className="font-mono text-xs text-ink-mute">{id}</span> <span className="text-ink-mute">{fmtDateTime(bundle.run.started_at)}</span></li>
          {bundle.child_run_id && <li><Link className="font-semibold text-brand-ink hover:underline" href={`/runs/${bundle.child_run_id}?tab=gate`}>Re-run {bundle.child_run_id}</Link> <span className="text-ink-mute">— corrected policy tested again</span></li>}
        </ol>
        <p className="mt-3 text-xs text-ink-mute">{bundle.audit.length} audit event{bundle.audit.length === 1 ? '' : 's'} recorded for this run.</p>
      </Card>

      <HumanDecisionPanel runId={id} release={rel.decision} decision={hd} readOnly={ro} note={note} onNote={setNote} needNote={needNote} busy={busy} err={err} onApprove={() => setDlg('approve')} onReject={() => setDlg('reject')} />

      <ConfirmationDialog
        open={dlg === 'repair'}
        onOpenChange={(o) => !o && setDlg(null)}
        title="Approve the correction and re-run?"
        description={<><p>You are approving <b>Version C</b>, the corrected policy text shown above, for testing only.</p><p>Every scenario will be run again against it. <b>Nothing is released</b> and no human release decision is recorded by this step.</p></>}
        confirmLabel="Approve & re-run"
        busy={busy}
        onConfirm={approveRepair}
      />
      <ConfirmationDialog
        open={dlg === 'approve' || dlg === 'reject'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={dlg === 'approve' ? 'Record your approval of this release?' : 'Record your rejection of this release?'}
        tone={dlg === 'approve' ? 'pass' : 'danger'}
        description={
          <>
            <p>PolicyTwin’s recommendation was <b>{rel.decision}</b>. This is <b>your</b> decision, recorded under your session identity with a timestamp, and it cannot be edited afterwards.</p>
            {note.trim() && <p className="rounded-lg bg-surface-2 p-2 text-ink">“{note.trim()}”</p>}
            {dlg === 'approve' && <p>This prototype does not release anything to production.</p>}
          </>
        }
        confirmLabel={dlg === 'approve' ? 'Record approval' : 'Record rejection'}
        busy={busy}
        onConfirm={() => decide(dlg === 'approve' ? 'approve' : 'reject')}
      />
    </div>
  );
}
