import { z } from 'zod';
import { runAgent, type AgentCtx, type AgentDef } from './framework';
import { PolicySchema, withDerivedAmbiguities, type Policy } from '../policy/schema';
import { readPolicyDetailed } from '../policy/reader';
import { policyToText } from '../policy/text';
import { buildAdversarialPairs, buildCorePairs, rationaleFor, validateTwinPair } from '../twins/generator';
import { CAUSAL_CATALOG } from '../twins/catalog';
import { repairPolicyDeterministic, type RepairProposal } from '../analysis/repair';
import type { ImpactSummary } from '../analysis/impact';
import type { ImpactMap } from '../store/types';
import { CAUSAL_FIELDS, TEST_CATEGORIES, TxInputSchema, type PairResult, type TestCategory, type TwinPair } from '../types';
import { uniq } from '../util';

// ─────────────────────────── Agent 1: Policy Reader ───────────────────────────
// Extract conditions/thresholds/actions/exceptions, detect ambiguity, produce structured JSON.
// It never modifies or executes the policy.
export interface ReaderInput {
  name: string;
  text: string;
  context: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export const policyReaderDef: AgentDef<ReaderInput, Policy> = {
  name: 'policy_reader',
  schemaName: 'structured_policy',
  schema: PolicySchema,
  system:
    'You are the Policy Reader for an internal payments-policy testing tool. Convert the policy text into the given JSON schema. ' +
    'Extract ONLY what the text states. Use "unspecified" for any control the text does not address; never invent exceptions, thresholds or behaviour. ' +
    'List every ambiguity or missing exception you can see. You only read; you never execute or rewrite the policy.',
  user: (i) => `Policy name: ${i.name}\nContext (the claim type this policy governs): ${i.context}\n\nPolicy text:\n"""${i.text}"""`,
  fallback: (i) => readPolicyDetailed(i.text, i.name, i.context).policy,
  guard: (out, i) => {
    const det = readPolicyDetailed(i.text, i.name, i.context);
    const problems: string[] = [];
    const fixed: Policy = { ...out, name: i.name };
    // Explicit facts in the text must survive: threshold, currency, boundary, action, trigger.
    const explicit = ['maximum_amount', 'currency', 'threshold_inclusive', 'action'] as const;
    if (det.policy.maximum_amount !== null || det.policy.action === 'manual_review') {
      for (const k of explicit) {
        if (JSON.stringify(out[k]) !== JSON.stringify(det.policy[k])) {
          problems.push(`corrected ${k}: model said ${JSON.stringify(out[k])}, text says ${JSON.stringify(det.policy[k])}`);
          (fixed as any)[k] = det.policy[k];
        }
      }
    }
    if (det.policy.trigger !== 'unrecognized' && out.trigger !== det.policy.trigger) {
      problems.push(`corrected trigger to ${det.policy.trigger}`);
      fixed.trigger = det.policy.trigger;
    }
    // Exceptions must not be invented: each must appear in the source text.
    const src = norm(i.text);
    const exceptions = out.exceptions.filter((e) => src.includes(norm(e).replace(/[.]$/, '')) || norm(e).split(' ').filter((w) => w.length > 3).every((w) => src.includes(w)));
    if (exceptions.length !== out.exceptions.length) problems.push(`removed ${out.exceptions.length - exceptions.length} exception(s) not found in the source text`);
    // …and exceptions the code can see in the text cannot be hidden by the model either.
    const hidden = det.policy.exceptions.filter((d) => !exceptions.some((e) => norm(e) === norm(d)));
    if (hidden.length) problems.push(`restored ${hidden.length} exception(s) stated in the text that the model omitted`);
    fixed.exceptions = [...exceptions, ...hidden];
    // Ambiguity: the model may add some, but cannot hide the ones code can see.
    const final = withDerivedAmbiguities({ ...fixed, ambiguities: out.ambiguities }, { thresholdBoundaryUnclear: det.thresholdBoundaryUnclear });
    return { output: final, problems };
  },
};

// ─────────────────────────── Agent 2: Policy Impact Mapper ───────────────────────────
export const ImpactMapSchema = z.object({
  affected_resources: z.array(z.string()),
  affected_states: z.array(z.string()),
  affected_paypal_products: z.array(z.string()),
  required_tests: z.array(z.enum(TEST_CATEGORIES)),
  rationale: z.string(),
});

export function mapImpactOffline(p: Policy): ImpactMap {
  const auto = p.action === 'automatic_refund';
  const tests: TestCategory[] = auto ? ['product_type', 'duplicate_request', 'duplicate_webhook', 'dispute_state'] : [];
  if (auto && p.maximum_amount !== null) tests.unshift('amount_boundary');
  if (auto && p.currency) tests.push('currency_variation');
  if (auto && Object.values(p.product_scope).includes('evidence_rule')) tests.push('evidence_status');
  return {
    affected_resources: auto ? ['order', 'capture', 'refund', 'dispute', 'webhook_event'] : ['order', 'capture'],
    affected_states: auto ? ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] : ['COMPLETED'],
    affected_paypal_products: auto
      ? ['Orders API v2 (create, confirm, capture)', 'Payments API v2 (refunds, authorizations)', 'Webhooks (payment-state events)', 'Disputes (simulated state only in this prototype)']
      : ['Orders API v2'],
    required_tests: uniq(tests),
    rationale: auto
      ? 'An automatic refund moves money, so it must be tested for boundary amounts, product types, currencies, open disputes, retried requests and duplicate webhook deliveries.'
      : 'A manual-review policy moves no money automatically.',
  };
}

