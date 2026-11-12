import { unmodeledExceptions, type Policy } from './schema';
import { currencySymbol } from '../money';

/**
 * Deterministically render a structured policy back into plain English.
 * The Policy Repair agent's corrected policy (Version C) gets its source text from
 * here, so the text a human approves is exactly what the engine will execute.
 * Round-trip property (tested): readPolicyOffline(policyToText(p)) reproduces p's controls.
 */
export function policyToText(p: Policy): string {
  if (p.action === 'manual_review') return 'All missing-delivery claims require manual review.';

  const sym = p.currency ? currencySymbol(p.currency) : '$';
  const cap =
    p.maximum_amount !== null
      ? `${sym}${Number.isInteger(p.maximum_amount) ? p.maximum_amount : p.maximum_amount.toFixed(2)}`
      : null;
  const capPhrase = cap ? (p.threshold_inclusive ? ` of ${cap} or less` : ` below ${cap}`) : '';
  const s: string[] = [];

  const { physical, digital, service } = p.product_scope;
  const scoped = physical !== 'unspecified' || digital !== 'unspecified' || service !== 'unspecified';
  const trackingClause = p.condition === 'tracking_unavailable' ? ' when valid shipment tracking is unavailable' : '';

  if (!scoped) {
    s.push(`Automatically refund transactions${capPhrase}${p.condition === 'tracking_unavailable' ? ' when tracking information is unavailable' : ''}.`);
  } else {
    if (physical === 'tracking_rule') s.push(`For physical goods${capPhrase}, automatically refund a missing-delivery claim${trackingClause}.`);
    else if (physical === 'manual_review') s.push('Physical goods are excluded from automatic refunds and go to manual review.');

    if (digital === 'evidence_rule') {
      s.push('For digital goods, require digital-delivery or access evidence. If the evidence is missing or conflicting, send the case for review.');
    } else if (digital === 'manual_review') s.push('Digital goods are excluded from automatic refunds and go to manual review.');
    else if (digital === 'tracking_rule') s.push(`For digital goods${capPhrase}, automatically refund a missing-delivery claim${trackingClause}.`);

    if (service === 'evidence_rule') s.push('Apply the same evidence requirement to services.');
    else if (service === 'manual_review') s.push('Services are excluded from automatic refunds and go to manual review.');
    else if (service === 'tracking_rule') s.push(`For services${capPhrase}, automatically refund a missing-delivery claim${trackingClause}.`);
  }

  if (p.currency_handling === 'manual_review_other_currency' && p.currency) {
    s.push(`Only ${p.currency} transactions are in scope; transactions in any other currency go to review until a conversion rule is approved.`);
  } else if (p.currency_handling === 'convert_to_policy_currency' && p.currency) {
    s.push(`Transactions in other currencies are converted to ${p.currency} at the approved daily exchange rate before the threshold is applied.`);
  }
  if (p.dispute_handling === 'manual_review_if_open_dispute') s.push('If a dispute is open on the transaction, send the case for review.');

  const idem = p.retry_handling === 'idempotent_stable_request_id';
  const dedupe = p.duplicate_event_handling === 'dedupe_by_event_id';
  if (idem && dedupe) {
    s.push('Treat retried refund requests as the same logical request using a stable PayPal-Request-Id, and ignore duplicate webhook deliveries using event-ID deduplication.');
  } else if (idem) {
    s.push('Treat retried refund requests as the same logical request using a stable PayPal-Request-Id.');
  } else if (dedupe) {
    s.push('Ignore duplicate webhook deliveries using event-ID deduplication.');
  }
  // Exceptions the engine cannot execute are carried forward verbatim: a repaired policy must not silently lose a business rule.
  for (const e of unmodeledExceptions(p)) s.push(`Stated exception that PolicyTwin cannot test: “${e}”`);
  return s.join(' ');
}
