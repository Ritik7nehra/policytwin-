'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Play } from 'lucide-react';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { ApiError } from '@/lib/client';
import { FlowError, emptyFlow, runFlow, type FlowState, type StepId, type StepStatus } from '@/lib/flows';
import { PipelineStepper, initialStatus } from '../ds/PipelineStepper';
import { ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import { Sheet } from '../ds/overlays';
import { useToast } from '../ds/Toast';
import { useSession } from './SessionProvider';

interface DemoCtx {
  open: () => void;
}
const Ctx = createContext<DemoCtx>({ open: () => undefined });
export const useDemo = () => useContext(Ctx);

type Phase = 'intro' | 'running' | 'error' | 'done';

/**
 * Guided demo: creates the fictional "Low-Value Missing-Delivery Refund" policy, runs the whole test, and STOPS at the
 * Release Gate. It never approves a repair and never records a human decision — those stay with the person.
 */
export function DemoProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { push } = useToast();
  const { authed, refresh } = useSession();
  const [openDlg, setOpenDlg] = useState(false);
  const [phase, setPhase] = useState<Phase>('intro');
  const [status, setStatus] = useState<Record<StepId, StepStatus>>(initialStatus());
  const [err, setErr] = useState<FlowError | Error | null>(null);
  const flow = useRef<FlowState>(emptyFlow());
  const abort = useRef<AbortController | null>(null);

  const open = useCallback(() => {
    setOpenDlg(true);
    if (phase !== 'running') {
      flow.current = emptyFlow();
      setStatus(initialStatus());
      setErr(null);
      setPhase('intro');
    }
  }, [phase]);

  const start = useCallback(async () => {
    setPhase('running');
    setErr(null);
    abort.current = new AbortController();
    try {
      const state = await runFlow(
        {
          intake: flow.current.policyId ? undefined : { ...DEMO_POLICY_INPUT, affected_products: [...DEMO_POLICY_INPUT.affected_products], target_markets: [...DEMO_POLICY_INPUT.target_markets] },
          adversarial: true,
          state: flow.current,
        },
        (id, s) => setStatus((p) => ({ ...p, [id]: s })),
        abort.current.signal,
      );
      flow.current = state;
      setPhase('done');
      void refresh();
      push({ title: 'Demo run complete', body: `Release recommendation: ${state.verdict ?? 'n/a'}. Nothing is released until a human decides.` });
      setTimeout(() => {
        setOpenDlg(false);
        router.push(`/runs/${state.runId}?tab=gate&guided=1`);
      }, 900);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setErr(e as Error);
      setPhase('error');
    }
  }, [push, refresh, router]);

  const value = useMemo(() => ({ open }), [open]);
  const failedStep = err instanceof FlowError ? err.step : null;
  const apiErr = (err instanceof FlowError ? err.cause : err) as unknown;
  const quota = apiErr instanceof ApiError && apiErr.code === 'QUOTA_EXCEEDED';

  return (
    <Ctx.Provider value={value}>
      {children}
      <Sheet
        open={openDlg}
        onOpenChange={(o) => {
          if (!o && phase === 'running') abort.current?.abort();
          setOpenDlg(o);
        }}
        title="Guided demo"
        description="Fictional policy · synthetic data · simulated payments"
        testId="demo-dialog"
      >
        <div className="space-y-4">
          {phase === 'intro' && (
            <>
              <div className="rounded-xl border border-line bg-surface-2 p-4 text-sm">
                <p className="font-semibold">“Automatically refund transactions of $50 or less when tracking information is unavailable.”</p>
                <p className="mt-2 text-ink-mute">PolicyTwin will test this change against the current rule (“all missing-delivery claims require manual review”). It stops at the Release Gate so you can read the evidence and decide.</p>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink-mute">
                <li>Creates a policy in your own workspace (counts toward your quota).</li>
                <li>Runs about 20 scenarios on the deterministic engine and the payment simulator.</li>
                <li>Does not approve anything. You approve or reject.</li>
              </ul>
              <div className="rounded-lg bg-review-bg p-3 text-xs text-review-ink">{NO_MONEY_SHADOW}</div>
              <button type="button" className="btn-primary w-full" onClick={start} disabled={!authed} data-testid="demo-start">
                <Play className="h-4 w-4" aria-hidden />
                Start guided run
              </button>
            </>
          )}
          {phase !== 'intro' && <PipelineStepper status={status} />}
          {phase === 'error' && err && (
            <ErrorRecovery
              title={failedStep ? `Stopped at: ${failedStep}` : 'The demo could not finish'}
              what={err.message}
              moneyMoved={NO_MONEY_SHADOW}
              safeToRetry={quota ? 'Not until you free up quota (reset your workspace from the avatar menu).' : 'Yes. Every stage is idempotent: retrying resumes at the failed step and never duplicates work.'}
              next={quota ? 'Open the avatar menu → “Reset my workspace”, then run the demo again.' : undefined}
              onRetry={quota ? undefined : start}
              retryLabel="Resume from this step"
              reference={apiErr instanceof ApiError ? apiErr.reference : undefined}
            />
          )}
          {phase === 'done' && (
            <p className="flex items-center gap-2 rounded-lg bg-pass-bg p-3 text-sm font-semibold text-pass-ink" role="status">
              <ArrowRight className="h-4 w-4" aria-hidden />
              Opening the Release Gate…
            </p>
          )}
        </div>
      </Sheet>
    </Ctx.Provider>
  );
}