export const impactMapperDef: AgentDef<{ policy: Policy }, ImpactMap> = {
  name: 'policy_impact_mapper',
  schemaName: 'impact_map',
  schema: ImpactMapSchema as unknown as z.ZodType<ImpactMap>,
  system:
    'You map a structured payments policy to the PayPal resources, states and test categories it affects. ' +
    `Allowed test categories: ${TEST_CATEGORIES.join(', ')}. Be specific and brief.`,
  user: (i) => `Structured policy:\n${JSON.stringify(i.policy, null, 2)}`,
  fallback: (i) => mapImpactOffline(i.policy),
  guard: (out, i) => {
    const det = mapImpactOffline(i.policy);
    const missing = det.required_tests.filter((t) => !out.required_tests.includes(t));
    return { output: { ...out, required_tests: uniq([...out.required_tests, ...det.required_tests]) }, problems: missing.length ? [`added required test categories the model omitted: ${missing.join(', ')}`] : [] };
  },
};

// ─────────────────────────── Agents 3 & 4: Twin Generator / Adversarial ───────────────────────────
export const TwinProposalSchema = z.object({
  pairs: z.array(
    z.object({
      label: z.string(),
      changed_field: z.enum(CAUSAL_FIELDS),
      base: TxInputSchema,
      twin: TxInputSchema,
      rationale: z.string(),
    }),
  ),
});
export type TwinProposal = z.infer<typeof TwinProposalSchema>;

const proposalFrom = (pairs: TwinPair[]): TwinProposal => ({ pairs: pairs.map((p) => ({ label: p.label, changed_field: p.changed_field, base: p.base, twin: p.twin, rationale: p.rationale })) });

/** Validate LLM-proposed pairs: single causal change, valid fields, catalog-owned expectation. */
function guardPairs(out: TwinProposal, expected: TwinPair[], origin: TwinPair['origin']): { output: TwinProposal; problems: string[]; reject?: boolean } {
  const problems: string[] = [];
  const kept: TwinProposal['pairs'] = [];
  for (const p of out.pairs) {
    const issues = validateTwinPair(p);
    if (issues.length) {
      problems.push(`dropped "${p.label}": ${issues.join('; ')}`);
      continue;
    }
    const cites = rationaleFor(p.changed_field, p.base, p.twin);
    const mentionsFacts = p.rationale.includes(String(p.base[p.changed_field])) && p.rationale.includes(String(p.twin[p.changed_field]));
    if (!mentionsFacts) problems.push(`replaced rationale for "${p.label}" (it did not cite the changed values)`);
    kept.push({ ...p, rationale: mentionsFacts ? p.rationale : cites });
  }
  // Make sure every required causal variable is covered; fill gaps from the deterministic set.
  for (const e of expected) {
    if (!kept.some((k) => k.changed_field === e.changed_field)) {
      problems.push(`added missing ${e.changed_field} pair from the deterministic generator`);
      kept.push(proposalFrom([e]).pairs[0]);
    }
  }
  void origin;
  return { output: { pairs: kept }, problems };
}

