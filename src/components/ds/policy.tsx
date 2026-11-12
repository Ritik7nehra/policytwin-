'use client';

import { AlertTriangle, ArrowRight, Check, Equal, FlaskConical, Minus, Plus, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Policy } from '@/lib/policy/schema';
import { CATEGORY_LABEL, ambiguityItems, diffPolicies, ruleRows, type DiffKind } from '@/lib/policy/view';
import { cx } from '@/lib/client';
import { Chip } from './badges';

/** Structured reading of a policy as a stack of rule rows. "Not specified" rows are flagged in words and icon, not colour alone. */
export function RuleBlock({ policy, testId, className }: { policy: Policy; testId?: string; className?: string }) {
  return (
    <dl data-testid={testId} className={cx('divide-y divide-line rounded-xl border border-line bg-surface', className)}>
      {ruleRows(policy).map((r) => (
        <div key={r.key} data-rule={r.key} data-unspecified={r.unspecified || undefined} className={cx('grid grid-cols-[8.5rem_1fr] items-start gap-3 px-3.5 py-2.5 text-sm sm:grid-cols-[10rem_1fr]', r.unspecified && 'bg-review-bg/60')}>
          <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-mute">{r.label}</dt>
          <dd className={cx('flex items-start gap-1.5 break-words', r.unspecified ? 'font-semibold text-review-ink' : 'text-ink')}>
            {r.unspecified && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-label="Policy is silent on this" />}
            <span>{r.value}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PolicyVersionPanel({ label, tone, title, text, policy, testIdText, testIdRules, footer }: { label: 'A' | 'B' | 'C'; tone: 'current' | 'proposed' | 'corrected'; title: string; text: string; policy: Policy | null; testIdText?: string; testIdRules?: string; footer?: ReactNode }) {
  const bar = tone === 'current' ? 'border-ink/30' : tone === 'proposed' ? 'border-brand' : 'border-pass';
  const bg = tone === 'current' ? 'bg-surface-2' : tone === 'proposed' ? 'bg-brand-bg/50' : 'bg-pass-bg/60';
  return (
    <section className="card p-5" aria-label={`${title}, Version ${label}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold">{title}</h2>
        <Chip tone={tone === 'proposed' ? 'info' : tone === 'corrected' ? 'good' : 'plain'}>Version {label}</Chip>
      </div>
      <blockquote data-testid={testIdText} className={cx('mb-4 rounded-lg border-l-4 px-4 py-3 text-sm leading-relaxed', bar, bg)}>
        {text}
      </blockquote>
      <h3 className="label">Structured reading</h3>
      {policy ? <RuleBlock policy={policy} testId={testIdRules} /> : <p className="text-sm text-ink-mute">Not read yet.</p>}
      {footer}
    </section>
  );
}

const KIND: Record<DiffKind, { icon: typeof Plus; cls: string; label: string }> = {
  changed: { icon: ArrowRight, cls: 'text-brand-ink', label: 'changed' },
  same: { icon: Equal, cls: 'text-ink-mute', label: 'unchanged' },
  newly_unspecified: { icon: AlertTriangle, cls: 'text-review-ink', label: 'new gap' },
  still_unspecified: { icon: Minus, cls: 'text-review-ink', label: 'still a gap' },
};

/** A→B field diff. Each row says what changed in words, so the meaning never relies on colour. */
export function PolicyDiff({ a, b, showSame = false, className }: { a: Policy; b: Policy; showSame?: boolean; className?: string }) {
  const rows = diffPolicies(a, b).filter((r) => showSame || r.kind !== 'same');
  const changed = rows.filter((r) => r.kind === 'changed').length;
  const gaps = rows.filter((r) => r.kind === 'newly_unspecified' || r.kind === 'still_unspecified').length;
  return (
    <div className={className} data-testid="policy-diff">
      <p className="mb-2 text-sm text-ink-mute" aria-live="polite">
        <b className="text-ink">{changed}</b> field{changed === 1 ? '' : 's'} changed · <b className="text-ink">{gaps}</b> behaviour{gaps === 1 ? '' : 's'} left unspecified
      </p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong p-3 text-sm text-ink-mute">The structured policies are identical.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const k = KIND[r.kind];
            return (
              <li key={r.key} data-diff={r.kind} className={cx('rounded-lg border px-3 py-2 text-sm', r.kind === 'changed' ? 'border-brand/30 bg-brand-bg/50' : r.kind === 'same' ? 'border-line bg-surface' : 'border-review/40 bg-review-bg/70')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-mute">{r.label}</span>
                  <span className={cx('inline-flex items-center gap-1 text-[11px] font-bold', k.cls)}>
                    <k.icon className="h-3 w-3" aria-hidden />
                    {k.label}
                  </span>
                </div>
                <p className="mt-1 break-words">
                  <span className="text-ink-mute line-through decoration-ink-mute/40">{r.from}</span> <ArrowRight className="mx-0.5 inline h-3 w-3 text-ink-mute" aria-label="becomes" /> <b>{r.to}</b>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** One ambiguity: what is unclear, why it matters, and which twin test will probe it. */
export function AmbiguityCards({ policy, testId = 'ambiguities' }: { policy: Policy; testId?: string }) {
  const items = ambiguityItems(policy);
  if (items.length === 0) return <p className="rounded-lg bg-pass-bg p-3 text-sm text-pass-ink"><Check className="mr-1.5 inline h-4 w-4" aria-hidden />No ambiguities detected in this reading.</p>;
  return (
    <ul data-testid={testId} className="grid gap-3 sm:grid-cols-2">
      {items.map((it) => (
        <li key={it.text} data-ambiguity={it.code ?? 'other'} className="rounded-xl border border-review/40 bg-review-bg/50 p-3.5">
          <p className="flex items-start gap-2 text-sm font-semibold text-review-ink">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{it.text}</span>
          </p>
          {it.meta && (
            <div className="mt-2 space-y-1.5 text-xs text-ink">
              <p>
                <b>Why it matters.</b> {it.meta.why}
              </p>
              <p className="flex items-start gap-1.5 text-ink-mute">
                <FlaskConical className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{it.meta.tested_by ? <>Probed by a <b className="text-ink">{CATEGORY_LABEL[it.meta.tested_by]}</b> twin. {it.meta.example}</> : it.meta.example}</span>
              </p>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
