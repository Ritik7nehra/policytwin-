import type { CausalField, Expectation, Severity, TestCategory } from '../types';

/**
 * The causal catalog: the deterministic "oracle" that says, for each variable a twin
 * may change, whether the policy decision SHOULD change (must_differ) or must NOT
 * change (must_match), what category of test it belongs to, and how severe a
 * violation is. The Twin Generator / Adversarial agents may propose pairs, but code
 * overrides their expectation with this catalog — the LLM never grades the policy.
 */
export interface CausalEntry {
  category: TestCategory;
  expectation: Expectation;
  severity_if_violated: Severity;
  why: string;
}

export const CAUSAL_CATALOG: Record<CausalField, CausalEntry> = {
  product_type: {
    category: 'product_type',
    expectation: 'must_differ',
    severity_if_violated: 'critical',
    why: 'Shipment tracking is a physical-goods concept; a digital or service claim cannot be judged by tracking, so the decision must depend on product type.',
  },
  amount: {
    category: 'amount_boundary',
    expectation: 'must_differ',
    severity_if_violated: 'critical',
    why: 'Crossing the threshold must flip the decision; a policy that ignores the boundary refunds more than intended.',
  },
  currency: {
    category: 'currency_variation',
    expectation: 'must_differ',
    severity_if_violated: 'medium',
    why: 'The threshold is denominated in one currency. Without a conversion rule, the same number in another currency is a different amount of money.',
  },
  request_attempts: {
    category: 'duplicate_request',
    expectation: 'must_match',
    severity_if_violated: 'critical',
    why: 'A retried request for the same claim must never pay out twice. The decision should stay the same and the money effects must not double.',
  },
  dispute_state: {
    category: 'dispute_state',
    expectation: 'must_differ',
    severity_if_violated: 'high',
    why: 'Refunding while a dispute is open risks returning the same money twice, so an open dispute must change the route.',
  },
  webhook_deliveries: {
    category: 'duplicate_webhook',
    expectation: 'must_match',
    severity_if_violated: 'critical',
    why: 'PayPal can redeliver webhooks. A duplicate delivery must not create a duplicate operation or move local state backwards.',
  },
  evidence_status: {
    category: 'evidence_status',
    expectation: 'must_differ',
    severity_if_violated: 'high',
    why: 'For goods without shipment tracking, the decision must hinge on delivery/access evidence: confirmed non-delivery and missing evidence are not the same case.',
  },
  customer_history: {
    category: 'customer_history',
    expectation: 'must_match',
    severity_if_violated: 'high',
    why: 'Account history is not part of this policy, so it must not silently change the decision.',
  },
  payment_flow: {
    category: 'void_authorization',
    expectation: 'must_match',
    severity_if_violated: 'critical',
    why: 'A voided authorization must never be capturable. The claim decision is unchanged, and no money may move on the voided path.',
  },
};
