import { describe, expect, it } from 'vitest';
import { computeCoverage, decideRelease } from '@/lib/analysis/release';
import { estimateImpact, SYNTHETIC_DATASET } from '@/lib/analysis/impact';
import { repairPolicyDeterministic } from '@/lib/analysis/repair';
import { policyB } from '../helpers';
import type { PairResult } from '@/lib/types';

const result = (over: Partial<PairResult> = {}): PairResult => ({
  pair_id: 'pair_01',
  label: 'x',
  origin: 'core',
  category: 'product_type',
  changed_field: 'product_type',
  base_scenario_id: 'a',
  twin_scenario_id: 'b',
  expectation: 'must_differ',
  old_base: 'REVIEW',
  old_twin: 'REVIEW',
  new_base: 'AUTO_REFUND',
  new_twin: 'REVIEW',
  new_flags: [],
  outcome: 'AS_EXPECTED',
  severity: 'none',
  tags: ['PASSED'],
  failed_invariants: [],
  headline: 'ok',
  explanation: 'ok',
  ...over,
});

const fullCoverage = computeCoverage(['product_type'], ['product_type']);

describe('coverage', () => {
  it('computes missing categories and ratio', () => {
    const c = computeCoverage(['amount_boundary', 'product_type', 'currency_variation', 'dispute_state'], ['amount_boundary', 'product_type', 'product_type']);
    expect(c.missing).toEqual(['currency_variation', 'dispute_state']);
    expect(c.ratio).toBe(0.5);
  });
  it('is 100% when nothing is required', () => {
    expect(computeCoverage([], []).ratio).toBe(1);
  });
});

describe('release logic', () => {
  it('PASS when every pair is as expected and coverage is complete', () => {
    const r = decideRelease([result(), result({ pair_id: 'pair_02' })], fullCoverage, []);
    expect(r.decision).toBe('PASS');
    expect(r.counts).toMatchObject({ pairs: 2, passed: 2, critical: 0, invariant_failures: 0 });
  });

  it('BLOCK on any critical finding', () => {
    const r = decideRelease([result({ outcome: 'UNINTENDED_EXPANSION', severity: 'critical', headline: 'bad' })], fullCoverage, []);
    expect(r.decision).toBe('BLOCK');
    expect(r.critical_findings).toHaveLength(1);
  });

  it('BLOCK on an invariant failure even if the pair severity was otherwise low', () => {
    const r = decideRelease([result({ failed_invariants: ['REFUND_TOTAL_LTE_CAPTURE'] })], fullCoverage, []);
    expect(r.decision).toBe('BLOCK');
    expect(r.invariant_failures).toEqual(['pair_01: REFUND_TOTAL_LTE_CAPTURE']);
  });

  it('REVIEW on medium/high findings', () => {
    expect(decideRelease([result({ outcome: 'AMBIGUOUS', severity: 'medium' })], fullCoverage, []).decision).toBe('REVIEW');
    expect(decideRelease([result({ outcome: 'UNINTENDED_EXPANSION', severity: 'high' })], fullCoverage, []).decision).toBe('REVIEW');
  });

  it('REVIEW when required coverage is missing', () => {
    const r = decideRelease([result()], computeCoverage(['product_type', 'dispute_state'], ['product_type']), []);
    expect(r.decision).toBe('REVIEW');
    expect(r.reasons.join(' ')).toMatch(/dispute_state/);
  });

  it('REVIEW when an execution error occurred (never a silent PASS)', () => {
    const r = decideRelease([result()], fullCoverage, ['pair_03 twin: capture failed']);
    expect(r.decision).toBe('REVIEW');
    expect(r.reasons.join(' ')).toMatch(/capture failed/);
  });

  it('BLOCK outranks REVIEW', () => {
    const r = decideRelease([result({ severity: 'critical' }), result({ pair_id: 'p2', severity: 'medium' })], computeCoverage(['x' as never], []), ['err']);
    expect(r.decision).toBe('BLOCK');
  });
});

describe('synthetic impact estimate', () => {
  it('is labelled synthetic and shows facts separately from assumptions', () => {
    const s = estimateImpact([result({ pair_id: 'pair_01', outcome: 'UNINTENDED_EXPANSION', severity: 'critical', category: 'product_type', headline: 'digital refunded' })]);
    expect(JSON.stringify(SYNTHETIC_DATASET)).toMatch(/synthetic/i);
    expect(s.facts.length).toBeGreaterThan(0);
    expect(s.assumptions.length).toBeGreaterThan(0);
    expect(s.rows.every((r) => r.count > 0)).toBe(true);
  });

  it('reports nothing when no pair failed', () => {
    expect(estimateImpact([result()]).rows).toEqual([]);
  });
});

describe('deterministic repair', () => {
  const b = policyB();
  const proposal = repairPolicyDeterministic(b, []);

  it('fills every unspecified control and keeps the business objective', () => {
    expect(proposal.policy.maximum_amount).toBe(50);
    expect(proposal.policy.currency).toBe('USD');
    expect(proposal.policy.action).toBe('automatic_refund');
    expect(proposal.policy.product_scope).toEqual({ physical: 'tracking_rule', digital: 'evidence_rule', service: 'evidence_rule' });
    expect(proposal.policy.retry_handling).toBe('idempotent_stable_request_id');
    expect(proposal.policy.duplicate_event_handling).toBe('dedupe_by_event_id');
  });

  it('records each change with a reason, and does not mutate the candidate', () => {
    expect(proposal.changes.length).toBeGreaterThanOrEqual(6);
    for (const c of proposal.changes) expect(c.reason.length).toBeGreaterThan(10);
    expect(b.product_scope.digital).toBe('unspecified');
  });

  it('produces plain-English text for a human to approve', () => {
    expect(proposal.source_text).toMatch(/\$50/);
    expect(proposal.source_text).toMatch(/dispute/i);
    expect(proposal.generated_by).toBe('deterministic');
  });
});
