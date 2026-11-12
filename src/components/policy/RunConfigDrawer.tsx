'use client';

import { useRouter } from 'next/navigation';
import { Play, ShieldCheck } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { buildAllPairs } from '@/lib/twins/generator';
import type { Policy } from '@/lib/policy/schema';
import { ApiError } from '@/lib/client';
import { FlowError, STEP_INFO, STEP_IDS, emptyFlow, runFlow, type FlowState, type StepId, type StepStatus } from '@/lib/flows';
import { Sheet } from '../ds/overlays';
import { PipelineStepper, initialStatus } from '../ds/PipelineStepper';
import { ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import { ProvenanceBadge } from '../ds/badges';
import { useSession } from '../shell/SessionProvider';
import { useToast } from '../ds/Toast';

/**
 * Run configuration: choose scenarios, see exactly what will execute and where, then start. After starting, the same drawer
 * shows the seven-stage progress and recovers from a failed stage by resuming it (every server stage is idempotent).
 */
export default function RunConfigDrawer({ open, onOpenChange, policyId, policyB, readOnly }: { open: boolean; onOpenChange: (o: boolean) => void; policyId: string; policyB: Policy | null; readOnly: boolean }) {
  const router = useRouter();
  const { runtime, session } = useSession();
  const { push } = useToast();
  const [adversarial, setAdversarial] = useState(true);
  const [phase, setPhase] = useState<'config' | 'running' | 'error'>('config');
  const [status, setStatus] = useState<Record<StepId, StepStatus>>(initialStatus());
  const [err, setErr] = useState<Error | null>(null);
  const state = useRef<FlowState>(emptyFlow(policyId));
  const abort = useRef<AbortController | null>(null);

  const pairs = useMemo(() => (policyB ? buildAllPairs(policyB, { adversarial }) : []), [policyB, adversarial]);
  const active = STEP_IDS.find((s) => status[s] === 'active');
  const sandbox = runtime?.lane2_mode === 'sandbox';
  const lim = session?.limits;
  const used = session?.usage?.runs ?? 0;

  async function start() {
    setPhase('running');
    setErr(null);
    abort.current = new AbortController();
    try {
      const st = await runFlow({ adversarial, state: state.current }, (id, s) => setStatus((p) => ({ ...p, [id]: s })), abort.current.signal);
      push({ title: 'Test run complete', body: `Release recommendation: ${st.verdict ?? 'n/a'}. A human still decides.` });
      onOpenChange(false);
      router.push(`/runs/${st.runId}`);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setErr(e as Error);
      setPhase('error');
    }
  }

  const failed = err instanceof FlowError ? err.step : null;
  const cause = (err instanceof FlowError ? err.cause : err) as unknown;
  const quota = cause instanceof ApiError && cause.code === 'QUOTA_EXCEEDED';

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o && phase === 'running') abort.current?.abort();
        if (!o && phase !== 'config') {
          setPhase('config');
          setStatus(initialStatus());
          state.current = emptyFlow(policyId);
        }
        onOpenChange(o);
      }}
      title="Configure test run"
      description="Choose what to test. Nothing executes until you start."
      testId="run-config"
    >
      <div className="space-y-5">
        {readOnly ? (
          <p className="rounded-lg bg-review-bg p-3 text-sm text-review-ink">This is the shared read-only example. Create your own policy change (or run the demo) to start a run.</p>
        ) : phase === 'config' ? (
          <>
            <fieldset className="space-y-3">
              <legend className="label">Scenarios</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[#1769E0]" checked disabled readOnly />
                <span className="text-sm"><b>Core twins</b> (6 pairs): product type, threshold, currency, retried request, open dispute, duplicate webhook.</span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3 has-[:checked]:border-brand has-[:checked]:bg-brand-bg/50">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[#1769E0]" checked={adversarial} onChange={(e) => setAdversarial(e.target.checked)} data-testid="adversarial-toggle" />
                <span className="text-sm"><b>Adversarial twins</b> (+4 pairs): exact boundary, evidence status, customer history, authorize → void → capture.</span>
              </label>
            </fieldset>

            <dl className="grid grid-cols-3 gap-2 text-center" data-testid="run-estimate">
              {[['Pairs', pairs.length], ['Scenarios', pairs.length * 2], ['Policies compared', 2]].map(([k, v]) => (
                <div key={k as string} className="rounded-xl bg-surface-2 px-2 py-3"><dd className="font-display text-2xl font-bold tabular-nums">{v}</dd><dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-mute">{k}</dt></div>
              ))}
            </dl>

            <section className="space-y-2 rounded-xl border border-line p-4 text-sm" aria-label="Where it runs">
              <p className="label !mb-1">Where it runs</p>
              <p className="flex flex-wrap items-center gap-2"><ProvenanceBadge kind="simulated" /> <span>Every scenario executes on the in-process simulator. <b>No PayPal Sandbox money moves.</b></span></p>
              <p className="flex flex-wrap items-center gap-2"><ProvenanceBadge kind={sandbox ? 'sandbox' : 'simulated'} /> <span>{sandbox ? 'After the run you can re-run one pair in the real PayPal Sandbox (test money).' : 'No Sandbox credentials are configured, so the optional single-pair “Sandbox” proof would also use the simulator — and says so.'}</span></p>
              <p className="flex flex-wrap items-center gap-2"><ProvenanceBadge kind={runtime?.ai_mode === 'openai' ? 'ai' : 'deterministic'} /> <span>{runtime?.ai_mode === 'openai' ? `AI (${runtime.ai_model}) proposes twins and explanations; code validates.` : 'Agents run their deterministic implementations (no AI key configured).'}</span></p>
            </section>

            {lim && <p className="text-xs text-ink-mute">Quota: {used} of {lim.maxRunsPerSession} runs used in this session.</p>}

            <button type="button" className="btn-primary w-full" onClick={start} disabled={!policyB} data-testid="start-run">
              <Play className="h-4 w-4" aria-hidden /> Start test run
            </button>
            <p className="flex items-start gap-2 text-xs text-ink-mute"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> The result is a release recommendation, not an approval. You decide afterwards.</p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold" role="status" aria-live="polite" data-testid="run-step">{active ? `${STEP_INFO[active].label}…` : phase === 'error' ? 'Stopped' : 'Starting…'}</p>
            <PipelineStepper status={status} />
            {phase === 'error' && err && (
              <ErrorRecovery
                title={failed ? `Stopped at: ${STEP_INFO[failed].label}` : 'The run could not finish'}
                what={err.message}
                moneyMoved={NO_MONEY_SHADOW}
                safeToRetry={quota ? 'Not until you free up quota (avatar menu → Reset my workspace).' : 'Yes. Retrying resumes at the failed stage; completed stages are not repeated.'}
                onRetry={quota ? undefined : start}
                retryLabel="Resume from this stage"
                reference={cause instanceof ApiError ? cause.reference : undefined}
              />
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
