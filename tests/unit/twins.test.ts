import { describe, expect, it } from 'vitest';
import { CAUSAL_CATALOG } from '@/lib/twins/catalog';
import { assertSingleCausalChange, buildAdversarialPairs, buildAllPairs, buildCorePairs, diffFields, validateTwinPair } from '@/lib/twins/generator';
import { CAUSAL_FIELDS, TEST_CATEGORIES } from '@/lib/types';
import { policyB, tx } from '../helpers';

describe('twin generator', () => {
  const b = policyB();

  it('builds the six core pairs from the spec', () => {
    const core = buildCorePairs(b);
    expect(core).toHaveLength(6);
    expect(core.map((p) => p.changed_field)).toEqual(['product_type', 'amount', 'currency', 'request_attempts', 'dispute_state', 'webhook_deliveries']);
  });

  it('every generated pair differs in EXACTLY one declared causal field', () => {
    for (const p of buildAllPairs(b)) {
      expect(diffFields(p.base, p.twin)).toEqual([p.changed_field]);
      expect(validateTwinPair(p)).toEqual([]);
    }
  });

  it('builds the threshold pair around the policy’s own cap (49.99 vs 50.01)', () => {
    const p = buildCorePairs(b)[1];
    expect([p.base.amount, p.twin.amount]).toEqual(['49.99', '50.01']);
  });

  it('adds adversarial pairs, including the exact boundary', () => {
    const adv = buildAdversarialPairs(b, 7);
    expect(adv.every((p) => p.origin === 'adversarial')).toBe(true);
    expect([adv[0].base.amount, adv[0].twin.amount]).toEqual(['50.00', '50.01']);
    expect(adv.map((p) => p.id)).toEqual(['pair_07', 'pair_08', 'pair_09', 'pair_10']);
  });

  it('can build the core-only set', () => {
    expect(buildAllPairs(b, { adversarial: false })).toHaveLength(6);
  });

  it('uses a partial claimed amount for retry and duplicate-webhook pairs so a second refund is possible', () => {
    const core = buildCorePairs(b);
    for (const i of [3, 5]) {
      expect(core[i].base.claimed_amount).toBe('20.00');
      expect(core[i].twin.claimed_amount).toBe('20.00');
    }
  });

  it('rejects a pair that changes two fields', () => {
    const base = tx(b);
    const problems = validateTwinPair({ base, twin: { ...base, product_type: 'digital', amount: '10.00' }, changed_field: 'product_type' });
    expect(problems.join(' ')).toMatch(/exactly one field/);
    expect(() => assertSingleCausalChange({ base, twin: { ...base, product_type: 'digital', amount: '10.00' }, changed_field: 'product_type' })).toThrow();
  });

  it('rejects a mislabelled changed_field and a non-causal field', () => {
    const base = tx(b);
    expect(validateTwinPair({ base, twin: { ...base, currency: 'EUR' }, changed_field: 'amount' }).join(' ')).toMatch(/actually changed/);
    expect(validateTwinPair({ base, twin: { ...base, tracking_available: true }, changed_field: 'tracking_available' as never }).join(' ')).toMatch(/not a permitted causal variable/);
  });

  it('rejects an invalid transaction (bad money string)', () => {
    const base = tx(b);
    expect(validateTwinPair({ base: { ...base, amount: '40' }, twin: { ...base, amount: '41.00' }, changed_field: 'amount' }).join(' ')).toMatch(/not a valid transaction/);
  });
});

describe('causal catalog (the deterministic oracle)', () => {
  it('has an entry for every causal field with a known category', () => {
    for (const f of CAUSAL_FIELDS) {
      const e = CAUSAL_CATALOG[f];
      expect(e, f).toBeDefined();
      expect(TEST_CATEGORIES).toContain(e.category);
      expect(['must_differ', 'must_match']).toContain(e.expectation);
    }
  });

  it('expects the threshold, product type and dispute to change the decision, and retries/duplicates not to', () => {
    expect(CAUSAL_CATALOG.amount.expectation).toBe('must_differ');
    expect(CAUSAL_CATALOG.product_type.expectation).toBe('must_differ');
    expect(CAUSAL_CATALOG.dispute_state.expectation).toBe('must_differ');
    expect(CAUSAL_CATALOG.request_attempts.expectation).toBe('must_match');
    expect(CAUSAL_CATALOG.webhook_deliveries.expectation).toBe('must_match');
  });
});
