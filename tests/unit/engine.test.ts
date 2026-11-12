import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '@/lib/policy/engine';
import { policyA, policyB, policyC, tx } from '../helpers';

describe('policy engine — Version A (manual review)', () => {
  it('sends everything to review', () => {
    const a = policyA();
    for (const o of [{}, { amount: '1.00' }, { product_type: 'digital' as const }, { dispute_state: 'open' as const }]) {
      const d = evaluatePolicy(a, tx(a, o));
      expect(d.decision).toBe('REVIEW');
      expect(d.reason_codes).toEqual(['ALL_CLAIMS_MANUAL_REVIEW']);
    }
  });
});

describe('policy engine — Version B (literal implementation of the proposal)', () => {
  const b = policyB();
  const d = (o = {}) => evaluatePolicy(b, tx(b, o));

  it('auto-refunds a $40 physical order with no tracking', () => {
    const r = d();
    expect(r.decision).toBe('AUTO_REFUND');
    expect(r.refund_amount).toBe('40.00');
  });

  it('respects the threshold: 49.99 / 50.00 in, 50.01 out', () => {
    expect(d({ amount: '49.99' }).decision).toBe('AUTO_REFUND');
    expect(d({ amount: '50.00' }).decision).toBe('AUTO_REFUND');
    const over = d({ amount: '50.01' });
    expect(over.decision).toBe('REVIEW');
    expect(over.reason_codes).toContain('ABOVE_THRESHOLD');
  });

  it('refuses when tracking is available', () => {
    expect(d({ tracking_available: true }).reason_codes).toContain('TRACKING_AVAILABLE');
  });

  it('applies the tracking rule to digital goods and raises PRODUCT_SCOPE_UNDEFINED', () => {
    const r = d({ product_type: 'digital' });
    expect(r.decision).toBe('AUTO_REFUND');
    expect(r.flags).toContain('PRODUCT_SCOPE_UNDEFINED');
  });

  it('compares numerically across currencies and raises CURRENCY_CONVERSION_UNDEFINED', () => {
    const r = d({ currency: 'EUR' });
    expect(r.decision).toBe('AUTO_REFUND');
    expect(r.flags).toContain('CURRENCY_CONVERSION_UNDEFINED');
  });

  it('ignores an open dispute and flags DISPUTE_HANDLING_UNDEFINED', () => {
    const r = d({ dispute_state: 'open' });
    expect(r.decision).toBe('AUTO_REFUND');
    expect(r.flags).toContain('DISPUTE_HANDLING_UNDEFINED');
  });

  it('is deterministic: same input, same output', () => {
    expect(d()).toEqual(d());
  });
});

describe('policy engine — Version C (corrected)', () => {
  const c = policyC();
  const d = (o = {}) => evaluatePolicy(c, tx(c, o));

  it('keeps the business objective for physical goods under the cap', () => {
    expect(d().decision).toBe('AUTO_REFUND');
  });

  it('routes digital goods without evidence to review, and refunds with non-delivery evidence', () => {
    expect(d({ product_type: 'digital', evidence_status: 'missing' }).decision).toBe('REVIEW');
    expect(d({ product_type: 'digital', evidence_status: 'conflicting' }).decision).toBe('REVIEW');
    expect(d({ product_type: 'digital', evidence_status: 'confirms_non_delivery' }).decision).toBe('AUTO_REFUND');
  });

  it('routes other currencies and open disputes to review', () => {
    expect(d({ currency: 'EUR' }).reason_codes).toContain('CURRENCY_OUT_OF_SCOPE');
    expect(d({ dispute_state: 'open' }).reason_codes).toContain('OPEN_DISPUTE');
  });

  it('raises no ambiguity flags on any of the demo transactions', () => {
    for (const o of [{}, { product_type: 'digital' as const }, { currency: 'EUR' as const }, { dispute_state: 'open' as const }]) {
      expect(d(o).flags).toEqual([]);
    }
  });
});
