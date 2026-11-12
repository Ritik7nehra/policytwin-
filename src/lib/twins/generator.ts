import { CURRENCIES, fromCents, type Currency, toCents } from '../money';
import { CAUSAL_FIELDS, TX_FIELDS, TxInputSchema, type CausalField, type TwinPair, type TxInput } from '../types';
import type { Policy } from '../policy/schema';
import { CAUSAL_CATALOG } from './catalog';

/** Default transaction: a $40 physical order with no tracking, no dispute, one request, one delivery. */
export function baseTx(policy: Policy, overrides: Partial<TxInput> = {}): TxInput {
  const currency: Currency = (CURRENCIES as readonly string[]).includes(policy.currency ?? '') ? (policy.currency as Currency) : 'USD';
  const capCents = policy.maximum_amount !== null ? Math.round(policy.maximum_amount * 100) : 5000;
  const wholeDollarsBelowCap = Math.floor((capCents * 0.8) / 100) * 100;
  const amountCents = Math.max(100, Math.min(4000, wholeDollarsBelowCap));
  return {
    amount: fromCents(amountCents),
    currency,
    product_type: 'physical',
    tracking_available: false,
    evidence_status: 'missing',
    dispute_state: 'none',
    customer_history: 'existing',
    claimed_amount: null,
    request_attempts: 1,
    webhook_deliveries: 1,
    payment_flow: 'sale',
    ...overrides,
  };
}

/** Which TxInput fields differ between two transactions. */
export function diffFields(a: TxInput, b: TxInput): (keyof TxInput)[] {
  return TX_FIELDS.filter((k) => a[k] !== b[k]);
}

/** Returns a list of problems; empty means the pair is a valid single-variable twin. */
export function validateTwinPair(pair: Pick<TwinPair, 'base' | 'twin' | 'changed_field'>): string[] {
  const problems: string[] = [];
  for (const [name, tx] of [['base', pair.base], ['twin', pair.twin]] as const) {
    const parsed = TxInputSchema.safeParse(tx);
    if (!parsed.success) problems.push(`${name} is not a valid transaction: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  if (!(CAUSAL_FIELDS as readonly string[]).includes(pair.changed_field)) {
    problems.push(`changed_field "${pair.changed_field}" is not a permitted causal variable`);
    return problems;
  }
  const diff = diffFields(pair.base, pair.twin);
  if (diff.length !== 1) problems.push(`a twin pair must change exactly one field, but ${diff.length} differ: [${diff.join(', ')}]`);
  else if (diff[0] !== pair.changed_field) problems.push(`declared changed_field "${pair.changed_field}" but "${diff[0]}" actually changed`);
  return problems;
}

export function assertSingleCausalChange(pair: Pick<TwinPair, 'base' | 'twin' | 'changed_field'>): void {
  const problems = validateTwinPair(pair);
  if (problems.length) throw new Error(problems.join(' | '));
}

/** Rationale text that cites the concrete scenario facts (tested by the evals). */
export function rationaleFor(field: CausalField, base: TxInput, twin: TxInput): string {
  const held = `other facts held constant (${base.amount} ${base.currency}, tracking_available=${base.tracking_available})`;
  return `Only ${field} changes: ${String(base[field])} → ${String(twin[field])}; ${held}. ${CAUSAL_CATALOG[field].why}`;
}

function makePair(id: string, origin: TwinPair['origin'], label: string, field: CausalField, base: TxInput, twin: TxInput): TwinPair {
  const entry = CAUSAL_CATALOG[field];
  const pair: TwinPair = {
    id,
    label,
    origin,
    category: entry.category,
    changed_field: field,
    base,
    twin,
    expectation: entry.expectation,
    rationale: rationaleFor(field, base, twin),
    severity_if_violated: entry.severity_if_violated,
  };
  assertSingleCausalChange(pair);
  return pair;
}

const half = (amount: string): string => fromCents(Math.floor(toCents(amount) / 2));

/** The six core twin pairs from the spec, built around the policy's own threshold. */
export function buildCorePairs(policy: Policy): TwinPair[] {
  const base = baseTx(policy);
  const capCents = policy.maximum_amount !== null ? Math.round(policy.maximum_amount * 100) : 5000;
  const below = fromCents(Math.max(1, capCents - 1));
  const above = fromCents(capCents + 1);
  const otherCurrency = CURRENCIES.find((c) => c !== base.currency)!;
  const partial = half(base.amount);

  return [
    makePair('pair_01', 'core', 'Physical vs digital product', 'product_type', base, { ...base, product_type: 'digital' }),
    makePair('pair_02', 'core', `${below} vs ${above} (threshold)`, 'amount', { ...base, amount: below }, { ...base, amount: above }),
    makePair('pair_03', 'core', `${base.currency} vs ${otherCurrency}`, 'currency', base, { ...base, currency: otherCurrency }),
    makePair('pair_04', 'core', 'First refund request vs retried request', 'request_attempts', { ...base, claimed_amount: partial }, { ...base, claimed_amount: partial, request_attempts: 2 }),
    makePair('pair_05', 'core', 'No dispute vs open dispute', 'dispute_state', base, { ...base, dispute_state: 'open' }),
    makePair('pair_06', 'core', 'Normal webhook vs duplicate webhook', 'webhook_deliveries', { ...base, claimed_amount: partial }, { ...base, claimed_amount: partial, webhook_deliveries: 2 }),
  ];
}

/** Adversarial extras: exact boundary, evidence status, hidden dependencies, void-then-capture. */
export function buildAdversarialPairs(policy: Policy, startIndex = 7): TwinPair[] {
  const base = baseTx(policy);
  const capCents = policy.maximum_amount !== null ? Math.round(policy.maximum_amount * 100) : 5000;
  // Straddle the exact boundary the way the policy defines it: inclusive → (cap, cap+1¢); exclusive → (cap-1¢, cap).
  const [lo, hi] = policy.threshold_inclusive ? [capCents, capCents + 1] : [capCents - 1, capCents];
  const digital = baseTx(policy, { product_type: 'digital' });
  const id = (n: number) => `pair_${String(startIndex + n).padStart(2, '0')}`;
  return [
    makePair(id(0), 'adversarial', `Exact boundary ${fromCents(lo)} vs ${fromCents(hi)}`, 'amount', { ...base, amount: fromCents(lo) }, { ...base, amount: fromCents(hi) }),
    makePair(id(1), 'adversarial', 'Digital: evidence missing vs confirms non-delivery', 'evidence_status', digital, { ...digital, evidence_status: 'confirms_non_delivery' }),
    makePair(id(2), 'adversarial', 'Existing vs new customer', 'customer_history', base, { ...base, customer_history: 'new' }),
    makePair(id(3), 'adversarial', 'Sale vs authorize → void → capture attempt', 'payment_flow', base, { ...base, payment_flow: 'authorize_then_void' }),
  ];
}

export function buildAllPairs(policy: Policy, opts: { adversarial?: boolean } = {}): TwinPair[] {
  const core = buildCorePairs(policy);
  return opts.adversarial === false ? core : [...core, ...buildAdversarialPairs(policy, core.length + 1)];
}
