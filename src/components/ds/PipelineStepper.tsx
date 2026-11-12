'use client';

import { Check, CircleAlert, LoaderCircle, SkipForward } from 'lucide-react';
import { STEP_IDS, STEP_INFO, type StepId, type StepStatus } from '@/lib/flows';
import { cx } from '@/lib/client';

const ACTOR_LABEL = { code: 'Code', ai: 'AI proposes · code validates', simulator: 'Simulator', human: 'Human' } as const;

/**
 * Seven-stage progress list. Each stage shows its status by icon + word (not colour alone) and who does the work.
 * `aria-live` announces the active step to screen readers.
 */
export function PipelineStepper({ status, compact }: { status: Record<StepId, StepStatus>; compact?: boolean }) {
  const active = STEP_IDS.find((s) => status[s] === 'active');
  return (
    <div>
      <p className="sr-only" aria-live="polite">
        {active ? `Now: ${STEP_INFO[active].label}` : ''}
      </p>
      <ol className="space-y-1" data-testid="pipeline-stepper">
        {STEP_IDS.map((id, i) => {
          const st = status[id];
          const info = STEP_INFO[id];
          return (
            <li key={id} data-step={id} data-status={st} className={cx('flex gap-3 rounded-lg px-3 py-2', st === 'active' && 'bg-brand-bg', st === 'error' && 'bg-block-bg')}>
              <span
                className={cx(
                  'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-bold',
                  st === 'done' && 'border-pass bg-pass text-white',
                  st === 'skipped' && 'border-line-strong bg-surface-2 text-ink-mute',
                  st === 'active' && 'border-brand bg-surface text-brand-ink',
                  st === 'error' && 'border-block bg-block text-white',
                  st === 'pending' && 'border-line-strong bg-surface text-ink-mute',
                )}
              >
                {st === 'done' ? <Check className="h-3.5 w-3.5" aria-hidden /> : st === 'skipped' ? <SkipForward className="h-3 w-3" aria-hidden /> : st === 'active' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : st === 'error' ? <CircleAlert className="h-3.5 w-3.5" aria-hidden /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className={cx('text-sm font-semibold', st === 'pending' ? 'text-ink-mute' : 'text-ink')}>{info.label}</span>
                  <span className="text-[11px] font-medium text-ink-mute">
                    {st === 'done' ? 'done' : st === 'skipped' ? 'already done' : st === 'active' ? 'working…' : st === 'error' ? 'failed' : 'waiting'}
                  </span>
                </span>
                {!compact && (
                  <span className="mt-0.5 block text-xs text-ink-mute">
                    {info.detail} <span className="font-semibold text-ink-mute">· {ACTOR_LABEL[info.actor]}</span>
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export const initialStatus = (): Record<StepId, StepStatus> => Object.fromEntries(STEP_IDS.map((s) => [s, 'pending'])) as Record<StepId, StepStatus>;
