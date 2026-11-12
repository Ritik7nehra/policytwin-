/**
 * Money helpers. All arithmetic is done in integer minor units (cents) so that
 * threshold comparisons such as 49.99 <= 50.00 can never suffer float error.
 * This module is deterministic and has no LLM involvement.
 */
export const CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type Currency = (typeof CURRENCIES)[number];

const MONEY_RE = /^\d{1,9}\.\d{2}$/;

export const isMoney = (s: unknown): s is string => typeof s === 'string' && MONEY_RE.test(s);

export function toCents(s: string): number {
  if (!isMoney(s)) throw new Error(`Invalid money string: ${JSON.stringify(s)} (expected e.g. "40.00")`);
  const [whole, frac] = s.split('.');
  return parseInt(whole, 10) * 100 + parseInt(frac, 10);
}

export function fromCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * SYNTHETIC exchange rates, used only for the policy-engine's optional
 * "convert_to_policy_currency" behaviour and for impact estimates.
 * They are NOT real market rates.
 */
export const SYNTHETIC_FX_TO_USD: Record<Currency, number> = { USD: 1, EUR: 1.08, GBP: 1.27 };

const isCurrency = (c: string): c is Currency => (CURRENCIES as readonly string[]).includes(c);

export function convertCents(cents: number, from: string, to: string): number {
  if (from === to) return cents;
  if (!isCurrency(from) || !isCurrency(to)) throw new Error(`Unsupported currency pair ${from}->${to}`);
  const usd = cents * SYNTHETIC_FX_TO_USD[from];
  return Math.round(usd / SYNTHETIC_FX_TO_USD[to]);
}

export const sumCents = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };
export const currencySymbol = (c: string): string => SYMBOL[c] ?? `${c} `;

export function formatMoney(cents: number, currency: string): string {
  return `${currencySymbol(currency)}${fromCents(cents)}`;
}