const TWIN_SYSTEM =
  'You generate transaction twins for testing a payments policy. A twin pair is two transactions that are IDENTICAL except for exactly ONE field, ' +
  'which must be listed as changed_field. Keep claimed_amount, request_attempts and webhook_deliveries as they are unless that is the changed field. ' +
  'In each rationale, cite the concrete before/after values and explain why the field matters. Amounts are strings like "40.00".';

export const twinGeneratorDef: AgentDef<{ policy: Policy }, TwinProposal> = {
  name: 'transaction_twin_generator',
  schemaName: 'twin_pairs',
  schema: TwinProposalSchema,
  system: `${TWIN_SYSTEM} Produce the core pairs: product_type, amount (just below vs just above the policy threshold), currency, request_attempts (1 vs 2, with a partial claimed_amount), dispute_state, webhook_deliveries (1 vs 2, with a partial claimed_amount).`,
  user: (i) => `Structured policy under test:\n${JSON.stringify(i.policy, null, 2)}`,
  fallback: (i) => proposalFrom(buildCorePairs(i.policy)),
  guard: (out, i) => guardPairs(out, buildCorePairs(i.policy), 'core'),
};

export const adversarialDef: AgentDef<{ policy: Policy }, TwinProposal> = {
  name: 'adversarial_scenario_agent',
  schemaName: 'adversarial_twin_pairs',
  schema: TwinProposalSchema,
  system: `${TWIN_SYSTEM} You are the adversarial agent: try to break the policy. Produce: the exact threshold boundary (amount), digital goods with missing vs confirmed evidence (evidence_status), a hidden-dependency check (customer_history), and sale vs authorize-then-void (payment_flow).`,
  user: (i) => `Structured policy under test:\n${JSON.stringify(i.policy, null, 2)}`,
  fallback: (i) => proposalFrom(buildAdversarialPairs(i.policy)),
  guard: (out, i) => guardPairs(out, buildAdversarialPairs(i.policy), 'adversarial'),
};

/** Turn validated proposals into TwinPairs: ids assigned in order, expectation owned by the causal catalog. */
export function proposalsToPairs(core: TwinProposal, adversarial: TwinProposal | null): TwinPair[] {
  const pairs: TwinPair[] = [];
  const add = (origin: TwinPair['origin'], pr: TwinProposal) => {
    for (const p of pr.pairs) {
      const entry = CAUSAL_CATALOG[p.changed_field];
      pairs.push({
        id: `pair_${String(pairs.length + 1).padStart(2, '0')}`,
        label: p.label,
        origin,
        category: entry.category,
        changed_field: p.changed_field,
        base: p.base,
        twin: p.twin,
        expectation: entry.expectation,
        rationale: p.rationale,
        severity_if_violated: entry.severity_if_violated,
      });
    }
  };
  add('core', core);
  if (adversarial) add('adversarial', adversarial);
  return pairs;
}

// ─────────────────────────── Agent 5: Impact Analyst ───────────────────────────
export const ImpactNarrativeSchema = z.object({
  headline: z.string(),
  narrative: z.string(),
  affected_customer_types: z.array(z.string()),
  finding_explanations: z.array(z.object({ pair_id: z.string(), text: z.string() })),
});
export type ImpactNarrative = z.infer<typeof ImpactNarrativeSchema>;

export interface AnalystInput {
  results: PairResult[];
  pairs: Pick<TwinPair, 'id' | 'changed_field' | 'base' | 'twin'>[];
  impact: ImpactSummary;
  candidate_label: string;
}

