'use client';

import { Download, ExternalLink, FileText, UserCheck } from 'lucide-react';
import type { RunBundle } from '@/lib/pipeline';
import { cx, errMsg, fmtDateTime } from '@/lib/client';
import { VERDICT_STYLE, ProvenanceBadge, VerdictBadge, type Verdict } from '../ds/badges';
import { Card } from '../ds/Card';
import { ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';

type Report = NonNullable<RunBundle['report']>;

/** The release recommendation. It is a recommendation, never an approval — the wording is part of the component. */
export function ReleaseVerdict({ bundle }: { bundle: RunBundle }) {
  const rel = bundle.report!.release;
  const s = VERDICT_STYLE[rel.decision];
  return (
    <section className={cx('rounded-2xl border-2 p-4 sm:p-6', s.box)} aria-labelledby="gate-h" data-testid="verdict-panel">
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div>
          <p id="gate-h" className={cx('text-xs font-bold uppercase tracking-[0.12em]', s.text)}>Release recommendation — not an approval</p>
          <p className={cx('mt-1 flex items-center gap-3 font-display text-5xl font-bold', s.text)} data-testid="gate-verdict"><s.Icon className="h-10 w-10" aria-hidden />{rel.decision}</p>
          <p className="mt-1 text-sm text-ink">{s.note}. A person decides below.</p>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          {([['Pairs tested', rel.counts.pairs], ['As expected', rel.counts.passed], ['Critical', rel.counts.critical], ['Invariant failures', rel.counts.invariant_failures]] as const).map(([k, v]) => (
            <div key={k} className="rounded-xl bg-surface/80 px-3 py-2"><dd className="font-display text-2xl font-bold tabular-nums">{v}</dd><dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-mute">{k}</dt></div>
          ))}
        </dl>
      </div>
      <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-ink">{rel.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
      {rel.unverified_terms.length > 0 && (
        <div className="mt-4 rounded-lg border border-review/50 bg-review-bg p-3 text-sm text-review-ink">
          <p className="font-bold">Not verified by PolicyTwin</p>
          <ul className="mt-1 list-disc pl-5">{rel.unverified_terms.map((t) => <li key={t}>{t}</li>)}</ul>
          <p className="mt-1 text-xs">These terms could not be executed or tested, so a PASS is not possible until a human reviews them.</p>
        </div>
      )}
    </section>
  );
}

/** Synthetic impact estimate: facts observed in the run, plus labelled assumptions. Never PayPal data. */
export function ImpactPanel({ report: r }: { report: Report }) {
  return (
        <Card title="Estimated impact" right={<ProvenanceBadge kind="synthetic" />}>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-review-ink">Synthetic impact estimate — not PayPal data</p>
          <p className="mb-3 text-sm"><b>{r.narrative.headline}.</b> {r.narrative.narrative}</p>
          {r.impact.rows.length > 0 && (
            <div className="mb-4 overflow-x-auto rounded-xl border border-line" tabIndex={0} role="region" aria-label="Synthetic impact table (scrolls sideways on narrow screens)">
              <table className="w-full min-w-[30rem] text-left text-sm">
                <caption className="sr-only">Synthetic impact by finding</caption>
                <thead><tr className="border-b border-line bg-surface-2 text-xs uppercase tracking-wide text-ink-mute"><th className="px-3 py-2">Finding</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2 text-right">Synthetic txns</th><th className="px-3 py-2 text-right">Synthetic value</th></tr></thead>
                <tbody>{r.impact.rows.map((x) => (
                  <tr key={x.segment} className="border-b border-line last:border-0"><td className="px-3 py-2">{x.pair_id} · {x.label}</td><td className="px-3 py-2">{x.kind === 'incorrect_refunds' ? 'potentially incorrect refunds' : 'exposure (ambiguous)'}</td><td className="px-3 py-2 text-right tabular-nums">{x.count.toLocaleString('en-US')}</td><td className="px-3 py-2 text-right tabular-nums">${x.usd.toLocaleString('en-US')}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <div><h3 className="label">Facts — observed in this run</h3><ul className="list-disc space-y-1 pl-5 text-xs">{r.impact.facts.length ? r.impact.facts.map((f) => <li key={f}>{f}</li>) : <li>No failed scenarios.</li>}</ul></div>
            <div><h3 className="label">Assumptions — {r.impact.dataset_label}</h3><ul className="list-disc space-y-1 pl-5 text-xs">{r.impact.assumptions.map((f) => <li key={f}>{f}</li>)}</ul></div>
          </div>
          {r.narrative.affected_customer_types.length > 0 && <p className="mt-3 text-xs text-ink-mute">Affected customer types: {r.narrative.affected_customer_types.join('; ')}</p>}
        </Card>
  );
}

/**
 * Report links and the human's final decision. Nothing is approved here by default: the buttons only open the confirmation
 * dialogs owned by the Release Gate, and a BLOCK can never be approved.
 */
export function HumanDecisionPanel({
  runId: id,
  release,
  decision: hd,
  readOnly: ro,
  note,
  onNote,
  needNote,
  busy,
  err,
  onApprove,
  onReject,
}: {
  runId: string;
  release: Verdict;
  decision: Report['human_decision'];
  readOnly: boolean;
  note: string;
  onNote: (v: string) => void;
  needNote: boolean;
  busy: boolean;
  err: Error | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const rel = { decision: release };
  return (
        <Card title="Report & human decision" icon={<UserCheck className="h-5 w-5 text-brand-ink" aria-hidden />}>
          <div className="mb-4 flex flex-wrap gap-3">
            <a className="btn-ghost" href={`/api/test-runs/${id}/report?download=1`} data-testid="download-report"><Download className="h-4 w-4" aria-hidden /> Download report (HTML)</a>
            <a className="btn-ghost" href={`/api/test-runs/${id}/report`} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" aria-hidden /> Open report</a>
            <a className="btn-quiet" href={`/api/test-runs/${id}/report?format=json`} target="_blank" rel="noreferrer"><FileText className="h-4 w-4" aria-hidden /> JSON</a>
          </div>
          {hd ? (
            <div className="rounded-xl border border-line bg-surface-2 p-4 text-sm" data-testid="human-decision">
              <p className="flex flex-wrap items-center gap-2"><ProvenanceBadge kind="human" /><b>{hd.decision === 'approve' ? 'Approved' : 'Rejected'}</b> by {hd.actor} on {fmtDateTime(hd.at)} — the recommendation then was <VerdictBadge v={hd.release_at_decision as Verdict} /></p>
              {hd.note && <p className="mt-2 text-ink-mute">“{hd.note}”</p>}
            </div>
          ) : ro ? (
            <p className="text-sm text-ink-mute">No decision is recorded on the shared example.</p>
          ) : (
            <div>
              <label className="label" htmlFor="note">Decision note {rel.decision === 'REVIEW' && <span className="text-review-ink">(required to approve a REVIEW — at least 10 characters)</span>}</label>
              <textarea id="note" className="field mb-3 min-h-20" value={note} maxLength={1000} onChange={(e) => onNote(e.target.value)} placeholder="Why are you approving or rejecting this release?" />
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className="btn-pass" disabled={busy || rel.decision === 'BLOCK' || needNote} onClick={onApprove} data-testid="human-approve">Approve release</button>
                <button type="button" className="btn-danger" disabled={busy} onClick={onReject} data-testid="human-reject">Reject release</button>
                {rel.decision === 'BLOCK' && <span className="text-xs font-semibold text-block-ink">A BLOCK cannot be approved. Approve the proposed repair and re-run instead.</span>}
                {rel.decision === 'PASS' && <span className="text-xs text-ink-mute">PASS is a recommendation. Nothing is released until a human approves.</span>}
              </div>
            </div>
          )}
          {err && <div className="mt-4"><ErrorRecovery title="That action did not go through" what={errMsg(err)} moneyMoved={NO_MONEY_SHADOW} safeToRetry="Yes. Decisions and re-runs are recorded once; repeating after a failure cannot duplicate them." reference={(err as { reference?: string }).reference} /></div>}
        </Card>
  );
}
