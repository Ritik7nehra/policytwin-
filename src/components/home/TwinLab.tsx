'use client';

import { ArrowRight, FlaskConical } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { evaluatePolicy } from '@/lib/policy/engine';
import { readPolicyOffline } from '@/lib/policy/reader';
import { manualReviewPolicy } from '@/lib/policy/schema';
import { baseTx } from '@/lib/twins/generator';
import { CAUSAL_CATALOG } from '@/lib/twins/catalog';
import type { CausalField, TxInput } from '@/lib/types';
import { cx } from '@/lib/client';
import { DecisionTransition } from '../ds/badges';

const FIELDS: { id: CausalField; label: string; apply: (b: TxInput) => Partial<TxInput>; from: string; to: string }[] = [
  { id: 'product_type', label: 'Product type', apply: () => ({ product_type: 'digital' }), from: 'physical', to: 'digital' },
  { id: 'amount', label: 'Amount', apply: () => ({ amount: '50.01' }), from: '40.00', to: '50.01' },
  { id: 'currency', label: 'Currency', apply: () => ({ currency: 'EUR' }), from: 'USD', to: 'EUR' },
  { id: 'dispute_state', label: 'Open dispute', apply: () => ({ dispute_state: 'open' }), from: 'none', to: 'open' },
];

const TX_LINES: { key: keyof TxInput; label: string; fmt?: (v: unknown) => string }[] = [
  { key: 'amount', label: 'Amount' },
  { key: 'currency', label: 'Currency' },
  { key: 'product_type', label: 'Product' },
  { key: 'dispute_state', label: 'Dispute' },
  { key: 'tracking_available', label: 'Tracking', fmt: (v) => (v ? 'available' : 'unavailable') },
];

function TxCard({ title, tx, changed, sideLabel }: { title: string; tx: TxInput; changed: CausalField; sideLabel: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-line bg-surface p-3.5 shadow-card" data-testid={`twin-${sideLabel}`}>
      <p className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">
        {title}
        <span className="font-mono text-[10px] font-medium normal-case tracking-normal">synthetic</span>
      </p>
      <dl className="space-y-1">
        {TX_LINES.map((l) => {
          const hit = l.key === changed;
          return (
            <div key={l.key} className={cx('flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm', hit && sideLabel === 'twin' ? 'bg-twin-bg font-semibold text-twin-ink ring-1 ring-twin/50' : '')}>
              <dt className="text-ink-mute">{l.label}</dt>
              <dd className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[13px]">
                {hit && sideLabel === 'twin' && <span className="rounded bg-twin-ink px-1 text-[9px] font-bold uppercase tracking-wide text-white">changed</span>}
                {l.fmt ? l.fmt(tx[l.key]) : String(tx[l.key])}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/**
 * The product idea in one interaction. Pick ONE field to change; the real deterministic engine (the same code that runs
 * on the server) decides the original and the twin under the current and the proposed fictional policy.
 */
export default function TwinLab() {
  const [field, setField] = useState<CausalField>('product_type');
  const { a, b, base } = useMemo(() => {
    const A = manualReviewPolicy('Current');
    const B = readPolicyOffline(DEMO_POLICY_INPUT.proposed_policy, 'Proposed', `${DEMO_POLICY_INPUT.name} ${DEMO_POLICY_INPUT.current_policy}`);
    return { a: A, b: B, base: baseTx(B) };
  }, []);
  const f = FIELDS.find((x) => x.id === field)!;
  const twin: TxInput = { ...base, ...f.apply(base) };
  const dA0 = evaluatePolicy(a, base).decision;
  const dA1 = evaluatePolicy(a, twin).decision;
  const dB0 = evaluatePolicy(b, base).decision;
  const dB1 = evaluatePolicy(b, twin).decision;
  const expect = CAUSAL_CATALOG[field].expectation;
  const differs = dB0 !== dB1;
  const ok = (expect === 'must_differ') === differs;
  const msg = ok
    ? differs
      ? 'The decision changed because of this field — as it should.'
      : 'The decision did not change — as it should.'
    : expect === 'must_differ'
      ? 'The decision did not change, but this field should matter. The proposed policy is silent here.'
      : 'The decision changed, but this field should not matter.';

  return (
    <section className="card overflow-hidden" aria-labelledby="twin-lab-title" data-testid="twin-lab">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-navy px-4 py-3 text-white">
        <h2 id="twin-lab-title" className="flex items-center gap-2 font-display text-base font-bold text-white">
          <FlaskConical className="h-4 w-4 text-twin" aria-hidden />
          Transaction twin lab
        </h2>
        <span className="text-[11px] font-semibold text-white/80">Live: deterministic engine · fictional policy · not PayPal data</span>
      </div>
      <div className="space-y-4 p-4">
        <div>
          <p id="twin-pick" className="label">Change exactly one field</p>
          <div role="radiogroup" aria-labelledby="twin-pick" className="flex flex-wrap gap-2">
            {FIELDS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={x.id === field}
                data-testid={`twin-field-${x.id}`}
                onClick={() => setField(x.id)}
                className={cx('rounded-full border px-3 py-1.5 text-sm font-semibold transition', x.id === field ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface hover:border-brand/60 hover:bg-brand-bg')}
              >
                {x.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          <TxCard title="Original" tx={base} changed={field} sideLabel="original" />
          <div className="flex items-center justify-center text-twin-ink" aria-hidden>
            <ArrowRight className="hidden h-5 w-5 sm:block" />
            <span className="sm:hidden">↓</span>
          </div>
          <TxCard title="Twin" tx={twin} changed={field} sideLabel="twin" />
        </div>
        <div className="grid gap-2 rounded-xl bg-surface-2 p-3 text-sm sm:grid-cols-2">
          <div>
            <p className="label !mb-1">Current policy (A)</p>
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-mute">original → twin</span> <DecisionTransition from={dA0} to={dA1} label="Current policy" />
            </p>
          </div>
          <div>
            <p className="label !mb-1">Proposed policy (B)</p>
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-mute">original → twin</span> <DecisionTransition from={dB0} to={dB1} label="Proposed policy" />
            </p>
          </div>
        </div>
        <p role="status" data-testid="twin-lab-result" data-ok={ok} className={cx('rounded-lg border px-3 py-2 text-sm font-semibold', ok ? 'border-pass/30 bg-pass-bg text-pass-ink' : 'border-review/40 bg-review-bg text-review-ink')}>
          {ok ? 'As expected. ' : 'Flagged. '}
          {msg}
        </p>
      </div>
    </section>
  );
}
