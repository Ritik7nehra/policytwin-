import type {
  Decision,
  ExecutionTrace,
  InvariantResult,
  PairOutcome,
  PairResult,
  PairTag,
  PolicyDecision,
  Severity,
  TwinPair,
} from '../types';
import { uniq } from '../util';

export interface ScenarioEval {
  scenario_id: string;
  old: PolicyDecision; // Version A
  neu: PolicyDecision; // candidate (B or C)
  trace: ExecutionTrace;
  invariants: InvariantResult[];
}

const val = (tx: unknown, field: string): string => String((tx as Record<string, unknown>)[field]);

/**
 * Compare the old and new policy on one twin pair. Pure and deterministic.
 * The expectation (must_differ / must_match) comes from the causal catalog, not from an LLM.
 */
export function classifyPair(pair: TwinPair, ev: { base: ScenarioEval; twin: ScenarioEval }): PairResult {
  const nb = ev.base.neu;
  const nt = ev.twin.neu;
  const flags = uniq([...nb.flags, ...nt.flags]);
  const same = nb.decision === nt.decision;

  let outcome: PairOutcome = 'AS_EXPECTED';
  let severity: Severity = 'none';

  if (pair.expectation === 'must_differ' && same) {
    if (pair.changed_field === 'currency' && flags.includes('CURRENCY_CONVERSION_UNDEFINED')) {
      outcome = 'AMBIGUOUS';
      severity = 'medium';
    } else if (nt.decision === 'AUTO_REFUND') {
      outcome = 'UNINTENDED_EXPANSION';
      severity = pair.severity_if_violated;
    } else {
      outcome = 'UNEXPECTED_EQUALITY';
      severity = 'medium';
    }
  } else if (pair.expectation === 'must_match' && !same) {
    outcome = 'UNEXPECTED_DIFFERENCE';
    severity = pair.severity_if_violated;
  }
  if (outcome === 'AS_EXPECTED' && flags.length) {
    outcome = 'AMBIGUOUS';
    severity = 'medium';
  }

  const failed = [...ev.base.invariants, ...ev.twin.invariants].filter((i) => i.applicable && !i.passed);
  const failedCodes = uniq(failed.map((i) => i.code));
  if (failedCodes.length) {
    severity = 'critical';
    if (outcome === 'AS_EXPECTED' || outcome === 'AMBIGUOUS') outcome = 'INVARIANT_FAILURE';
  }

  const tags: PairTag[] = [];
  if (outcome === 'AS_EXPECTED') tags.push('PASSED');
  if (outcome === 'UNEXPECTED_DIFFERENCE' || outcome === 'UNEXPECTED_EQUALITY' || outcome === 'UNINTENDED_EXPANSION') tags.push('UNEXPECTED_DIFFERENCE');
  if (failedCodes.length) tags.push('INVARIANT_FAILURE');
  if (outcome === 'AMBIGUOUS') tags.push('HUMAN_REVIEW');
  if (severity === 'critical') tags.push('CRITICAL_REGRESSION');

  const f = pair.changed_field;
  const bv = val(pair.base, f);
  const tv = val(pair.twin, f);
  const headline = {
    AS_EXPECTED: pair.expectation === 'must_differ' ? `Decision changed as expected: ${nb.decision} → ${nt.decision}.` : `Decision stayed the same as expected: ${nb.decision}.`,
    UNINTENDED_EXPANSION: `Unintended policy expansion: the twin (${f}=${tv}) received the same ${nt.decision} outcome as the base (${f}=${bv}).`,
    UNEXPECTED_EQUALITY: `Decision did not change when it should have: both scenarios were ${nb.decision}.`,
    UNEXPECTED_DIFFERENCE: `Decision changed when it should not have: ${nb.decision} → ${nt.decision}.`,
    AMBIGUOUS: `Ambiguous behavior (${flags.join(', ')}): needs human evaluation.`,
    INVARIANT_FAILURE: `Financial invariant failed: ${failedCodes.join(', ')}.`,
  }[outcome];

  const invariantText = failed.length ? ` Invariant evidence: ${uniq(failed.map((i) => `${i.code} — ${i.detail}`)).join('; ')}.` : '';
  const explanation =
    `${pair.rationale} Under the candidate policy the base (${f}=${bv}) → ${nb.decision} [${nb.reason_codes.join(', ')}] and the twin (${f}=${tv}) → ${nt.decision} [${nt.reason_codes.join(', ')}]. ${headline}${invariantText}`;

  return {
    pair_id: pair.id,
    label: pair.label,
    origin: pair.origin,
    category: pair.category,
    changed_field: pair.changed_field,
    base_scenario_id: ev.base.scenario_id,
    twin_scenario_id: ev.twin.scenario_id,
    expectation: pair.expectation,
    old_base: ev.base.old.decision as Decision,
    old_twin: ev.twin.old.decision as Decision,
    new_base: nb.decision,
    new_twin: nt.decision,
    new_flags: flags,
    outcome,
    severity,
    tags,
    failed_invariants: failedCodes,
    headline,
    explanation,
  };
}