const CUSTOMER_TYPES: Record<string, string> = {
  product_type: 'Buyers of digital goods and services',
  evidence_status: 'Buyers of digital goods and services',
  amount_boundary: 'Orders just above the automatic-refund threshold',
  currency_variation: 'Buyers paying in non-USD currencies',
  dispute_state: 'Buyers with an open dispute on the same order',
  duplicate_request: 'Merchants whose buyers or systems retry refund requests',
  duplicate_webhook: 'Merchants who receive redelivered webhooks',
  customer_history: 'New customers',
  void_authorization: 'Authorize-and-capture merchants',
};

export function analystFallback(i: AnalystInput): ImpactNarrative {
  const failed = i.results.filter((r) => r.severity !== 'none');
  const fmt = (n: number) => n.toLocaleString('en-US');
  const headline = failed.length
    ? `${fmt(i.impact.total_count)} potentially affected transactions (about $${fmt(i.impact.total_usd)}) in the synthetic impact model`
    : 'No failed scenarios, so no impact was estimated';
  const narrative = failed.length
    ? `${failed.length} of ${i.results.length} twin pairs behaved unexpectedly under ${i.candidate_label}. ` +
      i.impact.rows.map((r) => `${r.label}: ${fmt(r.count)} synthetic transactions (~$${fmt(r.usd)}).`).join(' ') +
      ` These figures come from the synthetic model only; they are not PayPal data.`
    : `All ${i.results.length} twin pairs behaved as expected under ${i.candidate_label}.`;
  return {
    headline,
    narrative,
    affected_customer_types: uniq(failed.map((r) => CUSTOMER_TYPES[r.category]).filter(Boolean)),
    finding_explanations: failed.map((r) => ({ pair_id: r.pair_id, text: r.explanation })),
  };
}

const FIGURE_RE = /\$?\d[\d,]*(?:\.\d+)?/g;

export const impactAnalystDef: AgentDef<AnalystInput, ImpactNarrative> = {
  name: 'impact_analyst',
  schemaName: 'impact_narrative',
  schema: ImpactNarrativeSchema,
  system:
    'You are the Impact Analyst. Write a short, management-friendly explanation of failed twin scenarios. ' +
    'Use ONLY the numbers provided in allowed_figures; never invent or estimate figures. Say that figures are synthetic. ' +
    'Keep observed facts (what the scenarios did) separate from assumptions (the synthetic model). For each finding, write a one-paragraph explanation that cites the changed field values.',
  user: (i) =>
    `Candidate: ${i.candidate_label}\nFailed pairs:\n${JSON.stringify(i.results.filter((r) => r.severity !== 'none').map((r) => ({ pair_id: r.pair_id, label: r.label, changed_field: r.changed_field, outcome: r.outcome, severity: r.severity, headline: r.headline })), null, 1)}\n` +
    `Synthetic impact rows:\n${JSON.stringify(i.impact.rows, null, 1)}\nallowed_figures: ${JSON.stringify(i.impact.allowed_figures)}`,
  fallback: analystFallback,
  guard: (out, i) => {
    const problems: string[] = [];
    // 1. No invented figures in the narrative.
    const allowed = new Set(i.impact.allowed_figures.map((f) => f.replace(/[$,]/g, '')));
    const known = new Set([...allowed, String(i.results.length), String(i.results.filter((r) => r.severity !== 'none').length)]);
    const bad = (`${out.headline} ${out.narrative}`.match(FIGURE_RE) ?? []).map((f) => f.replace(/[$,]/g, '')).filter((f) => f.length >= 2 && !known.has(f));
    if (bad.length) return { output: out, problems: [`narrative contained figures not in the synthetic model: ${bad.join(', ')}`], reject: true };
    // 2. Each finding explanation must cite the scenario facts it explains.
    const byId = new Map(i.pairs.map((p) => [p.id, p]));
    const det = analystFallback(i);
    const exps = i.results
      .filter((r) => r.severity !== 'none')
      .map((r) => {
        const p = byId.get(r.pair_id);
        const found = out.finding_explanations.find((e) => e.pair_id === r.pair_id);
        const cites = !!p && !!found && found.text.includes(String(p.base[p.changed_field])) && found.text.includes(String(p.twin[p.changed_field]));
        if (!cites) problems.push(`replaced explanation for ${r.pair_id} (did not cite changed values)`);
        return cites ? found! : det.finding_explanations.find((e) => e.pair_id === r.pair_id)!;
      });
    return { output: { ...out, finding_explanations: exps }, problems };
  },
};

