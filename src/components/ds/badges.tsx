'use client';

import { ArrowRight, Bot, CircleAlert, CircleCheck, Cpu, FlaskConical, Scale, ShieldAlert, ShieldCheck, ShieldX, Sparkles, TriangleAlert, UserCheck, OctagonX } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RuntimeInfo } from '@/lib/types';
import { cx } from '@/lib/client';
import { Tip } from './overlays';

export type Verdict = 'PASS' | 'REVIEW' | 'BLOCK';
export type Severity = 'none' | 'medium' | 'high' | 'critical';

export const VERDICT_STYLE: Record<Verdict, { box: string; text: string; solid: string; Icon: typeof CircleCheck; note: string }> = {
  PASS: { box: 'border-pass bg-pass-bg', text: 'text-pass-ink', solid: 'bg-pass text-white', Icon: ShieldCheck, note: 'No blocking issue found in the scenarios tested' },
  REVIEW: { box: 'border-review bg-review-bg', text: 'text-review-ink', solid: 'bg-review-ink text-white', Icon: ShieldAlert, note: 'A human should look closely before release' },
  BLOCK: { box: 'border-block bg-block-bg', text: 'text-block-ink', solid: 'bg-block text-white', Icon: ShieldX, note: 'Do not release this policy as written' },
};

/** Verdict pill. Icon + word, never colour alone. `data-testid="verdict"` is kept for the e2e suite. */
export function VerdictBadge({ v, big }: { v: Verdict | null | undefined; big?: boolean }) {
  if (!v) return <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-ink-mute">not run</span>;
  const s = VERDICT_STYLE[v];
  return (
    <span data-testid="verdict" className={cx('inline-flex items-center gap-1.5 rounded-full border font-bold tracking-wide', s.box, s.text, big ? 'px-4 py-1.5 text-xl' : 'px-2.5 py-0.5 text-xs')}>
      <s.Icon className={big ? 'h-5 w-5' : 'h-3.5 w-3.5'} aria-hidden />
      {v}
    </span>
  );
}

const SEV: Record<Severity, { cls: string; Icon: typeof CircleCheck; label: string }> = {
  none: { cls: 'bg-pass-bg text-pass-ink', Icon: CircleCheck, label: 'none' },
  medium: { cls: 'bg-review-bg text-review-ink', Icon: CircleAlert, label: 'medium' },
  high: { cls: 'bg-[#FDE7D3] text-[#8A3B00]', Icon: TriangleAlert, label: 'high' },
  critical: { cls: 'bg-block-bg text-block-ink', Icon: OctagonX, label: 'critical' },
};
export function SeverityBadge({ s }: { s: Severity }) {
  const x = SEV[s];
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', x.cls)}>
      <x.Icon className="h-3 w-3" aria-hidden />
      {x.label}
    </span>
  );
}

