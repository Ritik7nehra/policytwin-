import { PolicySchema, withDerivedAmbiguities, type Policy, type ProductTreatmentT } from './schema';
import { DIG, PHYS, SERV } from './scope';

/**
 * Deterministic reader: converts policy text into the structured schema using
 * explicit lexical rules. It is the offline fallback for the Policy Reader agent
 * and the "reference reading" the LLM output is guarded against (thresholds,
 * actions and exceptions that are explicit in the text must survive).
 */

const SYMBOL_TO_CCY: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };

interface MoneyMention {
  value: number;
  currency: string;
  index: number;
  end: number;
}

export function findMoney(text: string): MoneyMention[] {
  const re =
    /([$€£])\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(USD|EUR|GBP)\b|\b(USD|EUR|GBP)\s?(\d[\d,]*(?:\.\d{1,2})?)/g;
  const out: MoneyMention[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) out.push({ value: parseFloat(m[2].replace(/,/g, '')), currency: SYMBOL_TO_CCY[m[1]], index: m.index, end: m.index + m[0].length });
    else if (m[4]) out.push({ value: parseFloat(m[3].replace(/,/g, '')), currency: m[4], index: m.index, end: m.index + m[0].length });
    else out.push({ value: parseFloat(m[6].replace(/,/g, '')), currency: m[5], index: m.index, end: m.index + m[0].length });
  }
  return out;
}

const splitSentences = (t: string): string[] => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

const EVIDENCEISH = /\b(evidence|access|fulfil+ment|proof of (?:delivery|access))\b/i;
const REVIEWISH = /\b(review|exclud\w*|not eligible|ineligible|(?:do|does) not apply|excluded)\b/i;
const TRACKINGISH = /\btracking\b/i;

export interface ReadResult {
  policy: Policy;
  thresholdBoundaryUnclear: boolean;
}

export function readPolicyDetailed(text: string, name = 'Policy', triggerContext = ''): ReadResult {
  const t = text.replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();
  const sentences = splitSentences(t);

  // The claim type can come from the surrounding intake (policy name, current policy) when the new text omits it.
  const triggerText = `${lower} ${triggerContext.toLowerCase()}`;
  const trigger = /missing[- ]delivery|not (?:been )?delivered|never (?:arrived|received)|item[- ]not[- ]received|non[- ]delivery/.test(triggerText)
    ? 'missing_delivery_claim'
    : 'unrecognized';

  const auto =
    /\bautomatic(?:ally)?\b[^.]*\brefund|\brefund[^.]*\bautomatic(?:ally)?\b|auto[- ]?refund/.test(lower);
  const action: Policy['action'] = auto ? 'automatic_refund' : 'manual_review';

  // threshold
  const money = findMoney(t);
  const first = money[0];
  let maximum_amount: number | null = null;
  let currency: string | null = null;
  let inclusive = true;
  let boundaryUnclear = false;
  if (first && action === 'automatic_refund') {
    maximum_amount = first.value;
    currency = first.currency;
    const after = lower.slice(first.end, first.end + 24);
    const before = lower.slice(Math.max(0, first.index - 18), first.index);
    if (/^\s*(or less|or below|or under|or lower|maximum|max\b|and under|and below)/.test(after)) inclusive = true;
    else if (/(under|below|less than|lower than|fewer than)\s*(?:usd|eur|gbp)?\s*$/.test(before)) inclusive = false;
    else if (/(up to|at most|no more than|not exceeding|maximum of|max of|not more than)\s*$/.test(before)) inclusive = true;
    else boundaryUnclear = true;
  }

  const condition: Policy['condition'] =
    action === 'automatic_refund' &&
    /tracking[^.]*(unavailable|not available|missing|absent|not provided|unknown)|(?:without|no|lack of)\s+(?:valid\s+)?(?:shipment\s+|shipping\s+|delivery\s+)?tracking|tracking\s+(?:information\s+)?is\s+(?:not|un)/.test(
      lower,
    )
      ? 'tracking_unavailable'
      : 'always';

  // product scope, sentence by sentence
  const scope: Record<'physical' | 'digital' | 'service', ProductTreatmentT> = {
    physical: 'unspecified',
    digital: 'unspecified',
    service: 'unspecified',
  };
  if (action === 'automatic_refund') {
    for (const s of sentences) {
      const isP = PHYS.test(s);
      const isD = DIG.test(s);
      const isS = SERV.test(s) && !/customer service/i.test(s);
      if (!isP && !isD && !isS) continue;
      let treatment: ProductTreatmentT;
      if (EVIDENCEISH.test(s) && !(isP && !isD && !isS)) treatment = 'evidence_rule';
      else if (REVIEWISH.test(s) && !TRACKINGISH.test(s)) treatment = 'manual_review';
      else treatment = 'tracking_rule';
      if (isP) scope.physical = treatment;
      if (isD) scope.digital = treatment;
      if (isS) scope.service = treatment;
      // "physical goods only" / "only physical" → everything else to review
      if (/(physical (?:goods|products|items|orders)? ?only|only (?:for )?physical)/i.test(s) && !isD) {
        scope.digital = 'manual_review';
        scope.service = 'manual_review';
      }
    }
  }

  const currency_handling: Policy['currency_handling'] = /\bconvert(?:ed|s|ing)?\b|exchange rate|fx rate/.test(lower)
    ? 'convert_to_policy_currency'
    : /(other currenc|non-?usd|currency other than|only (?:usd|eur|gbp) transactions|(?:usd|eur|gbp) transactions only|outside (?:the )?(?:usd|eur|gbp))/.test(lower) &&
        /review|exclud|not eligible|out of scope|in scope/.test(lower)
      ? 'manual_review_other_currency'
      : 'unspecified';

  const dispute_handling: Policy['dispute_handling'] =
    /(open|active|pending|existing)\s+(?:payment\s+)?dispute|dispute\s+(?:is|has been|was)\s+(?:open|opened|filed)|dispute[^.]*\bopen\b/.test(lower) &&
    /review|exclud|not eligible|not refund|escalat|exempt/.test(lower)
      ? 'manual_review_if_open_dispute'
      : 'unspecified';

  const retry_handling: Policy['retry_handling'] =
    /idempoten|stable\s+(?:paypal-)?request[- ]?id|same logical request|retr(?:y|ied|ies)[^.]*(?:same|single|once|only one|idempot)|only one refund/.test(lower)
      ? 'idempotent_stable_request_id'
      : 'unspecified';

  const duplicate_event_handling: Policy['duplicate_event_handling'] = /duplicate\s+(?:webhook|event|deliver)|dedup|event[- ]id/.test(lower)
    ? 'dedupe_by_event_id'
    : 'unspecified';

  const exceptions = sentences.filter((s) => /\b(except|unless|excluding|excluded|exclude|exception|other than)\b/i.test(s));

  const base: Policy = {
    name,
    trigger,
    action,
    maximum_amount,
    threshold_inclusive: inclusive,
    currency,
    condition,
    product_scope: scope,
    currency_handling,
    dispute_handling,
    retry_handling,
    duplicate_event_handling,
    exceptions,
    ambiguities: [],
    ambiguity_codes: [],
  };
  const policy = PolicySchema.parse(withDerivedAmbiguities(base, { thresholdBoundaryUnclear: boundaryUnclear }));
  return { policy, thresholdBoundaryUnclear: boundaryUnclear };
}

export function readPolicyOffline(text: string, name = 'Policy', triggerContext = ''): Policy {
  return readPolicyDetailed(text, name, triggerContext).policy;
}
