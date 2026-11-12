import { describe, expect, it } from 'vitest';
import { readPolicyOffline } from '@/lib/policy/reader';
import { unmodeledExceptions } from '@/lib/policy/schema';
import { policyToText } from '@/lib/policy/text';
import { policyReaderDef } from '@/lib/agents/roles';
import { decideRelease, computeCoverage } from '@/lib/analysis/release';
import { repairPolicyDeterministic } from '@/lib/analysis/repair';

const WITH_EXCEPTION = 'Automatically refund missing-delivery claims of $50 or less when tracking is unavailable, except for new customers.';
const SERVICE_EXCLUSION = 'Missing-delivery claims for services are excluded from automatic refunds and go to manual review. Automatically refund physical goods of $50 or less when tracking is unavailable.';

describe('exceptions the engine cannot execute are never silently "tested"', () => {
  it('flags a customer-type exception as unmodelled', () => {
    const p = readPolicyOffline(WITH_EXCEPTION, 'x');
    expect(unmodeledExceptions(p)).toEqual([WITH_EXCEPTION]);
    expect(p.ambiguity_codes).toContain('UNMODELED_EXCEPTION');
  });

  it('does NOT flag a product-class exclusion the engine does execute', () => {
    const p = readPolicyOffline(SERVICE_EXCLUSION, 'x');
    expect(p.product_scope.service).toBe('manual_review');
    expect(unmodeledExceptions(p)).toEqual([]);
    expect(p.ambiguity_codes).not.toContain('UNMODELED_EXCEPTION');
  });

  it('flags an exclusion that carries its own extra condition', () => {
    const p = readPolicyOffline('Services are excluded from automatic refunds unless the buyer is a business account. Automatically refund physical goods of $50 or less when tracking is unavailable.', 'x');
    expect(unmodeledExceptions(p)).toHaveLength(1);
  });

  it('has nothing to flag on a plain manual-review policy or a policy without exceptions', () => {
    expect(unmodeledExceptions(readPolicyOffline('All missing-delivery claims require manual review. No exceptions are made except as approved by a manager.', 'x'))).toEqual([]);
    expect(unmodeledExceptions(readPolicyOffline('Automatically refund missing-delivery claims of $50 or less when tracking is unavailable.', 'x'))).toEqual([]);
  });

  it('a repaired policy keeps the exception text (and so stays flagged) instead of silently dropping it', () => {
    const b = readPolicyOffline(WITH_EXCEPTION, 'x');
    const c = repairPolicyDeterministic(b, []);
    expect(c.source_text).toContain('except for new customers');
    expect(c.policy.exceptions.length).toBeGreaterThan(0);
    expect(c.policy.ambiguity_codes).toContain('UNMODELED_EXCEPTION');
    // …and re-reading the rendered text keeps it flagged.
    expect(readPolicyOffline(policyToText(c.policy), 'c', 'missing-delivery').ambiguity_codes).toContain('UNMODELED_EXCEPTION');
  });
});

describe('release gate: an unverified policy term rules out PASS', () => {
  const cov = computeCoverage([], []);
  it('PASS becomes REVIEW, and the term is quoted in the reasons', () => {
    const r = decideRelease([], cov, [], ['“…except for new customers.”']);
    expect(r.decision).toBe('REVIEW');
    expect(r.reasons.join(' ')).toMatch(/Not verified by PolicyTwin.*new customers/);
    expect(r.unverified_terms).toHaveLength(1);
  });
  it('does not weaken a BLOCK, and is still listed', () => {
    const r = decideRelease([{ pair_id: 'p', label: 'l', headline: 'bad', severity: 'critical', failed_invariants: [], outcome: 'UNINTENDED_EXPANSION' } as never], cov, [], ['“x”']);
    expect(r.decision).toBe('BLOCK');
    expect(r.reasons.join(' ')).toMatch(/Not verified/);
  });
  it('no caveats → unchanged behaviour', () => {
    expect(decideRelease([], cov, []).decision).toBe('PASS');
  });
});

describe('Policy Reader guard: the model cannot hide an exception the text states', () => {
  it('restores an omitted exception and removes an invented one', () => {
    const text = WITH_EXCEPTION;
    const detectable = readPolicyOffline(text, 'x');
    const llmOut = { ...detectable, exceptions: ['Refunds are never issued on Sundays.'] }; // hid the real one, invented another
    const g = policyReaderDef.guard!(llmOut, { name: 'x', text, context: '' });
    expect(g.output.exceptions).toEqual([WITH_EXCEPTION]);
    expect(g.problems.join(' ')).toMatch(/removed 1 exception/);
    expect(g.problems.join(' ')).toMatch(/restored 1 exception/);
    expect(g.output.ambiguity_codes).toContain('UNMODELED_EXCEPTION');
  });
});
