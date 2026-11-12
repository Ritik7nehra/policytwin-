import { describe, expect, it } from 'vitest';
import { readPolicyOffline } from '@/lib/policy/reader';
import { CASES, assertPolicyMatches } from './shared';

describe('Policy Reader evals (offline deterministic reader)', () => {
  it('covers at least 15 sample policies', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(15);
  });
  it.each(CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    assertPolicyMatches(readPolicyOffline(c.text, c.id, c.context), c.expect, c.text);
  });
});
