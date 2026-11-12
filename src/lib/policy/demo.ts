/** The fictional demo policy change from the spec. All figures are illustrative. */
export const DEMO_POLICY_INPUT = {
  name: 'Low-Value Missing-Delivery Refund',
  business_reason: 'Resolve simple low-value cases faster.',
  current_policy: 'All missing-delivery claims require manual review.',
  proposed_policy: 'Automatically refund transactions of $50 or less when tracking information is unavailable.',
  affected_products: ['Orders API v2', 'Payments API v2 (captures, refunds)', 'Webhooks'],
  target_markets: ['US / USD'],
  expected_outcome: 'Resolve simple low-value cases faster.',
};

export type PolicyIntake = typeof DEMO_POLICY_INPUT;
