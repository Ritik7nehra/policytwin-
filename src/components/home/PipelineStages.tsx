'use client';

import { Bot, CheckCheck, Cpu, FileSearch, Scale, UserCheck, Users, type LucideIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { cx } from '@/lib/client';
import { ProvenanceBadge, type Provenance } from '../ds/badges';

interface Stage {
  id: string;
  title: string;
  actor: string;
  prov: Provenance;
  icon: LucideIcon;
  body: string;
  guard: string;
}

const STAGES: Stage[] = [
  { id: 'read', title: 'Read the policy', actor: 'AI proposes', prov: 'ai', icon: FileSearch, body: 'The Policy Reader turns plain-English text into a structured rule: trigger, action, threshold and what it says about products, currencies, disputes, retries and duplicate webhooks.', guard: 'The output must validate against a strict schema. Gaps the code can see cannot be hidden by the model. The text itself is never executed.' },
  { id: 'twins', title: 'Generate twins', actor: 'AI proposes · code validates', prov: 'ai', icon: Users, body: 'Matched transaction pairs that differ in exactly one field — product type, amount, currency, dispute, retry, duplicate webhook — plus adversarial boundary cases.', guard: 'Code rejects any pair that changes more than one field, and code — not the model — decides whether the outcome should change.' },
  { id: 'decide', title: 'Decide', actor: 'Code', prov: 'deterministic', icon: Scale, body: 'A deterministic engine applies the current and the proposed policy to every scenario. Where a policy is silent, it applies the rule literally and raises a flag.', guard: 'No model, no randomness, no I/O: the same input always gives the same decision.' },
  { id: 'execute', title: 'Execute', actor: 'Simulator · Sandbox on request', prov: 'simulated', icon: Cpu, body: 'Every scenario runs create → capture → refund → webhooks on an in-process simulator of PayPal’s documented behaviour. One pair at a time can be re-run in the real PayPal Sandbox when credentials exist.', guard: 'The full run never touches PayPal. The Sandbox lane is opt-in, pair by pair, and never changes the verdict on its own.' },
  { id: 'verify', title: 'Verify', actor: 'Code', prov: 'deterministic', icon: CheckCheck, body: 'Eight financial invariants are checked on the recorded money movements: total refunds ≤ capture, one refund per logical request, matching currency and payee, no capture after void, no duplicate side effects, no state regression, no auto-refund during a dispute.', guard: 'Deterministic code computes PASS, REVIEW or BLOCK. A model never grades itself.' },
  { id: 'human', title: 'Human decides', actor: 'Human', prov: 'human', icon: UserCheck, body: 'The recommendation is not an approval. A BLOCK cannot be approved; a REVIEW needs a written reason; a PASS still waits for a person.', guard: 'Your decision is recorded with a server-derived name and a timestamp.' },
];

/** Six-stage pipeline. A tablist so it is usable by keyboard (←/→) and announces the selected stage. */
export default function PipelineStages() {
  const [i, setI] = useState(0);
  const uid = useId();
  const s = STAGES[i];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') setI((x) => (x + 1) % STAGES.length);
    else if (e.key === 'ArrowLeft') setI((x) => (x + STAGES.length - 1) % STAGES.length);
    else if (e.key === 'Home') setI(0);
    else if (e.key === 'End') setI(STAGES.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <section aria-labelledby={`${uid}-h`} className="card p-5" data-testid="pipeline-stages">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${uid}-h`} className="font-display text-xl font-bold">How a policy change is tested</h2>
        <p className="text-xs font-semibold text-ink-mute">AI proposes → Code validates → Sandbox executes → Code verifies → Human decides</p>
      </div>
      <div role="tablist" aria-label="Pipeline stages" onKeyDown={onKey} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {STAGES.map((st, idx) => (
          <button
            key={st.id}
            id={`${uid}-t-${st.id}`}
            role="tab"
            type="button"
            aria-selected={idx === i}
            aria-controls={`${uid}-p`}
            tabIndex={idx === i ? 0 : -1}
            onClick={() => setI(idx)}
            data-testid={`stage-${st.id}`}
            className={cx('relative rounded-xl border p-3 text-left transition', idx === i ? 'border-brand bg-brand-bg shadow-card' : 'border-line bg-surface hover:border-brand/50')}
          >
            <span className="mb-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-mute">
              <span className={cx('grid h-5 w-5 place-items-center rounded-full text-[10px]', idx <= i ? 'bg-brand text-white' : 'bg-surface-2 text-ink-mute')}>{idx + 1}</span>
              {st.actor.split(' · ')[0]}
            </span>
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <st.icon className="h-4 w-4 text-brand-ink" aria-hidden />
              {st.title}
            </span>
          </button>
        ))}
      </div>
      <div id={`${uid}-p`} role="tabpanel" aria-labelledby={`${uid}-t-${s.id}`} tabIndex={0} className="mt-4 grid gap-4 rounded-xl bg-surface-2 p-4 md:grid-cols-[1fr_1fr]">
        <div>
          <p className="mb-1 flex flex-wrap items-center gap-2 font-display text-base font-bold">
            {s.title} <ProvenanceBadge kind={s.prov} />
          </p>
          <p className="text-sm text-ink">{s.body}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3 text-sm">
          <p className="label !mb-1 flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5" aria-hidden /> Guardrail
          </p>
          <p>{s.guard}</p>
        </div>
      </div>
    </section>
  );
}
