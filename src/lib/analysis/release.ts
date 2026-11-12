import type { Coverage, PairResult, ReleaseDecision, TestCategory } from '../types';
import { uniq } from '../util';

export function computeCoverage(required: TestCategory[], executedCategories: TestCategory[]): Coverage {
  const covered = uniq(executedCategories);
  const missing = required.filter((c) => !covered.includes(c));
  return { required, covered, missing, ratio: required.length === 0 ? 1 : (required.length - missing.length) / required.length };
}

/**
 * Pass/review/block logic — deterministic, no LLM.
 *   BLOCK  : any financial invariant failed, or any critical finding
 *   REVIEW : any high/medium finding (ambiguity, unexpected route), missing required coverage, execution errors,
 *            or policy terms PolicyTwin could not execute (`caveats`) — it never says PASS about what it did not test
 *   PASS   : otherwise
 */
export function decideRelease(results: PairResult[], coverage: Coverage, executionErrors: string[], caveats: string[] = []): ReleaseDecision {
  const critical = results.filter((r) => r.severity === 'critical');
  const high = results.filter((r) => r.severity === 'high');
  const medium = results.filter((r) => r.severity === 'medium');
  const invariantFailures = results.flatMap((r) => r.failed_invariants.map((c) => `${r.pair_id}: ${c}`));
  const counts = {
    pairs: results.length,
    passed: results.filter((r) => r.outcome === 'AS_EXPECTED').length,
    critical: critical.length,
    high: high.length,
    medium: medium.length,
    invariant_failures: invariantFailures.length,
  };

  let decision: ReleaseDecision['decision'] = 'PASS';
  const reasons: string[] = [];
  if (critical.length || invariantFailures.length) {
    decision = 'BLOCK';
    for (const r of critical) reasons.push(`${r.pair_id} ${r.label}: ${r.headline}`);
    for (const c of caveats) reasons.push(`Not verified by PolicyTwin — a human must check: ${c}`);
  } else if (high.length || medium.length || coverage.missing.length || executionErrors.length || caveats.length) {
    decision = 'REVIEW';
    for (const r of [...high, ...medium]) reasons.push(`${r.pair_id} ${r.label}: ${r.headline}`);
    if (coverage.missing.length) reasons.push(`Required test categories not covered: ${coverage.missing.join(', ')}.`);
    for (const e of executionErrors) reasons.push(`Execution problem: ${e}`);
    for (const c of caveats) reasons.push(`Not verified by PolicyTwin — a human must check: ${c}`);
  } else {
    reasons.push(`No material regression detected across ${results.length} twin pairs; every applicable deterministic invariant held.`);
  }

  return {
    decision,
    reasons,
    critical_findings: critical.map((r) => `${r.pair_id}: ${r.headline}`),
    invariant_failures: invariantFailures,
    counts,
    coverage,
    execution_errors: executionErrors,
    unverified_terms: caveats,
  };
}
