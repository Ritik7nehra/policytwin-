import type { CausalField, PairResult } from '../types';

/**
 * SYNTHETIC impact model. Every number here is an invented, illustrative parameter —
 * none of it is PayPal data and none of it should be quoted as such.
 */
export const SYNTHETIC_DATASET = {
  label: 'SYNTHETIC illustrative dataset — not PayPal data',
  monthly_transactions: 100_000,
  at_or_below_threshold: 24_000,
  missing_tracking_claims: 3_200,
  digital_among_missing_tracking: 870,
  digital_value_usd: 18_400,
  open_dispute_among_eligible: 41,
  avg_eligible_usd: 28.5,
  non_usd_among_eligible: 310,
  avg_non_usd_usd: 27,
  retried_refund_requests: 26,
  avg_partial_refund_usd: 20,
  duplicate_webhook_deliveries: 48,
  threshold_band_claims: 410,
  avg_threshold_band_usd: 54,
};

export interface ImpactRow {
  pair_id: string;
  label: string;
  segment: string;
  kind: 'incorrect_refunds' | 'exposure';
  count: number;
  usd: number;
  basis: string;
}

export interface ImpactSummary {
  dataset_label: string;
  rows: ImpactRow[];
  total_count: number;
  total_usd: number;
  allowed_figures: string[];
  assumptions: string[];
  facts: string[];
}

const d = SYNTHETIC_DATASET;
const usd = (n: number) => Math.round(n);

type Estimator = { segment: string; kind: ImpactRow['kind']; count: number; usd: number; basis: string };
const ESTIMATORS: Partial<Record<CausalField, Estimator>> = {
  product_type: { segment: 'digital_unverified', kind: 'incorrect_refunds', count: d.digital_among_missing_tracking, usd: d.digital_value_usd, basis: `${d.digital_among_missing_tracking} of ${d.missing_tracking_claims} synthetic missing-tracking claims are digital; synthetic value $${d.digital_value_usd.toLocaleString('en-US')}` },
  evidence_status: { segment: 'digital_unverified', kind: 'incorrect_refunds', count: d.digital_among_missing_tracking, usd: d.digital_value_usd, basis: 'same synthetic digital segment (counted once)' },
  amount: { segment: 'threshold_band', kind: 'incorrect_refunds', count: d.threshold_band_claims, usd: usd(d.threshold_band_claims * d.avg_threshold_band_usd), basis: `${d.threshold_band_claims} synthetic claims just above the cap at an average $${d.avg_threshold_band_usd}` },
  currency: { segment: 'non_usd', kind: 'exposure', count: d.non_usd_among_eligible, usd: usd(d.non_usd_among_eligible * d.avg_non_usd_usd), basis: `${d.non_usd_among_eligible} synthetic non-USD claims at an average $${d.avg_non_usd_usd} evaluated without a conversion rule` },
  dispute_state: { segment: 'open_dispute', kind: 'incorrect_refunds', count: d.open_dispute_among_eligible, usd: usd(d.open_dispute_among_eligible * d.avg_eligible_usd), basis: `${d.open_dispute_among_eligible} synthetic eligible claims with an open dispute at an average $${d.avg_eligible_usd}` },
  request_attempts: { segment: 'retries', kind: 'incorrect_refunds', count: d.retried_refund_requests, usd: usd(d.retried_refund_requests * d.avg_partial_refund_usd), basis: `${d.retried_refund_requests} synthetic retried refund requests at an average $${d.avg_partial_refund_usd} duplicated` },
  webhook_deliveries: { segment: 'duplicate_webhooks', kind: 'incorrect_refunds', count: d.duplicate_webhook_deliveries, usd: usd(d.duplicate_webhook_deliveries * d.avg_partial_refund_usd), basis: `${d.duplicate_webhook_deliveries} synthetic duplicate webhook deliveries at an average $${d.avg_partial_refund_usd} duplicated` },
};

/** Estimate impact only for pairs that failed; each synthetic segment is counted once. */
export function estimateImpact(results: PairResult[]): ImpactSummary {
  const seen = new Set<string>();
  const rows: ImpactRow[] = [];
  const facts: string[] = [];
  for (const r of results) {
    if (r.severity === 'none') continue;
    facts.push(`${r.pair_id} (${r.label}): ${r.headline}`);
    const e = ESTIMATORS[r.changed_field];
    if (!e || seen.has(e.segment)) continue;
    seen.add(e.segment);
    rows.push({ pair_id: r.pair_id, label: r.label, segment: e.segment, kind: e.kind, count: e.count, usd: e.usd, basis: e.basis });
  }
  const total_count = rows.reduce((a, r) => a + r.count, 0);
  const total_usd = rows.reduce((a, r) => a + r.usd, 0);
  const allowed = new Set<string>();
  for (const r of rows) {
    allowed.add(String(r.count));
    allowed.add(r.usd.toLocaleString('en-US'));
    allowed.add(String(r.usd));
  }
  allowed.add(String(total_count));
  allowed.add(total_usd.toLocaleString('en-US'));
  allowed.add(String(total_usd));
  const assumptions = rows.length
    ? [
        `${d.label}: ${d.monthly_transactions.toLocaleString('en-US')} monthly transactions, ${d.at_or_below_threshold.toLocaleString('en-US')} at or below the threshold, ${d.missing_tracking_claims.toLocaleString('en-US')} missing-tracking claims.`,
        ...rows.map((r) => `${r.label}: ${r.basis}.`),
      ]
    : [`${d.label}. No failed pair, so no impact was estimated.`];
  return { dataset_label: d.label, rows, total_count, total_usd, allowed_figures: [...allowed], assumptions, facts };
}