// ─────────────────────────── Agent 6: Policy Repair ───────────────────────────
export const RepairSchema = z.object({
  policy: PolicySchema,
  changes: z.array(z.object({ field: z.string(), from: z.string(), to: z.string(), reason: z.string() })),
  rationale: z.string(),
});
type RepairOut = z.infer<typeof RepairSchema>;
export interface RepairInput {
  candidate: Policy;
  results: PairResult[];
}

export const policyRepairDef: AgentDef<RepairInput, RepairOut> = {
  name: 'policy_repair',
  schemaName: 'policy_repair',
  schema: RepairSchema,
  system:
    'You are the Policy Repair agent. Propose a corrected structured policy that preserves the original business objective ' +
    '(same action, threshold, currency, boundary and condition) and fills the missing exceptions/controls that the failed scenarios exposed. ' +
    'Prefer the conservative treatment (send to review). A human must approve your proposal; it will be re-tested before release.',
  user: (i) => `Candidate policy:\n${JSON.stringify(i.candidate, null, 2)}\n\nFailed pairs:\n${JSON.stringify(i.results.filter((r) => r.severity !== 'none').map((r) => ({ pair_id: r.pair_id, category: r.category, outcome: r.outcome, headline: r.headline })), null, 1)}`,
  fallback: (i) => {
    const r = repairPolicyDeterministic(i.candidate, i.results);
    return { policy: r.policy, changes: r.changes, rationale: r.rationale };
  },
  guard: (out, i) => {
    const c = i.candidate;
    const problems: string[] = [];
    for (const k of ['action', 'maximum_amount', 'currency', 'threshold_inclusive', 'condition', 'trigger'] as const) {
      if (JSON.stringify(out.policy[k]) !== JSON.stringify(c[k])) problems.push(`repair changed the business objective field ${k}`);
    }
    if (problems.length) return { output: out, problems, reject: true };
    const policy = withDerivedAmbiguities({ ...out.policy, name: 'Version C (corrected)' });
    return { output: { ...out, policy }, problems: [] };
  },
};

// ─────────────────────────── Typed wrappers ───────────────────────────
export const runPolicyReader = (ctx: AgentCtx, i: ReaderInput) => runAgent(ctx, policyReaderDef, i);
export const runImpactMapper = (ctx: AgentCtx, policy: Policy) => runAgent(ctx, impactMapperDef, { policy });
export const runTwinGenerator = (ctx: AgentCtx, policy: Policy) => runAgent(ctx, twinGeneratorDef, { policy });
export const runAdversarial = (ctx: AgentCtx, policy: Policy) => runAgent(ctx, adversarialDef, { policy });
export const runImpactAnalyst = (ctx: AgentCtx, i: AnalystInput) => runAgent(ctx, impactAnalystDef, i);

export async function runPolicyRepair(ctx: AgentCtx, i: RepairInput): Promise<{ proposal: RepairProposal; status: string; problems: string[] }> {
  const r = await runAgent(ctx, policyRepairDef, i);
  const policy = withDerivedAmbiguities({ ...r.output.policy, name: 'Version C (corrected)' });
  return {
    proposal: {
      policy,
      source_text: policyToText(policy), // the human approves exactly what the engine will execute
      changes: r.output.changes,
      rationale: r.output.rationale,
      generated_by: r.status === 'deterministic' || r.status.startsWith('fallback') ? 'deterministic' : 'llm',
    },
    status: r.status,
    problems: r.problems,
  };
}
