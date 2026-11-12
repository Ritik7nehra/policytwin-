'use client';

import { ChevronLeft, ChevronRight, CircleAlert, FlaskConical, LoaderCircle, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { PairView, RunBundle, ScenarioView, SandboxProof } from '@/lib/pipeline';
import { api, cx, fmtDateTime } from '@/lib/client';
import { CATEGORY_LABEL } from '@/lib/policy/view';
import type { TestCategory } from '@/lib/types';
import { Chip, DecisionTransition, ProvenanceBadge, SeverityBadge } from '../ds/badges';
import { ConfirmationDialog } from '../ds/overlays';
import { ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import { JsonBlock } from '../ds/Card';
import { EvidenceTimeline, IdRow, InvariantResult, TransactionTwinCard } from '../ds/twin';
import { useToast } from '../ds/Toast';

function Section({ title, right, children, id }: { title: string; right?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id} className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="font-display text-base font-bold">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function DecisionBox({ title, d }: { title: string; d: ScenarioView['new_decision'] }) {
  if (!d) return null;
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">{title}</span>
        <Chip tone={d.decision === 'AUTO_REFUND' ? 'info' : 'plain'}>{d.decision === 'AUTO_REFUND' ? 'REFUND' : d.decision}</Chip>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {d.reason_codes.map((c) => <Chip key={c} mono>{c}</Chip>)}
        {d.detail_json.conditions_triggered.map((c) => <Chip key={c} tone="good">{c}</Chip>)}
        {d.detail_json.flags.map((c) => <Chip key={c} tone="warn" icon={<TriangleAlert className="h-3 w-3" aria-hidden />}>{c}</Chip>)}
      </div>
      <p className="mt-2 text-xs text-ink-mute">{d.explanation}</p>
    </div>
  );
}

function ProofResult({ proof }: { proof: SandboxProof }) {
  const real = proof.mode === 'sandbox';
  return (
    <div className="space-y-3" data-testid="sandbox-proof-result">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind={real ? 'sandbox' : 'simulated'} />
        <span className="text-xs text-ink-mute">Recorded {fmtDateTime(proof.recorded_at)} by {proof.actor}</span>
      </div>
      <p role="status" data-agrees={proof.agrees_with_shadow} className={cx('flex items-start gap-2 rounded-lg border p-3 text-sm font-semibold', proof.agrees_with_shadow ? 'border-pass/30 bg-pass-bg text-pass-ink' : 'border-block/40 bg-block-bg text-block-ink')}>
        {proof.agrees_with_shadow ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
        {proof.agrees_with_shadow
          ? `The ${real ? 'PayPal Sandbox' : 'second simulator'} run reached the same invariant outcomes as the full run.`
          : `The ${real ? 'PayPal Sandbox' : 'second simulator'} run DISAGREES with the full run. The release verdict was not changed — a human should investigate before relying on either.`}
      </p>
      {proof.errors.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-block-ink">{proof.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="grid gap-3 sm:grid-cols-2">
        {proof.scenarios.map((s) => (
          <div key={s.scenario_id} className="rounded-lg border border-line bg-surface p-3 text-xs">
            <p className="mb-1.5 font-mono font-semibold">{s.scenario_key}</p>
            <dl className="space-y-1">
              <IdRow label="order" value={s.order_id} />
              <IdRow label="capture" value={s.capture_id} />
              <IdRow label="refunds" value={s.refund_ids.join(', ') || null} />
              <div className="flex justify-between gap-2"><dt className="text-ink-mute">HTTP</dt><dd className="font-mono">{s.http_statuses.join(' ') || '—'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-mute">Failed invariants</dt><dd className="text-right font-mono">{s.failed_invariants.join(', ') || 'none'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-mute">Full run said</dt><dd className="text-right font-mono">{s.shadow_failed_invariants.join(', ') || 'none'}</dd></div>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

function Lane2({ bundle, pair, onChanged }: { bundle: RunBundle; pair: PairView; onChanged: () => void }) {
  const { push } = useToast();
  const proof = bundle.sandbox_proofs.find((p) => p.pair_id === pair.pair_id) ?? null;
  const real = bundle.runtime.lane2_mode === 'sandbox';
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const done = bundle.run.stage === 'COMPLETED' || bundle.run.stage === 'DECIDED';

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/test-runs/${bundle.run.id}/sandbox-proof`, { json: { pair_id: pair.pair_id } });
      push({ title: real ? 'Verified in PayPal Sandbox' : 'Second simulator run recorded', body: `${pair.pair_id}: resource ids attached to this pair. The release verdict is unchanged.` });
      setConfirm(false);
      onChanged();
    } catch (e) {
      setErr(e as Error);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id={`lane2-${pair.pair_id}`} title="Lane 2 · Verify in PayPal Sandbox" right={<ProvenanceBadge kind={real ? 'sandbox' : 'simulated'} />}>
      {proof ? (
        <ProofResult proof={proof} />
      ) : (
        <div className="space-y-3 rounded-xl border border-dashed border-line-strong p-4">
          <p className="text-sm text-ink-mute">
            {real
              ? 'Re-run just this pair against the real PayPal Sandbox (test money): create → approve → capture → refund → read back → retry with the same request id. The resource ids are attached to these same scenarios.'
              : 'No PayPal Sandbox credentials are configured on this server, so this would run on the simulator a second time — and be labelled SIMULATED. It cannot prove anything about PayPal.'}
          </p>
          {!bundle.read_only && (
            <button type="button" className="btn-navy" disabled={!done || busy} onClick={() => setConfirm(true)} data-testid="verify-sandbox">
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <FlaskConical className="h-4 w-4" aria-hidden />}
              {real ? 'Verify this pair in PayPal Sandbox' : 'Run this pair again (simulated)'}
            </button>
          )}
          {!done && <p className="text-xs text-ink-mute">Finish the full run first.</p>}
        </div>
      )}
      {err && <ErrorRecovery title="Sandbox verification failed" what={err.message} moneyMoved={real ? 'Possibly Sandbox test money only: some operations may have completed before the failure. No production money is ever involved.' : NO_MONEY_SHADOW} safeToRetry="Yes. Request ids are stable, so PayPal replays the original result instead of repeating an operation." onRetry={() => setConfirm(true)} reference={(err as { reference?: string }).reference} />}
      <ConfirmationDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={real ? 'Run this pair in the PayPal Sandbox?' : 'Run this pair on the simulator again?'}
        description={
          real ? (
            <>
              <p>This makes real calls to the PayPal <b>Sandbox</b> with test money for {pair.pair_id} (two scenarios). It never contacts production PayPal.</p>
              <p>The result is attached as evidence. It cannot change the release recommendation.</p>
            </>
          ) : (
            <>
              <p>No Sandbox credentials are configured, so this repeats {pair.pair_id} on the in-process simulator. It is not PayPal.</p>
            </>
          )
        }
        confirmLabel={real ? 'Run in Sandbox' : 'Run on simulator'}
        busy={busy}
        onConfirm={go}
      />
    </Section>
  );
}

export default function ScenarioEvidence({ bundle, pairId, onPairChange, onChanged, picker = false, testId = 'inspector' }: { bundle: RunBundle; pairId: string | null; onPairChange: (id: string) => void; onChanged: () => void; picker?: boolean; testId?: string }) {
  const pairs = bundle.pairs;
  const idx = Math.max(0, pairs.findIndex((p) => p.pair_id === pairId));
  const pair = pairs[idx];
  const [side, setSide] = useState<'original' | 'twin'>('original');
  const [lane, setLane] = useState<'shadow' | 'sandbox_proof'>('shadow');
  if (!pair) return <p>No scenarios.</p>;

  const res = pair.result;
  const ai = bundle.report?.ai.mode === 'openai';
  const text = bundle.report?.narrative.finding_explanations.find((e) => e.pair_id === pair.pair_id)?.text ?? res?.explanation;
  const label = bundle.version_b.label;
  const scen = side === 'original' ? pair.base : pair.twin;
  const hasProof = bundle.sandbox_proofs.some((p) => p.pair_id === pair.pair_id);
  const events = scen.executions.filter((e) => e.lane === (hasProof ? lane : 'shadow'));
  const inv = [...pair.base.invariants.map((row) => ({ row, who: 'original' })), ...pair.twin.invariants.map((row) => ({ row, who: 'twin' }))].filter(({ row }) => row.lane === 'shadow');
  const ids = (s: ScenarioView) => ({
    order: s.executions.find((e) => e.lane === 'shadow' && e.paypal_order_id)?.paypal_order_id ?? null,
    capture: s.executions.find((e) => e.lane === 'shadow' && e.paypal_capture_id)?.paypal_capture_id ?? null,
    refunds: [...new Set(s.executions.filter((e) => e.lane === 'shadow').map((e) => e.paypal_refund_id).filter(Boolean))] as string[],
  });
  const go = (d: number) => onPairChange(pairs[(idx + d + pairs.length) % pairs.length].pair_id);

  return (
    <div className="space-y-6" data-testid={testId} data-pair={pair.pair_id}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button type="button" className="btn-ghost !min-h-8 !px-2" onClick={() => go(-1)} aria-label="Previous pair"><ChevronLeft className="h-4 w-4" aria-hidden /></button>
          <button type="button" className="btn-ghost !min-h-8 !px-2" onClick={() => go(1)} aria-label="Next pair"><ChevronRight className="h-4 w-4" aria-hidden /></button>
        </div>
        {picker && (
          <>
            <label className="label !mb-0" htmlFor="pairsel">Pair</label>
            <select id="pairsel" className="field !w-auto max-w-full" value={pair.pair_id} onChange={(e) => onPairChange(e.target.value)}>
              {pairs.map((p) => <option key={p.pair_id} value={p.pair_id}>{p.pair_id} — {p.label}</option>)}
            </select>
          </>
        )}
        <span className="font-mono text-xs text-ink-mute">{idx + 1} / {pairs.length}</span>
        {res && <SeverityBadge s={res.severity} />}
        {res && <Chip tone={res.outcome === 'AS_EXPECTED' ? 'good' : 'warn'}>{res.outcome.replace(/_/g, ' ').toLowerCase()}</Chip>}
      </div>

      <div>
        <h2 className="font-display text-xl font-bold">{pair.label}</h2>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Chip tone={pair.origin === 'adversarial' ? 'warn' : 'plain'}>{pair.origin}</Chip>
          <Chip tone="twin">changes {pair.changed_field.replace(/_/g, ' ')}</Chip>
          <Chip>{CATEGORY_LABEL[pair.category as TestCategory] ?? pair.category}</Chip>
          <Chip>{pair.expectation === 'must_differ' ? 'decision should change' : 'decision should NOT change'}</Chip>
        </div>
      </div>

      <Section id={`twins-${pair.pair_id}`} title="Transaction twins" right={<ProvenanceBadge kind="synthetic" compact />}>
        <div className="grid gap-3 md:grid-cols-2">
          <TransactionTwinCard title={`Original · ${pair.base.scenario_id}`} tx={pair.base.input} other={pair.twin.input} changed={pair.changed_field} testId="twin-original" />
          <TransactionTwinCard title={`Twin · ${pair.twin.scenario_id}`} tx={pair.twin.input} other={pair.base.input} changed={pair.changed_field} testId="twin-twin" />
        </div>
        <p className="text-xs text-ink-mute">Only the marked field differs. Every other field is held constant; code rejects any pair that changes more.</p>
      </Section>

      <Section id={`why-${pair.pair_id}`} title="What happened" right={<ProvenanceBadge kind={ai ? 'ai' : 'deterministic'} compact />}>
        <p className="text-sm"><b>Why this field matters.</b> {pair.rationale}</p>
        {text && <p className="text-sm"><b>Finding.</b> {text}</p>}
        {res && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-surface-2 p-3 text-sm">
            <span className="flex items-center gap-2"><span className="text-xs text-ink-mute">Version A</span><DecisionTransition from={res.old_base} to={res.old_twin} label="Version A" /></span>
            <span className="flex items-center gap-2"><span className="text-xs text-ink-mute">Version {label}</span><DecisionTransition from={res.new_base} to={res.new_twin} label={`Version ${label}`} /></span>
          </div>
        )}
        {!ai && <p className="text-xs text-ink-mute">Explanation text is a deterministic template; no AI was used for this run.</p>}
      </Section>

      <Section id={`path-${pair.pair_id}`} title="Decision path">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2"><p className="label !mb-0">Original</p><DecisionBox title="Version A (current)" d={pair.base.old_decision} /><DecisionBox title={`Version ${label} (candidate)`} d={pair.base.new_decision} /></div>
          <div className="space-y-2"><p className="label !mb-0">Twin</p><DecisionBox title="Version A (current)" d={pair.twin.old_decision} /><DecisionBox title={`Version ${label} (candidate)`} d={pair.twin.new_decision} /></div>
        </div>
      </Section>

      <Section
        id={`ev-${pair.pair_id}`}
        title="Payment evidence"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Scenario" className="inline-flex overflow-hidden rounded-lg border border-line-strong text-xs">
              {(['original', 'twin'] as const).map((s) => (
                <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)} className={cx('px-3 py-1.5 font-semibold capitalize', side === s ? 'bg-navy text-white' : 'bg-surface hover:bg-surface-2')}>{s}</button>
              ))}
            </div>
            {hasProof && (
              <div role="group" aria-label="Lane" className="inline-flex overflow-hidden rounded-lg border border-line-strong text-xs">
                <button type="button" aria-pressed={lane === 'shadow'} onClick={() => setLane('shadow')} className={cx('px-3 py-1.5 font-semibold', lane === 'shadow' ? 'bg-navy text-white' : 'bg-surface hover:bg-surface-2')}>Full run</button>
                <button type="button" aria-pressed={lane === 'sandbox_proof'} onClick={() => setLane('sandbox_proof')} className={cx('px-3 py-1.5 font-semibold', lane === 'sandbox_proof' ? 'bg-navy text-white' : 'bg-surface hover:bg-surface-2')}>Lane 2 proof</button>
              </div>
            )}
          </div>
        }
      >
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-mute">
          <ProvenanceBadge kind={events[0]?.mode ?? 'simulated'} compact /> {events[0]?.mode === 'sandbox' ? 'Requests below were sent to the PayPal Sandbox.' : 'Requests below were handled by the in-process simulator — not PayPal.'}
        </p>
        <EvidenceTimeline events={events} />
        <div className="grid gap-3 sm:grid-cols-2">
          {([['Original', ids(pair.base)], ['Twin', ids(pair.twin)]] as const).map(([t, v]) => (
            <div key={t} className="rounded-lg border border-line bg-surface p-3 text-xs">
              <p className="mb-1.5 font-bold">{t} · resource ids {bundle.runtime.lane1_mode === 'simulated' && <span className="font-normal text-ink-mute">(simulated)</span>}</p>
              <dl><IdRow label="order" value={v.order} /><IdRow label="capture" value={v.capture} /><IdRow label="refunds" value={v.refunds.join(', ') || null} /></dl>
            </div>
          ))}
        </div>
      </Section>

      <Section id={`inv-${pair.pair_id}`} title="Invariant results" right={<ProvenanceBadge kind="deterministic" compact />}>
        <InvariantResult rows={inv} />
        <p className="text-xs text-ink-mute">Deterministic code decides these — never the AI.</p>
      </Section>

      <Lane2 bundle={bundle} pair={pair} onChanged={onChanged} />

      <details className="rounded-lg border border-line">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Raw scenario inputs (JSON)</summary>
        <div className="grid gap-3 p-3 md:grid-cols-2"><JsonBlock value={pair.base.input} highlightKey={pair.changed_field} /><JsonBlock value={pair.twin.input} highlightKey={pair.changed_field} /></div>
      </details>
    </div>
  );
}
