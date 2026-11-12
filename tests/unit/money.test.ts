import { describe, expect, it } from 'vitest';
import { convertCents, formatMoney, fromCents, isMoney, sumCents, toCents } from '@/lib/money';

describe('money (integer cents, never floats)', () => {
  it('parses and formats exactly', () => {
    expect(toCents('49.99')).toBe(4999);
    expect(toCents('50.00')).toBe(5000);
    expect(toCents('0.10')).toBe(10);
    expect(fromCents(5001)).toBe('50.01');
    expect(fromCents(5)).toBe('0.05');
  });

  it('avoids the classic float trap', () => {
    // 0.1 + 0.2 !== 0.3 in floats; in cents it is exact.
    expect(sumCents([toCents('0.10'), toCents('0.20')])).toBe(toCents('0.30'));
  });

  it('validates money strings', () => {
    expect(isMoney('40.00')).toBe(true);
    expect(isMoney('40')).toBe(false);
    expect(isMoney('40.001')).toBe(false);
    expect(isMoney('-1.00')).toBe(false);
    expect(isMoney(40)).toBe(false);
  });

  it('rejects malformed input when converting', () => {
    expect(() => toCents('abc')).toThrow();
  });

  it('converts with the synthetic FX table and is a no-op for the same currency', () => {
    expect(convertCents(10000, 'USD', 'USD')).toBe(10000);
    expect(convertCents(10000, 'EUR', 'USD')).toBe(10800); // 1.08 synthetic
    expect(convertCents(10000, 'USD', 'EUR')).toBe(9259); // rounds to nearest cent
  });

  it('formats with a currency symbol', () => {
    expect(formatMoney(5000, 'USD')).toContain('50.00');
  });
});
