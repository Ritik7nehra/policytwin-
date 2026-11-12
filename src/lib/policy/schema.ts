import { z } from 'zod';
import { DIG, PHYS, SERV } from './scope';

/**
 * Structured policy schema. This is what the Policy Reader agent produces and what
 * the deterministic engine executes. The LLM never executes policy text directly:
 * its output must validate against this schema first.
 *
 * Fields follow the spec's flat shape (trigger / maximum_amount / currency /
 * condition / action / exceptions / ambiguities) plus explicit "control" fields
 * that say how the policy handles the situations where policies usually break.
 * `unspecified` means the source text is silent — which is precisely what
 * PolicyTwin is designed to surface.
 */
/** Order-preserving de-duplication (kept local so this module stays free of Node-only imports and can run in the browser). */
const uniq = <T,>(a: T[]): T[] => [...new Set(a)];

export const AMBIGUITY_CODES = [
  'PRODUCT_SCOPE',
  'SERVICE_EVIDENCE',
  'CURRENCY_CONVERSION',
  'DISPUTE_STATE',
  'RETRY_BEHAVIOR',
  'DUPLICATE_EVENTS',
  'THRESHOLD_BOUNDARY',
  'UNSUPPORTED_TRIGGER',
  'NO_CONDITION',
  'UNMODELED_EXCEPTION',
] as const;
export type AmbiguityCode = (typeof AMBIGUITY_CODES)[number];

export const AMBIGUITY_TEXT: Record<AmbiguityCode, string> = {
  PRODUCT_SCOPE: 'The policy does not distinguish physical and digital products',
  SERVICE_EVIDENCE: 'The policy does not define equivalent evidence for services',
  CURRENCY_CONVERSION: 'The policy does not explain currency conversion',
  DISPUTE_STATE: 'The policy does not say what happens when a dispute is already open',
  RETRY_BEHAVIOR: 'The policy does not define behavior for retried refund requests',
  DUPLICATE_EVENTS: 'The policy does not define handling of duplicate webhook deliveries',
  THRESHOLD_BOUNDARY: 'The policy does not say whether the amount threshold itself is included',
  UNSUPPORTED_TRIGGER: 'The policy trigger is not a missing-delivery claim, which is the only trigger this prototype can execute',
  NO_CONDITION: 'The automatic refund has no evidence condition',
  UNMODELED_EXCEPTION: 'The policy states an exception that PolicyTwin cannot execute or test, so it is not verified',
};

export const ProductTreatment = z.enum(['tracking_rule', 'evidence_rule', 'manual_review', 'unspecified']);
export type ProductTreatmentT = z.infer<typeof ProductTreatment>;

export const PolicySchema = z.object({
  name: z.string(),
  trigger: z.string(),
  action: z.enum(['automatic_refund', 'manual_review']),
  maximum_amount: z.number().positive().nullable(),
  threshold_inclusive: z.boolean(),
  currency: z.string().nullable(),
  condition: z.enum(['always', 'tracking_unavailable']),
  product_scope: z.object({
    physical: ProductTreatment,
    digital: ProductTreatment,
    service: ProductTreatment,
  }),
  currency_handling: z.enum(['unspecified', 'manual_review_other_currency', 'convert_to_policy_currency']),
  dispute_handling: z.enum(['unspecified', 'manual_review_if_open_dispute']),
  retry_handling: z.enum(['unspecified', 'idempotent_stable_request_id']),
  duplicate_event_handling: z.enum(['unspecified', 'dedupe_by_event_id']),
  exceptions: z.array(z.string()),
  ambiguities: z.array(z.string()),
  ambiguity_codes: z.array(z.enum(AMBIGUITY_CODES)),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Version A in the demo: every claim goes to a human. */
export function manualReviewPolicy(name: string): Policy {
  return {
    name,
    trigger: 'missing_delivery_claim',
    action: 'manual_review',
    maximum_amount: null,
    threshold_inclusive: true,
    currency: null,
    condition: 'always',
    product_scope: { physical: 'unspecified', digital: 'unspecified', service: 'unspecified' },
    currency_handling: 'unspecified',
    dispute_handling: 'unspecified',
    retry_handling: 'unspecified',
    duplicate_event_handling: 'unspecified',
    exceptions: [],
    ambiguities: [],
    ambiguity_codes: [],
  };
}

/**
 * Exception sentences the deterministic engine does NOT execute. The only exceptions it models are
 * product-class exclusions that the reader turned into a `manual_review` product scope. Anything else
 * ("…except for new customers", "…unless the buyer is a business account") is recorded but never
 * enforced — so it must never be silently treated as tested (see decideRelease: caveats force REVIEW).
 */
export function unmodeledExceptions(p: Policy): string[] {
  if (p.action === 'manual_review') return [];
  const modelled = (s: string): boolean => {
    const classes = (['physical', 'digital', 'service'] as const).filter((k) => ({ physical: PHYS, digital: DIG, service: SERV })[k].test(s));
    // A pure exclusion sentence: names product classes, and every named class is routed to manual review.
    return classes.length > 0 && classes.every((k) => p.product_scope[k] === 'manual_review') && !/\b(unless|except for|other than)\b/i.test(s);
  };
  return p.exceptions.filter((s) => !modelled(s));
}

/**
 * Deterministically derive which ambiguities a structured policy still has.
 * Used by the reader (so ambiguity lists are consistent) and as a guard on LLM output
 * (the LLM can add ambiguities, but it cannot hide ones the code can see).
 */
export function deriveAmbiguityCodes(p: Policy, opts: { thresholdBoundaryUnclear?: boolean } = {}): AmbiguityCode[] {
  const out: AmbiguityCode[] = [];
  if (p.trigger !== 'missing_delivery_claim') out.push('UNSUPPORTED_TRIGGER');
  if (p.action === 'manual_review') return out; // nothing automatic to be ambiguous about
  if (p.product_scope.digital === 'unspecified') out.push('PRODUCT_SCOPE');
  if (p.product_scope.service === 'unspecified') out.push('SERVICE_EVIDENCE');
  if (p.currency !== null && p.currency_handling === 'unspecified') out.push('CURRENCY_CONVERSION');
  if (p.dispute_handling === 'unspecified') out.push('DISPUTE_STATE');
  if (p.retry_handling === 'unspecified') out.push('RETRY_BEHAVIOR');
  if (p.duplicate_event_handling === 'unspecified') out.push('DUPLICATE_EVENTS');
  if (p.maximum_amount !== null && opts.thresholdBoundaryUnclear) out.push('THRESHOLD_BOUNDARY');
  if (p.condition === 'always') out.push('NO_CONDITION');
  if (unmodeledExceptions(p).length) out.push('UNMODELED_EXCEPTION');
  return uniq(out);
}

export function ambiguityTexts(codes: AmbiguityCode[]): string[] {
  return codes.map((c) => AMBIGUITY_TEXT[c]);
}

/** Fill `ambiguities`/`ambiguity_codes` from code-derived facts, keeping any extra LLM-found text. */
export function withDerivedAmbiguities(p: Policy, opts: { thresholdBoundaryUnclear?: boolean } = {}): Policy {
  const codes = deriveAmbiguityCodes(p, opts);
  const known = new Set(Object.values(AMBIGUITY_TEXT));
  const extraText = p.ambiguities.filter((t) => !known.has(t));
  return { ...p, ambiguity_codes: codes, ambiguities: [...ambiguityTexts(codes), ...extraText] };
}
