import { describe, expect, it } from 'vitest';
import { readPolicyDetailed, readPolicyOffline } from '@/lib/policy/reader';
import { policyToText } from '@/lib/policy/text';
import { PolicySchema, deriveAmbiguityCodes, manualReviewPolicy } from '@/lib/policy/schema';
import { policyA, policyB, policyC } from '../helpers';

describe('Policy Reader (deterministic)', () => {
  it('reads Version A as "route everything to a human"', () => {
    const a = policyA();
    expect(a.action).toBe('manual_review');
    expect(a.trigger).toBe('missing_delivery_claim');
    expect(PolicySchema.safeParse(a).success).toBe(true);
  });

  it('extracts trigger, threshold, currency and condition from Version B', () => {
    const b = policyB();
    expect(b.trigger).toBe('missing_delivery_claim');
    expect(b.action).toBe('automatic_refund');
    expect(b.maximum_amount).toBe(50);
    expect(b.currency).toBe('USD');
    expect(b.condition).toBe('tracking_unavailable');
    expect(b.threshold_inclusive).toBe(true); // "$50 or less"
    expect(PolicySchema.safeParse(b).success).toBe(true);
  });

  it('does NOT invent exceptions the text never states', () => {
    expect(policyB().exceptions).toEqual([]);
  });

  it('flags every behaviour Version B leaves unspecified', () => {
    const codes = policyB().ambiguity_codes;
    for (const c of ['PRODUCT_SCOPE', 'SERVICE_EVIDENCE', 'CURRENCY_CONVERSION', 'DISPUTE_STATE', 'RETRY_BEHAVIOR', 'DUPLICATE_EVENTS']) {
      expect(codes).toContain(c);
    }
    expect(policyB().ambiguities.length).toBe(codes.length);
  });

  it('treats an exclusive threshold ("below") as exclusive', () => {
    const p = readPolicyOffline('Automatically refund missing-delivery claims below $25 when tracking is unavailable.', 'x');
    expect(p.maximum_amount).toBe(25);
    expect(p.threshold_inclusive).toBe(false);
  });

  it('reads "up to $X" as inclusive and "under $X" as exclusive', () => {
    const upTo = readPolicyDetailed('Automatically refund missing-delivery claims up to $50 when tracking is unavailable.', 'x');
    expect(upTo.policy.maximum_amount).toBe(50);
    expect(upTo.policy.threshold_inclusive).toBe(true);
    const under = readPolicyDetailed('Automatically refund missing-delivery claims under $50.', 'x');
    expect(under.policy.threshold_inclusive).toBe(false);
  });

  it('marks an unrecognised trigger instead of guessing', () => {
    const p = readPolicyOffline('Automatically approve credit-limit increases under $500.', 'x');
    expect(p.ambiguity_codes).toContain('UNSUPPORTED_TRIGGER');
  });

  it('derives no ambiguities for a manual-review-only policy', () => {
    expect(deriveAmbiguityCodes(manualReviewPolicy('A'))).toEqual([]);
  });
});

describe('policy text ↔ structure round trip', () => {
  it('re-reading the rendered text of Version C reproduces its controls', () => {
    const c = policyC();
    const back = readPolicyOffline(policyToText(c), 'Version C', 'missing-delivery');
    expect(back.maximum_amount).toBe(c.maximum_amount);
    expect(back.currency).toBe(c.currency);
    expect(back.threshold_inclusive).toBe(c.threshold_inclusive);
    expect(back.product_scope).toEqual(c.product_scope);
    expect(back.currency_handling).toBe(c.currency_handling);
    expect(back.dispute_handling).toBe(c.dispute_handling);
    expect(back.retry_handling).toBe(c.retry_handling);
    expect(back.duplicate_event_handling).toBe(c.duplicate_event_handling);
  });

  it('Version C has no remaining control ambiguities', () => {
    expect(policyC().ambiguity_codes).toEqual([]);
  });
});
