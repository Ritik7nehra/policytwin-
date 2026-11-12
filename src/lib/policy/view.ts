import type { Policy, AmbiguityCode } from './schema';
import { AMBIGUITY_CODES, AMBIGUITY_TEXT } from './schema';
import type { TestCategory } from '../types';

/** Pure view-model helpers for policies. No Node-only imports: safe in the browser (wizard live preview). */

const SCOPE_LABEL: Record<string, string> = {
  tracking_rule: 'Tracking rule applies',
  evidence_rule: 'Delivery / access evidence required',
  manual_review: 'Manual review',
  unspecified: 'Not specified',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const humanize = (s: string) => cap(s.replace(/_/g, ' '));

export interface RuleRow {
  key: string;
  label: string;
  value: string;
  /** The policy text is silent on this behaviour — exactly what PolicyTwin exists to surface. */
  unspecified: boolean;
}

export function ruleRows(p: Policy): RuleRow[] {
  const auto = p.action === 'automatic_refund';
  const threshold = p.maximum_amount === null ? (auto ? 'No amount limit' : '—') : `${p.threshold_inclusive ? '≤' : '<'} ${p.maximum_amount.toFixed(2)} ${p.currency ?? ''}`.trim();
  const rows: RuleRow[] = [
    { key: 'trigger', label: 'Trigger', value: p.trigger === 'missing_delivery_claim' ? 'Missing-delivery claim' : `${humanize(p.trigger)} (not executable here)`, unspecified: p.trigger !== 'missing_delivery_claim' },
    { key: 'action', label: 'Action', value: auto ? 'Automatic refund' : 'Manual review', unspecified: false },
    { key: 'threshold', label: 'Amount threshold', value: threshold, unspecified: false },
    { key: 'condition', label: 'Condition', value: p.condition === 'tracking_unavailable' ? 'Tracking unavailable' : auto ? 'Always — no evidence condition' : 'Always', unspecified: auto && p.condition === 'always' },
  ];
  if (auto) {
    const u = (v: string) => v === 'unspecified';
    rows.push(
      { key: 'physical', label: 'Physical goods', value: SCOPE_LABEL[p.product_scope.physical], unspecified: u(p.product_scope.physical) },
      { key: 'digital', label: 'Digital goods', value: SCOPE_LABEL[p.product_scope.digital], unspecified: u(p.product_scope.digital) },
      { key: 'service', label: 'Services', value: SCOPE_LABEL[p.product_scope.service], unspecified: u(p.product_scope.service) },
      { key: 'currency', label: 'Other currencies', value: u(p.currency_handling) ? 'Not specified' : humanize(p.currency_handling), unspecified: u(p.currency_handling) },
      { key: 'dispute', label: 'Open dispute', value: u(p.dispute_handling) ? 'Not specified' : humanize(p.dispute_handling), unspecified: u(p.dispute_handling) },
      { key: 'retry', label: 'Retried requests', value: u(p.retry_handling) ? 'Not specified' : humanize(p.retry_handling), unspecified: u(p.retry_handling) },
      { key: 'duplicate', label: 'Duplicate webhooks', value: u(p.duplicate_event_handling) ? 'Not specified' : humanize(p.duplicate_event_handling), unspecified: u(p.duplicate_event_handling) },
    );
  }
  rows.push({ key: 'exceptions', label: 'Exceptions', value: p.exceptions.length ? p.exceptions.join(' · ') : 'None stated', unspecified: false });
  return rows;
}

export type DiffKind = 'changed' | 'same' | 'newly_unspecified' | 'still_unspecified';
export interface DiffRow {
  key: string;
  label: string;
  from: string;
  to: string;
  kind: DiffKind;
}

/** Field-by-field comparison of two structured policies. "newly_unspecified" = the change introduced a gap. */
export function diffPolicies(a: Policy, b: Policy): DiffRow[] {
  const ra = new Map(ruleRows(a).map((r) => [r.key, r]));
  const out: DiffRow[] = [];
  for (const rb of ruleRows(b)) {
    const r = ra.get(rb.key);
    const from = r?.value ?? '— (not applicable)';
    let kind: DiffKind;
    if (!rb.unspecified) kind = from === rb.value ? 'same' : 'changed';
    else kind = r?.unspecified ? 'still_unspecified' : 'newly_unspecified'; // a row absent from A (manual review) is a gap B introduced
    out.push({ key: rb.key, label: rb.label, from, to: rb.value, kind });
  }
  return out;
}

export const CATEGORY_LABEL: Record<TestCategory, string> = {
  amount_boundary: 'Amount boundary',
  product_type: 'Product type',
  currency_variation: 'Currency variation',
  duplicate_request: 'Duplicate request',
  dispute_state: 'Dispute state',
  duplicate_webhook: 'Duplicate webhook',
  evidence_status: 'Evidence status',
  customer_history: 'Customer history',
  void_authorization: 'Void authorization',
};

export interface AmbiguityMeta {
  title: string;
  why: string;
  example: string;
  tested_by: TestCategory | null;
}
export const AMBIGUITY_META: Record<AmbiguityCode, AmbiguityMeta> = {
  PRODUCT_SCOPE: { title: 'Physical vs digital goods', why: 'A tracking rule only makes sense for shipped goods. Applied literally, it refunds digital items that never had tracking.', example: 'Same $40 order, once as a shipped item, once as a download.', tested_by: 'product_type' },
  SERVICE_EVIDENCE: { title: 'Evidence for services', why: 'No rule says what proves a service was not delivered, so the engine cannot tell a valid claim from an invalid one.', example: 'Same $40 order as a service booking with no delivery evidence.', tested_by: 'product_type' },
  CURRENCY_CONVERSION: { title: 'Currency conversion', why: 'A threshold in one currency means a different amount of money in another. Without a rule, 50 EUR is compared to 50 USD.', example: 'Same $40-equivalent order in EUR instead of USD.', tested_by: 'currency_variation' },
  DISPUTE_STATE: { title: 'Open disputes', why: 'Refunding automatically while a dispute is open can pay the customer twice.', example: 'Same order with and without an open dispute.', tested_by: 'dispute_state' },
  RETRY_BEHAVIOR: { title: 'Retried refund requests', why: 'Networks retry. Without a stable request id the retry can refund the same claim twice.', example: 'Same claim sent once, then sent twice.', tested_by: 'duplicate_request' },
  DUPLICATE_EVENTS: { title: 'Duplicate webhooks', why: 'Webhooks are delivered at least once. A handler that is not idempotent can act on the same event twice.', example: 'Same claim event delivered once, then twice.', tested_by: 'duplicate_webhook' },
  THRESHOLD_BOUNDARY: { title: 'Is the threshold included?', why: '“Under $50” and “$50 or less” differ by exactly one amount: $50.00.', example: 'Orders of 50.00 and 50.01.', tested_by: 'amount_boundary' },
  UNSUPPORTED_TRIGGER: { title: 'Unsupported trigger', why: 'This prototype can only execute missing-delivery claims, so this policy cannot be fully tested.', example: 'None — the release gate will not return PASS.', tested_by: null },
  NO_CONDITION: { title: 'No evidence condition', why: 'Refunds happen without any check that the claim is plausible.', example: 'Same order with delivery evidence missing vs confirming non-delivery.', tested_by: 'evidence_status' },
  UNMODELED_EXCEPTION: { title: 'Exception PolicyTwin cannot test', why: 'A stated exception that cannot be executed is never silently treated as tested; it prevents PASS.', example: 'None — a human must review this exception.', tested_by: null },
};

export interface AmbiguityItem {
  code: AmbiguityCode | null;
  text: string;
  meta: AmbiguityMeta | null;
}
/** Pair stored ambiguity strings with their code-derived metadata; extra model-found text keeps `code: null`. */
export function ambiguityItems(p: Policy): AmbiguityItem[] {
  const byText = new Map(AMBIGUITY_CODES.map((c) => [AMBIGUITY_TEXT[c], c] as const));
  return p.ambiguities.map((text) => {
    const code = byText.get(text) ?? null;
    return { code, text, meta: code ? AMBIGUITY_META[code] : null };
  });
}