export type ChipTone = 'plain' | 'warn' | 'info' | 'good' | 'bad' | 'navy' | 'twin';
const CHIP: Record<ChipTone, string> = {
  plain: 'border-line-strong bg-surface text-ink',
  warn: 'border-review/40 bg-review-bg text-review-ink',
  info: 'border-brand/30 bg-brand-bg text-brand-ink',
  good: 'border-pass/30 bg-pass-bg text-pass-ink',
  bad: 'border-block/30 bg-block-bg text-block-ink',
  navy: 'border-navy bg-navy text-white',
  twin: 'border-twin/40 bg-twin-bg text-twin-ink',
};
export function Chip({ children, tone = 'plain', mono, icon, className }: { children: ReactNode; tone?: ChipTone; mono?: boolean; icon?: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium', CHIP[tone], mono && 'font-mono text-[11px]', className)}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Where a piece of evidence came from. The six provenance kinds the product distinguishes everywhere. */
export type Provenance = 'sandbox' | 'simulated' | 'deterministic' | 'ai' | 'synthetic' | 'human';
const PROV: Record<Provenance, { label: string; cls: string; Icon: typeof Cpu; tip: string }> = {
  sandbox: { label: 'PAYPAL SANDBOX', cls: 'border-pass/40 bg-pass-bg text-pass-ink', Icon: ShieldCheck, tip: 'Real PayPal Sandbox API calls with test money. Resource IDs come from PayPal.' },
  simulated: { label: 'SIMULATED', cls: 'border-review/40 bg-review-bg text-review-ink', Icon: Cpu, tip: 'An in-process model of PayPal’s documented behaviour. Not PayPal.' },
  deterministic: { label: 'DETERMINISTIC', cls: 'border-navy/25 bg-surface-2 text-navy', Icon: Scale, tip: 'Computed by ordinary code with fixed rules — repeatable, no model involved.' },
  ai: { label: 'AI-GENERATED', cls: 'border-twin/40 bg-twin-bg text-twin-ink', Icon: Sparkles, tip: 'Proposed by a language model, then validated by code. Never a verdict.' },
  synthetic: { label: 'SYNTHETIC IMPACT', cls: 'border-review/40 bg-review-bg text-review-ink', Icon: FlaskConical, tip: 'Invented illustrative figures. Not PayPal data.' },
  human: { label: 'HUMAN DECISION', cls: 'border-navy bg-navy text-white', Icon: UserCheck, tip: 'Recorded by a signed-in person. PolicyTwin only recommends.' },
};
export function ProvenanceBadge({ kind, compact }: { kind: Provenance; compact?: boolean }) {
  const p = PROV[kind];
  return (
    <Tip label={p.tip}>
      <span tabIndex={0} data-provenance={kind} className={cx('inline-flex cursor-help items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono font-semibold tracking-wide', p.cls, compact ? 'text-[10px]' : 'text-[11px]')}>
        <p.Icon className="h-3 w-3" aria-hidden />
        {p.label}
      </span>
    </Tip>
  );
}

/** Top-bar environment badge. States the truth: Sandbox only if real Sandbox credentials are configured. */
export function EnvironmentBadge({ runtime }: { runtime: RuntimeInfo | null }) {
  const sandbox = runtime?.lane2_mode === 'sandbox';
  return (
    <Tip
      label={
        sandbox
          ? 'PayPal Sandbox credentials are configured: “Verify in PayPal Sandbox” makes real Sandbox calls with test money. The full shadow run always uses the simulator.'
          : 'No PayPal Sandbox credentials are configured, so every payment operation uses the in-process simulator (not PayPal).'
      }
    >
      <span tabIndex={0} data-testid="env-badge" className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] font-semibold sm:px-2.5 sm:text-xs', sandbox ? 'border-pass/40 bg-pass-bg text-pass-ink' : 'border-review/40 bg-review-bg text-review-ink')}>
        <span className={cx('h-1.5 w-1.5 rounded-full', sandbox ? 'bg-pass' : 'bg-review')} aria-hidden />
        {runtime ? (
          sandbox ? (
            'PayPal Sandbox'
          ) : (
            <>
              <span className="sm:hidden">Simulated</span>
              <span className="hidden sm:inline">Simulated · not PayPal</span>
            </>
          )
        ) : (
          'Checking…'
        )}
      </span>
    </Tip>
  );
}

export function RuntimeBadge({ runtime }: { runtime: RuntimeInfo | null }) {
  const ai = runtime?.ai_mode === 'openai';
  return (
    <Tip label={ai ? 'A language model proposes policy readings, twins and explanations. Code validates every output; on any doubt the deterministic fallback is used.' : 'No OpenAI key is configured: every agent runs its deterministic implementation.'}>
      <span tabIndex={0} data-testid="ai-badge" className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-2.5 py-1 text-xs font-semibold text-ink">
        <Bot className="h-3.5 w-3.5 text-twin-ink" aria-hidden />
        {runtime ? (ai ? `AI: ${runtime.ai_model}` : 'AI: deterministic') : 'AI…'}
      </span>
    </Tip>
  );
}

export function VerifierBadge() {
  return (
    <Tip label="Release verdicts and financial invariants are computed by deterministic code. A model never decides PASS, REVIEW or BLOCK.">
      <span tabIndex={0} className="hidden items-center gap-1.5 rounded-full border border-navy/20 bg-surface-2 px-2.5 py-1 text-xs font-semibold text-navy xl:inline-flex">
        <Scale className="h-3.5 w-3.5" aria-hidden />
        Deterministic verifier
      </span>
    </Tip>
  );
}

export const DECISION_LABEL: Record<string, string> = { AUTO_REFUND: 'REFUND', REVIEW: 'REVIEW' };

function DecisionPill({ d, compact }: { d: string; compact?: boolean }) {
  const refund = d === 'AUTO_REFUND';
  return <span className={cx('rounded-md font-mono font-bold', compact ? 'px-1 py-px text-[10px]' : 'px-1.5 py-0.5 text-[11px]', refund ? 'bg-brand-bg text-brand-ink' : 'bg-surface-2 text-ink')}>{DECISION_LABEL[d] ?? d}</span>;
}

/** REVIEW → REFUND, REFUND → REVIEW, REFUND → REFUND. Words + arrow + a "changed" marker: never colour alone. */
export function DecisionTransition({ from, to, label, compact }: { from: string; to: string; label?: string; compact?: boolean }) {
  const changed = from !== to;
  const text = `${DECISION_LABEL[from] ?? from} to ${DECISION_LABEL[to] ?? to}${changed ? ' (changed)' : ' (unchanged)'}`;
  return (
    <span className={cx('inline-flex items-center', compact ? 'gap-1' : 'gap-1.5')} aria-label={label ? `${label}: ${text}` : text} title={text}>
      <DecisionPill d={from} compact={compact} />
      <ArrowRight className={cx(compact ? 'h-3 w-3' : 'h-3.5 w-3.5', changed ? 'text-brand' : 'text-ink-mute')} aria-hidden />
      <DecisionPill d={to} compact={compact} />
      {changed && <span className="rounded bg-brand-ink px-1 text-[9px] font-bold uppercase tracking-wide text-white">changed</span>}
    </span>
  );
}
