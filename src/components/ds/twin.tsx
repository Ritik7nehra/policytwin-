'use client';

import { CheckCircle2, ChevronDown, CircleSlash, MinusCircle, XCircle } from 'lucide-react';
import type { ExecutionRecord, TxInput } from '@/lib/types';
import type { InvariantRow } from '@/lib/store/types';
import { TX_FIELDS } from '@/lib/types';
import { cx } from '@/lib/client';
import { Chip, ProvenanceBadge } from './badges';
import { CopyButton, JsonBlock } from './Card';

const LABEL: Record<string, string> = {
  amount: 'Amount',
  currency: 'Currency',
  product_type: 'Product type',
  tracking_available: 'Tracking',
  evidence_status: 'Evidence',
  dispute_state: 'Dispute',
  customer_history: 'Customer',
  claimed_amount: 'Claimed amount',
  request_attempts: 'Refund requests sent',
  webhook_deliveries: 'Webhook deliveries',
  payment_flow: 'Payment flow',
};
const fmt = (k: string, v: unknown) => (k === 'tracking_available' ? (v ? 'available' : 'unavailable') : v === null ? 'full amount' : String(v).replace(/_/g, ' '));

/** One synthetic transaction. In a twin pair, the single changed field is marked in words as well as colour. */
export function TransactionTwinCard({ title, tx, changed, other, testId }: { title: string; tx: TxInput; changed: string; other?: TxInput; testId?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-3.5" data-testid={testId}>
      <p className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">
        {title}
        <span className="font-mono text-[10px] font-medium normal-case tracking-normal">synthetic</span>
      </p>
      <dl className="space-y-0.5">
        {TX_FIELDS.map((k) => {
          const diff = other ? other[k] !== tx[k] : false;
          const hit = k === changed && diff;
          return (
            <div key={k} data-field={k} data-changed={hit || undefined} className={cx('flex items-center justify-between gap-3 rounded-md px-2 py-1 text-sm', hit && 'bg-twin-bg font-semibold text-twin-ink ring-1 ring-twin/50')}>
              <dt className={cx('text-xs', hit ? 'text-twin-ink' : 'text-ink-mute')}>{LABEL[k] ?? k}</dt>
              <dd className="flex items-center justify-end gap-1.5 text-right font-mono text-[12.5px]">
                {hit && <span className="rounded bg-twin-ink px-1 text-[9px] font-bold uppercase tracking-wide text-white">changed</span>}
                {fmt(k, tx[k])}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

const STATUS_STYLE: Record<ExecutionRecord['status'], { Icon: typeof CheckCircle2; cls: string; label: string }> = {
  SUCCESS: { Icon: CheckCircle2, cls: 'text-pass-ink', label: 'success' },
  REPLAYED: { Icon: CheckCircle2, cls: 'text-brand-ink', label: 'replayed (same request id)' },
  FAILED: { Icon: XCircle, cls: 'text-block-ink', label: 'failed' },
  SKIPPED: { Icon: CircleSlash, cls: 'text-ink-mute', label: 'skipped' },
  INFO: { Icon: MinusCircle, cls: 'text-ink-mute', label: 'info' },
};

/** Chronological record of every payment operation, with the exact (sanitized) request and response. */
export function EvidenceTimeline({ events, empty = 'No payment operations were recorded.' }: { events: ExecutionRecord[]; empty?: string }) {
  if (events.length === 0) return <p className="rounded-lg border border-dashed border-line-strong p-3 text-sm text-ink-mute">{empty}</p>;
  return (
    <ol className="relative space-y-2 border-l-2 border-line pl-4" data-testid="evidence-timeline">
      {events.map((e, i) => {
        const s = STATUS_STYLE[e.status];
        return (
          <li key={e.id} className="relative" data-operation={e.operation} data-status={e.status}>
            <span className="absolute -left-[1.4rem] top-3 grid h-4 w-4 place-items-center rounded-full bg-surface" aria-hidden>
              <s.Icon className={cx('h-4 w-4', s.cls)} />
            </span>
            <details className="group rounded-lg border border-line bg-surface">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
                <span className="w-5 shrink-0 text-ink-mute">{i + 1}.</span>
                <span className="font-mono text-[13px] font-semibold">{e.operation}</span>
                <span className={cx('font-semibold', s.cls)}>{s.label}</span>
                {e.http_status !== null && <span className="text-ink-mute">HTTP {e.http_status}</span>}
                <ProvenanceBadge kind={e.mode} compact />
                {e.lane === 'sandbox_proof' && <Chip tone="info">Lane 2 proof</Chip>}
                {e.request_id && <span className="font-mono text-[11px] text-ink-mute">{e.request_id}</span>}
                <ChevronDown className="ml-auto h-4 w-4 text-ink-mute transition group-open:rotate-180" aria-hidden />
              </summary>
              <div className="space-y-2 border-t border-line p-3">
                {e.note && <p className="text-xs text-ink">{e.note}</p>}
                <dl className="grid grid-cols-[6rem_1fr] gap-y-1 font-mono text-[11px]">
                  {e.paypal_order_id && (<><dt className="text-ink-mute">order</dt><dd className="break-all">{e.paypal_order_id}</dd></>)}
                  {e.paypal_capture_id && (<><dt className="text-ink-mute">capture</dt><dd className="break-all">{e.paypal_capture_id}</dd></>)}
                  {e.paypal_refund_id && (<><dt className="text-ink-mute">refund</dt><dd className="break-all">{e.paypal_refund_id}</dd></>)}
                </dl>
                {e.request_json != null && (<><div className="label !mb-1">Request</div><JsonBlock value={e.request_json} /></>)}
                {e.response_json != null && (<><div className="label !mb-1">Response</div><JsonBlock value={e.response_json} /></>)}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

/** Invariant results grouped by outcome: failures first, then passes, then not-applicable. Deterministic code decides all of these. */
export function InvariantResult({ rows }: { rows: { row: InvariantRow; who: string }[] }) {
  const group = (f: (r: InvariantRow) => boolean) => rows.filter(({ row }) => f(row));
  const failed = group((r) => r.evidence_json.applicable && !r.passed);
  const passed = group((r) => r.evidence_json.applicable && r.passed);
  const na = group((r) => !r.evidence_json.applicable);
  const section = (title: string, items: typeof rows, tone: 'bad' | 'good' | 'mute') =>
    items.length === 0 ? null : (
      <tbody key={title}>
        <tr>
          <th colSpan={4} className={cx('px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-[0.08em]', tone === 'bad' ? 'bg-block-bg text-block-ink' : tone === 'good' ? 'bg-pass-bg text-pass-ink' : 'bg-surface-2 text-ink-mute')}>
            {title} ({items.length})
          </th>
        </tr>
        {items.map(({ row, who }) => (
          <tr key={row.id} data-invariant={row.invariant_code} data-result={!row.evidence_json.applicable ? 'na' : row.passed ? 'passed' : 'failed'} className="border-b border-line align-top">
            <td className="px-3 py-2"><div className="font-mono text-xs font-semibold">{row.invariant_code}</div><div className="text-xs text-ink-mute">{row.evidence_json.name}</div></td>
            <td className="px-3 py-2 text-xs">{who}</td>
            <td className="px-3 py-2">{!row.evidence_json.applicable ? <Chip>not applicable</Chip> : row.passed ? <Chip tone="good">passed</Chip> : <Chip tone="bad">FAILED</Chip>}</td>
            <td className="px-3 py-2 text-xs">{row.evidence_json.detail}</td>
          </tr>
        ))}
      </tbody>
    );
  return (
    <div className="overflow-x-auto rounded-xl border border-line" tabIndex={0} role="region" aria-label="Invariant results table (scrolls sideways on narrow screens)">
      <table className="w-full min-w-[34rem] text-left text-sm" data-testid="invariants">
        <caption className="sr-only">Financial invariants checked by deterministic code</caption>
        <thead>
          <tr className="border-b border-line bg-surface-2 text-xs uppercase tracking-wide text-ink-mute">
            <th className="px-3 py-2">Invariant</th><th className="px-3 py-2">Scenario</th><th className="px-3 py-2">Result</th><th className="px-3 py-2">Evidence</th>
          </tr>
        </thead>
        {section('Failed', failed, 'bad')}
        {section('Passed', passed, 'good')}
        {section('Not applicable', na, 'mute')}
      </table>
    </div>
  );
}

export function IdRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-ink-mute">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 font-mono text-[11px]"><span className="truncate">{value ?? '—'}</span>{value && <CopyButton text={value} label="Copy" className="!min-h-6 !px-1 !py-0" />}</dd>
    </div>
  );
}
