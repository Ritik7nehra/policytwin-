import { withDerivedAmbiguities, type Policy } from './../policy/schema';
import { policyToText } from '../policy/text';
import type { PairResult } from '../types';

export interface RepairChange {
  field: string;
  from: string;
  to: string;
  reason: string;
}

export interface RepairProposal {
  policy: Policy;
  source_text: string;
  changes: RepairChange[];
  rationale: string;
  generated_by: 'deterministic' | 'llm';
}

/**
 * Deterministic repair: fill every control the candidate left "unspecified" with the
 * conservative behaviour, keeping the business objective (action, threshold, currency,
 * condition) untouched. A human must approve the result, and the rerun must pass.
 */
export function repairPolicyDeterministic(candidate: Policy, results: PairResult[]): RepairProposal {
  const p: Policy = structuredClone(candidate);
  p.name = 'Version C (corrected)';
  const changes: RepairChange[] = [];
  const failedFor = (cat: string) => results.filter((r) => r.category === cat && r.severity !== 'none').map((r) => r.pair_id);
  const why = (cat: string, fallback: string) => {
    const ids = failedFor(cat);
    return ids.length ? `Pair ${ids.join(', ')} failed: ${fallback}` : fallback;
  };
  const set = <K extends keyof Policy>(label: string, key: K, value: Policy[K], reason: string) => {
    changes.push({ field: label, from: String(p[key]), to: String(value), reason });
    p[key] = value;
  };

  if (p.action === 'automatic_refund') {
    const ps = p.product_scope;
    if (ps.physical === 'unspecified') {
      changes.push({ field: 'product_scope.physical', from: 'unspecified', to: 'tracking_rule', reason: 'Keep the original objective: the tracking rule applies to physical goods.' });
      ps.physical = 'tracking_rule';
    }
    if (ps.digital === 'unspecified') {
      changes.push({ field: 'product_scope.digital', from: 'unspecified', to: 'evidence_rule', reason: why('product_type', 'tracking does not exist for digital goods; require delivery/access evidence and review when it is missing or conflicting.') });
      ps.digital = 'evidence_rule';
    }
    if (ps.service === 'unspecified') {
      changes.push({ field: 'product_scope.service', from: 'unspecified', to: 'evidence_rule', reason: 'Services have no shipment tracking either; apply the same evidence requirement.' });
      ps.service = 'evidence_rule';
    }
    if (p.currency !== null && p.currency_handling === 'unspecified') set('currency_handling', 'currency_handling', 'manual_review_other_currency', why('currency_variation', `the threshold is in ${p.currency} and no conversion rule exists, so other currencies go to review.`));
    if (p.dispute_handling === 'unspecified') set('dispute_handling', 'dispute_handling', 'manual_review_if_open_dispute', why('dispute_state', 'refunding while a dispute is open risks double recovery.'));
    if (p.retry_handling === 'unspecified') set('retry_handling', 'retry_handling', 'idempotent_stable_request_id', why('duplicate_request', 'a retried request must reuse one stable PayPal-Request-Id.'));
    if (p.duplicate_event_handling === 'unspecified') set('duplicate_event_handling', 'duplicate_event_handling', 'dedupe_by_event_id', why('duplicate_webhook', 'duplicate webhook deliveries must be ignored by event id.'));
  }

  const repaired = withDerivedAmbiguities(p);
  return {
    policy: repaired,
    source_text: policyToText(repaired),
    changes,
    rationale:
      'The original objective (automatic refunds up to the threshold when tracking is unavailable) is preserved. Each change fills a behaviour the proposed policy left unspecified, using the most conservative treatment: send the case to a human.',
    generated_by: 'deterministic',
  };
}
