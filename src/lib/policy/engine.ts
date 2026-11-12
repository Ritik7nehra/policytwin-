import type { Policy } from './schema';
import type { PolicyDecision, TxInput } from '../types';
import { convertCents, toCents } from '../money';

/**
 * Deterministic policy engine. No LLM, no I/O, no randomness: the same policy and
 * the same transaction always yield the same decision.
 *
 * Where a policy is silent ("unspecified"), the engine applies the policy
 * LITERALLY (e.g. a tracking rule to every product type, a numeric comparison across
 * currencies) and raises an ambiguity flag. That literal behaviour is what a
 * straightforward implementation of the text would do — which is the risk
 * PolicyTwin exists to expose.
 */
export const REASON_TEXT: Record<string, string> = {
  ALL_CLAIMS_MANUAL_REVIEW: 'the policy routes every missing-delivery claim to manual review',
  OPEN_DISPUTE: 'a dispute is already open, so the case goes to a human',
  CURRENCY_OUT_OF_SCOPE: 'the transaction currency is outside the policy currency and no conversion rule exists',
  PRODUCT_TYPE_MANUAL_REVIEW: 'this product type is routed to manual review',
  EVIDENCE_MISSING: 'delivery/access evidence is missing',
  EVIDENCE_CONFLICTING: 'delivery/access evidence is conflicting',
  EVIDENCE_CONFIRMS_DELIVERY: 'evidence indicates the item was delivered',
  TRACKING_AVAILABLE: 'shipment tracking is available, so this is not a missing-tracking case',
  ABOVE_THRESHOLD: 'the amount is above the automatic-refund threshold',
  TRACKING_UNAVAILABLE: 'shipment tracking is unavailable',
  WITHIN_THRESHOLD: 'the amount is within the automatic-refund threshold',
  EVIDENCE_CONFIRMS_NON_DELIVERY: 'evidence confirms non-delivery',
  CURRENCY_CONVERTED: 'the amount was converted to the policy currency using synthetic rates',
};

export function describeTx(tx: TxInput): string {
  const parts = [
    `${tx.amount} ${tx.currency} ${tx.product_type} order`,
    `tracking ${tx.tracking_available ? 'available' : 'unavailable'}`,
    `evidence ${tx.evidence_status}`,
    `dispute ${tx.dispute_state}`,
  ];
  return parts.join(', ');
}

export function evaluatePolicy(policy: Policy, tx: TxInput): PolicyDecision {
  const flags: string[] = [];
  const triggered: string[] = [];
  const subject = describeTx(tx);

  const finish = (decision: PolicyDecision['decision'], reasons: string[]): PolicyDecision => {
    const why = reasons.map((r) => REASON_TEXT[r] ?? r).join('; ');
    return {
      decision,
      reason_codes: reasons,
      flags: [...flags],
      conditions_triggered: [...triggered],
      explanation: `Evaluated (${subject}) under "${policy.name}": ${why} → ${decision}.`,
      refund_amount: decision === 'AUTO_REFUND' ? (tx.claimed_amount ?? tx.amount) : null,
    };
  };
  const review = (code: string) => finish('REVIEW', [code]);

  if (policy.action === 'manual_review') return review('ALL_CLAIMS_MANUAL_REVIEW');

  // 1. Open dispute
  if (tx.dispute_state === 'open') {
    if (policy.dispute_handling === 'manual_review_if_open_dispute') return review('OPEN_DISPUTE');
    flags.push('DISPUTE_HANDLING_UNDEFINED');
  }

  // 2. Currency
  let comparableCents = toCents(tx.amount);
  if (policy.currency && tx.currency !== policy.currency) {
    if (policy.currency_handling === 'manual_review_other_currency') return review('CURRENCY_OUT_OF_SCOPE');
    if (policy.currency_handling === 'convert_to_policy_currency') {
      comparableCents = convertCents(comparableCents, tx.currency, policy.currency);
      triggered.push('CURRENCY_CONVERTED');
    } else {
      flags.push('CURRENCY_CONVERSION_UNDEFINED'); // literal numeric comparison follows
    }
  }

  // 3. Product-type treatment
  let treatment = policy.product_scope[tx.product_type];
  if (treatment === 'unspecified') {
    treatment = 'tracking_rule'; // literal application of the only rule the text states
    if (tx.product_type !== 'physical') flags.push('PRODUCT_SCOPE_UNDEFINED');
  }
  if (treatment === 'manual_review') return review('PRODUCT_TYPE_MANUAL_REVIEW');
  if (treatment === 'evidence_rule') {
    if (tx.evidence_status === 'missing') return review('EVIDENCE_MISSING');
    if (tx.evidence_status === 'conflicting') return review('EVIDENCE_CONFLICTING');
    if (tx.evidence_status === 'confirms_delivery') return review('EVIDENCE_CONFIRMS_DELIVERY');
    triggered.push('EVIDENCE_CONFIRMS_NON_DELIVERY');
  } else if (policy.condition === 'tracking_unavailable') {
    if (tx.tracking_available) return review('TRACKING_AVAILABLE');
    triggered.push('TRACKING_UNAVAILABLE');
  }

  // 4. Amount threshold (integer cents; inclusive/exclusive per policy)
  if (policy.maximum_amount !== null) {
    const capCents = Math.round(policy.maximum_amount * 100);
    const within = policy.threshold_inclusive ? comparableCents <= capCents : comparableCents < capCents;
    if (!within) return review('ABOVE_THRESHOLD');
    triggered.push('WITHIN_THRESHOLD');
  }

  return finish('AUTO_REFUND', triggered.length ? [...triggered] : ['WITHIN_THRESHOLD']);
}
