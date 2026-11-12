import type { PayPalAdapter } from './paypal/types';
import type { LlmClient } from './agents/llm';
import type { AgentCtx } from './agents/framework';
import type { Store, PolicyRow, PolicyVersionRow, TestRunRow, ScenarioRow, DecisionRow, ExecutionRow, InvariantRow, AgentRunRow, AuditRow, RunStageRow, RunStage } from './store/types';
import { unmodeledExceptions, type Policy } from './policy/schema';
import type { PolicyIntake } from './policy/demo';
import type { ImpactSummary } from './analysis/impact';
import type { RepairProposal } from './analysis/repair';
import type { ImpactNarrative } from './agents/roles';
import { evaluatePolicy } from './policy/engine';
import { readPolicyOffline } from './policy/reader';
import { assertSingleCausalChange } from './twins/generator';
import { executeScenario } from './runner/execute';
import { checkInvariants } from './analysis/invariants';
import { classifyPair, type ScenarioEval } from './analysis/classify';
import { computeCoverage, decideRelease } from './analysis/release';
import { estimateImpact } from './analysis/impact';
import {
  proposalsToPairs,
  runAdversarial,
  runImpactAnalyst,
  runImpactMapper,
  runPolicyReader,
  runPolicyRepair,
  runTwinGenerator,
} from './agents/roles';
import type {
  Coverage,
  ExecutionTrace,
  InvariantResult,
  PairResult,
  ReleaseDecision,
  RuntimeInfo,
  TestCategory,
  TwinPair,
  TxInput,
} from './types';
import { nowIso, sha256, shortId } from './util';
import { SimulatedPayPal } from './paypal/simulated';
import { runStage, stageRank, systemClock, withLease, stageRows, type StageClock } from './runner/stages';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { isUniqueViolation } from './store/errors';
import { sanitizeFinancialEvidence } from './security/sanitize';
import type { Limits } from './security/guard';

export interface Ctx {
  store: Store;
  /** Lane 2 + webhooks: the real PayPal Sandbox when credentials are configured, otherwise the simulator. */
  adapter: PayPalAdapter;
  llm: LlmClient;
  /** Lane 1 factory (default: a fresh SimulatedPayPal per run). */
  shadow?: () => PayPalAdapter;
  limits?: Limits;
  /** Injectable clock for lease handling in tests. */
  clock?: StageClock;
}

export interface HumanDecision {
  decision: 'approve' | 'reject';
  actor: string;
  note: string;
  at: string;
  release_at_decision: string;
}

export interface RunReport {
  candidate_label: string;
  pair_results: PairResult[];
  release: ReleaseDecision;
  impact: ImpactSummary;
  narrative: ImpactNarrative;
  repair: (RepairProposal & { version_id: string; status: 'proposed' | 'approved'; text_matches_structure: boolean }) | null;
  human_decision: HumanDecision | null;
  rerun_of: string | null;
  superseded_by: string | null;
  /** Lane 1 always executes on the simulator ('simulated'). Sandbox evidence is attached per pair (see RunBundle.sandbox_proofs). */
  executed_mode: 'simulated' | 'sandbox';
  ai: { mode: string; model: string };
  generated_at: string;
}

export const DEFAULT_ACTOR = 'policy.analyst (demo user)';
export const DEFAULT_OWNER = 'local';

export function describeRuntime(ctx: Ctx): RuntimeInfo {
  return {
    paypal_mode: ctx.adapter.mode,
    paypal_label: ctx.adapter.label,
    ai_mode: ctx.llm.mode,
    ai_model: ctx.llm.model,
    db_mode: ctx.store.mode,
    lane1_mode: 'simulated',
    lane2_mode: ctx.adapter.mode,
    lane2_label: ctx.adapter.label,
  };
}

/** Audit trail rows are sanitized like every other piece of financial evidence. */
async function audit(store: Store, runId: string | null, eventType: string, actor: string, payload: unknown): Promise<void> {
  const safe = sanitizeFinancialEvidence(payload);
  await store.insert('audit_events', {
    id: shortId('aud'),
    test_run_id: runId,
    event_type: eventType,
    actor,
    payload_hash: sha256(safe),
    payload_json: safe,
    created_at: nowIso(),
  });
}

/** AI budget: LLM-backed agent calls per UTC day (soft cap — concurrent calls may overshoot by a few). */
function allowLlmFor(ctx: Ctx): (() => Promise<boolean>) | undefined {
  const cap = ctx.limits?.aiCallsPerDay;
  if (ctx.llm.mode === 'deterministic' || cap === undefined) return undefined;
  return async () => {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const today = await ctx.store.list('agent_runs', { created_at: { gte: day.toISOString() } });
    return today.filter((r) => r.status !== 'deterministic' && r.status !== 'fallback_quota').length < cap;
  };
}

const agentCtx = (ctx: Ctx, runId: string | null): AgentCtx => ({ store: ctx.store, llm: ctx.llm, runId, allowLlm: allowLlmFor(ctx) });
const need = <T>(v: T | null | undefined, what: string): T => {
  if (v == null) throw new NotFoundError(what);
  return v;
};
const clockOf = (ctx: Ctx) => ctx.clock ?? systemClock;

// ───────────────────────── Step 1: policy intake ─────────────────────────
export async function createPolicy(ctx: Ctx, input: PolicyIntake, createdBy = DEFAULT_ACTOR, ownerSession = DEFAULT_OWNER, opts: { id?: string } = {}) {
  for (const k of ['name', 'current_policy', 'proposed_policy'] as const) {
    if (!input[k] || !String(input[k]).trim()) throw new ValidationError(`${k} is required`, [{ path: k, message: 'is required' }]);
  }
  const now = nowIso();
  const policy: PolicyRow = { id: opts.id ?? shortId('pol'), name: input.name.trim(), description: input.business_reason ?? '', created_by: createdBy, owner_session: ownerSession, created_at: now, intake_json: input };
  const mk = (version: number, label: 'A' | 'B', text: string, status: PolicyVersionRow['status']): PolicyVersionRow => ({
    id: shortId('ver'),
    policy_id: policy.id,
    version,
    label,
    source_text: text.trim(),
    structured_policy_json: null,
    analysis_json: null,
    status,
    created_at: now,
  });
  const version_a = mk(1, 'A', input.current_policy, 'current');
  const version_b = mk(2, 'B', input.proposed_policy, 'proposed');
  // One transaction: the policy and both versions exist together or not at all.
  await ctx.store.transaction(async (tx) => {
    await tx.insert('policies', policy);
    await tx.insert('policy_versions', version_a);
    await tx.insert('policy_versions', version_b);
    await audit(tx, null, 'policy_created', createdBy, { policy_id: policy.id, name: policy.name });
  });
  return { policy, version_a, version_b };
}

export async function addVersion(ctx: Ctx, policyId: string, a: { source_text: string; label?: 'A' | 'B' | 'C'; status?: PolicyVersionRow['status'] }, actor = DEFAULT_ACTOR): Promise<PolicyVersionRow> {
  need(await ctx.store.get('policies', policyId), 'policy');
  if (!a.source_text?.trim()) throw new ValidationError('source_text is required', [{ path: 'source_text', message: 'is required' }]);
  // UNIQUE (policy_id, version) makes the number race-safe: on a collision, recompute and retry.
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.store.transaction(async (tx) => {
        const existing = await tx.list('policy_versions', { policy_id: policyId });
        const row: PolicyVersionRow = {
          id: shortId('ver'),
          policy_id: policyId,
          version: Math.max(0, ...existing.map((v) => v.version)) + 1,
          label: a.label ?? 'C',
          source_text: a.source_text.trim(),
          structured_policy_json: null,
          analysis_json: null,
          status: a.status ?? 'proposed',
          created_at: nowIso(),
        };
        await tx.insert('policy_versions', row);
        await audit(tx, null, 'policy_version_added', actor, { version_id: row.id, label: row.label });
        return row;
      });
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= 4) throw e;
    }
  }
}

// ───────────────────────── Step 2: structured logic ─────────────────────────
async function ensureAnalysis(ctx: Ctx, policy: PolicyRow, v: PolicyVersionRow, runId: string | null): Promise<PolicyVersionRow> {
  let cur = v;
  if (!cur.structured_policy_json) {
    const r = await runPolicyReader(agentCtx(ctx, runId), { name: `Version ${cur.label}`, text: cur.source_text, context: `${policy.name}. ${policy.intake_json.current_policy}` });
    cur = await ctx.store.update('policy_versions', cur.id, { structured_policy_json: r.output });
  }
  if (!cur.analysis_json) {
    const m = await runImpactMapper(agentCtx(ctx, runId), cur.structured_policy_json!);
    cur = await ctx.store.update('policy_versions', cur.id, { analysis_json: m.output });
  }
  return cur;
}

export async function analyzePolicy(ctx: Ctx, policyId: string, actor = 'agent:policy_reader'): Promise<PolicyVersionRow[]> {
  const policy = need(await ctx.store.get('policies', policyId), 'policy');
  const versions = await ctx.store.list('policy_versions', { policy_id: policyId });
  const out: PolicyVersionRow[] = [];
  for (const v of versions) out.push(await ensureAnalysis(ctx, policy, v, null));
  await audit(ctx.store, null, 'policy_analyzed', actor, { policy_id: policyId, versions: out.map((v) => v.label) });
  return out;
}

// ───────────────────────── Test runs ─────────────────────────
export async function createTestRun(
  ctx: Ctx,
  a: { policy_id: string; version_a_id: string; version_b_id: string; parent_run_id?: string | null; adversarial?: boolean; created_by?: string },
): Promise<TestRunRow> {
  const policy = need(await ctx.store.get('policies', a.policy_id), 'policy');
  for (const id of [a.version_a_id, a.version_b_id]) {
    const v = need(await ctx.store.get('policy_versions', id), `policy version ${id}`);
    if (v.policy_id !== policy.id) throw new ValidationError(`policy version ${id} does not belong to policy ${policy.id}`);
    await ensureAnalysis(ctx, policy, v, null);
  }
  return ctx.store.transaction((tx) => insertRun(tx, policy, a));
}

async function insertRun(tx: Store, policy: PolicyRow, a: { version_a_id: string; version_b_id: string; parent_run_id?: string | null; adversarial?: boolean; created_by?: string }): Promise<TestRunRow> {
  const run: TestRunRow = {
    id: shortId('run'),
    policy_id: policy.id,
    policy_version_a: a.version_a_id,
    policy_version_b: a.version_b_id,
    parent_run_id: a.parent_run_id ?? null,
    status: 'created',
    stage: 'CREATED',
    rev: 0,
    locked_until: null,
    failed_stage: null,
    last_error: null,
    release_decision: null,
    started_at: nowIso(),
    completed_at: null,
    created_by: a.created_by ?? DEFAULT_ACTOR,
    owner_session: policy.owner_session,
    options_json: { adversarial: a.adversarial ?? true },
    report_json: null,
  };
  await tx.insert('test_runs', run);
  await audit(tx, run.id, 'test_run_created', run.created_by, { policy_version_a: run.policy_version_a, policy_version_b: run.policy_version_b, parent_run_id: run.parent_run_id });
  return run;
}

interface Loaded {
  run: TestRunRow;
  policy: PolicyRow;
  verA: PolicyVersionRow;
  verB: PolicyVersionRow;
  A: Policy;
  cand: Policy;
}

async function load(ctx: Ctx, runId: string): Promise<Loaded> {
  const run = need(await ctx.store.get('test_runs', runId), 'test run');
  const policy = need(await ctx.store.get('policies', run.policy_id), 'policy');
  const verA = need(await ctx.store.get('policy_versions', run.policy_version_a), 'version A');
  const verB = need(await ctx.store.get('policy_versions', run.policy_version_b), 'candidate version');
  if (!verA.structured_policy_json || !verB.structured_policy_json) throw new ConflictError('policy versions have not been analyzed yet');
  return { run, policy, verA, verB, A: verA.structured_policy_json, cand: verB.structured_policy_json };
}

const scenarioId = (runId: string, n: number) => `${runId}-scenario_${String(n).padStart(2, '0')}`;
const scenarioKey = (n: number) => `scenario_${String(n).padStart(2, '0')}`;

function pairsFromScenarios(rows: ScenarioRow[]): TwinPair[] {
  const byPair = new Map<string, ScenarioRow[]>();
  for (const r of rows) byPair.set(r.pair_id, [...(byPair.get(r.pair_id) ?? []), r]);
  return [...byPair.entries()].map(([id, rs]) => {
    const base = rs.find((r) => r.scenario_type === 'base')!;
    const twin = rs.find((r) => r.scenario_type === 'twin')!;
    return {
      id,
      label: base.meta_json.label,
      origin: base.meta_json.origin,
      category: base.meta_json.category as TestCategory,
      changed_field: base.changed_field as TwinPair['changed_field'],
      base: base.input_json,
      twin: twin.input_json,
      expectation: base.expected_behavior as TwinPair['expectation'],
      rationale: base.meta_json.rationale,
      severity_if_violated: base.meta_json.severity_if_violated as TwinPair['severity_if_violated'],
    };
  });
}

// ───────────────────────── Step 3: twins ─────────────────────────
/** Idempotent + resumable: a repeat call returns the stored pairs; a failed attempt can simply be called again. */
export async function generateTwins(ctx: Ctx, runId: string, actor = 'agent:transaction_twin_generator'): Promise<TwinPair[]> {
  void actor;
  return runStage(ctx.store, runId, 'GENERATE_TWINS', {
    clock: clockOf(ctx),
    alreadyDone: async () => pairsFromScenarios(await ctx.store.list('scenarios', { test_run_id: runId })),
    work: async () => {
      const { run, cand } = await load(ctx, runId);
      const ac = agentCtx(ctx, runId);
      const core = await runTwinGenerator(ac, cand);
      const adv = run.options_json.adversarial ? await runAdversarial(ac, cand) : null;
      const pairs = proposalsToPairs(core.output, adv?.output ?? null);
      for (const p of pairs) assertSingleCausalChange(p); // defence in depth: exactly one causal variable changes
      const rows: ScenarioRow[] = [];
      let n = 0;
      for (const p of pairs) {
        for (const [type, tx] of [['base', p.base], ['twin', p.twin]] as const) {
          n++;
          rows.push({
            id: scenarioId(runId, n),
            test_run_id: runId,
            pair_id: p.id,
            scenario_type: type,
            scenario_key: scenarioKey(n),
            input_json: tx,
            changed_field: p.changed_field,
            expected_behavior: p.expectation,
            meta_json: { label: p.label, origin: p.origin, category: p.category, rationale: p.rationale, severity_if_violated: p.severity_if_violated },
          });
        }
      }
      return async (tx) => {
        await tx.insertMany('scenarios', rows);
        await audit(tx, runId, 'twins_generated', 'agent:transaction_twin_generator', { pairs: pairs.length, scenarios: rows.length });
        return pairs;
      };
    },
  });
}

// ───────────────────────── Step 4: evaluate old vs new policy ─────────────────────────
export async function evaluateRun(ctx: Ctx, runId: string): Promise<DecisionRow[]> {
  return runStage(ctx.store, runId, 'EVALUATE', {
    clock: clockOf(ctx),
    alreadyDone: () => ctx.store.list('policy_decisions', { test_run_id: runId }),
    work: async () => {
      const { verA, verB, A, cand } = await load(ctx, runId);
      const scenarios = await ctx.store.list('scenarios', { test_run_id: runId });
      if (!scenarios.length) throw new ConflictError('no scenarios: generate twins first');
      const rows: DecisionRow[] = [];
      for (const s of scenarios) {
        for (const [label, pol] of [[verA.label, A], [verB.label, cand]] as const) {
          const d = evaluatePolicy(pol, s.input_json);
          rows.push({
            id: shortId('dec'),
            test_run_id: runId,
            scenario_id: s.id,
            policy_version: label,
            decision: d.decision,
            reason_codes: d.reason_codes,
            explanation: d.explanation,
            detail_json: { flags: d.flags, conditions_triggered: d.conditions_triggered, refund_amount: d.refund_amount },
          });
        }
      }
      return async (tx) => {
        await tx.insertMany('policy_decisions', rows);
        await audit(tx, runId, 'policies_evaluated', 'engine:deterministic', { scenarios: scenarios.length, decisions: rows.length });
        return rows;
      };
    },
  });
}

// ───────────────────────── Steps 5–8: execute, verify, impact, release ─────────────────────────
const sameControls = (a: Policy, b: Policy) =>
  (['action', 'maximum_amount', 'threshold_inclusive', 'currency', 'condition', 'currency_handling', 'dispute_handling', 'retry_handling', 'duplicate_event_handling'] as const).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k])) &&
  JSON.stringify(a.product_scope) === JSON.stringify(b.product_scope);

const emptyTrace = (id: string, decision: ExecutionTrace['decision'], tx: TxInput): ExecutionTrace => ({
  scenario_id: id,
  decision,
  capture: null,
  authorization: null,
  capture_attempts_after_void: [],
  refunds: [],
  refund_attempts: [],
  webhook_deliveries: [],
  state_history: [],
  canonical_capture_status: null,
  dispute_open: tx.dispute_state === 'open',
});

function invariantRows(runId: string, scenarioId: string, label: string, lane: InvariantRow['lane'], invariants: InvariantResult[]): InvariantRow[] {
  return invariants.map((i) => ({
    id: shortId('inv'),
    test_run_id: runId,
    scenario_id: scenarioId,
    policy_version: label,
    invariant_code: i.code,
    lane,
    passed: i.passed,
    severity: i.severity,
    evidence_json: sanitizeFinancialEvidence({ name: i.name, applicable: i.applicable, detail: i.detail, evidence: i.evidence }) as InvariantRow['evidence_json'],
  }));
}

/**
 * LANE 1 — the full shadow-policy run. All scenarios execute on the deterministic engine + the SIMULATED payment
 * adapter, every invariant is checked and the complete impact analysis is produced. Fast, repeatable, free.
 * Real PayPal Sandbox proof is a separate, targeted step: verifyPairInSandbox (LANE 2).
 */
export async function executeRun(ctx: Ctx, runId: string): Promise<RunReport> {
  return runStage(ctx.store, runId, 'EXECUTE', {
    clock: clockOf(ctx),
    alreadyDone: async (run) => need(run.report_json as RunReport | null, 'report'),
    work: async () => {
      const { run, policy, verB, A, cand } = await load(ctx, runId);
      const scenarios = (await ctx.store.list('scenarios', { test_run_id: runId })).sort((x, y) => x.scenario_key.localeCompare(y.scenario_key));
      if (!scenarios.length) throw new ConflictError('no scenarios: generate twins first');
      const pairs = pairsFromScenarios(scenarios);
      const shadow = ctx.shadow ? ctx.shadow() : new SimulatedPayPal();
      const executionErrors: string[] = [];
      const evals = new Map<string, ScenarioEval>();
      const failedScenarios = new Set<string>();
      const execRows: ExecutionRow[] = [];
      const invRows: InvariantRow[] = [];

      for (const s of scenarios) {
        const tx = s.input_json;
        const oldD = evaluatePolicy(A, tx);
        const newD = evaluatePolicy(cand, tx);
        let trace: ExecutionTrace;
        try {
          const res = await executeScenario({ runId, scenarioId: s.id, scenarioKey: s.scenario_key, policyLabel: verB.label, policy: cand, decision: newD, tx, adapter: shadow, lane: 'shadow' });
          trace = res.trace;
          execRows.push(...(res.records as ExecutionRow[]));
          if (res.errors.length) {
            failedScenarios.add(s.id);
            executionErrors.push(...res.errors.map((e) => `${s.scenario_key}: ${e}`));
          }
        } catch (e) {
          failedScenarios.add(s.id);
          executionErrors.push(`${s.scenario_key}: ${e instanceof Error ? e.message : String(e)}`);
          trace = emptyTrace(s.id, newD.decision, tx);
        }
        const invariants: InvariantResult[] = checkInvariants(trace);
        invRows.push(...invariantRows(runId, s.id, verB.label, 'shadow', invariants));
        evals.set(s.id, { scenario_id: s.id, old: oldD, neu: newD, trace, invariants });
      }

      const sidOf = (pairId: string, type: 'base' | 'twin') => scenarios.find((s) => s.pair_id === pairId && s.scenario_type === type)!.id;
      const pairResults: PairResult[] = pairs.map((p) => classifyPair(p, { base: evals.get(sidOf(p.id, 'base'))!, twin: evals.get(sidOf(p.id, 'twin'))! }));
      const executed = pairs.filter((p) => !failedScenarios.has(sidOf(p.id, 'base')) && !failedScenarios.has(sidOf(p.id, 'twin'))).map((p) => p.category);
      const required = (verB.analysis_json?.required_tests ?? []) as TestCategory[];
      const coverage: Coverage = computeCoverage(required, executed);
      const caveats = unmodeledExceptions(verB.structured_policy_json!).map((s) => `“${s}”`);
      const release = decideRelease(pairResults, coverage, executionErrors, caveats);
      const impact = estimateImpact(pairResults);

      const analyst = await runImpactAnalyst(agentCtx(ctx, runId), { results: pairResults, pairs, impact, candidate_label: `Version ${verB.label}` });

      let repairProposal: Awaited<ReturnType<typeof runPolicyRepair>>['proposal'] | null = null;
      if (release.decision !== 'PASS' && cand.action === 'automatic_refund') {
        repairProposal = (await runPolicyRepair(agentCtx(ctx, runId), { candidate: cand, results: pairResults })).proposal;
      }

      return async (tx) => {
        // Everything below commits atomically with the COMPLETED transition.
        if (execRows.length) await tx.insertMany('paypal_executions', execRows.map(sanitizeExecution));
        await tx.insertMany('invariant_results', invRows);

        let repair: RunReport['repair'] = null;
        if (repairProposal) {
          const versions = await tx.list('policy_versions', { policy_id: policy.id });
          const cRow: PolicyVersionRow = {
            id: shortId('ver'),
            policy_id: policy.id,
            version: Math.max(0, ...versions.map((v) => v.version)) + 1,
            label: 'C',
            source_text: repairProposal.source_text,
            structured_policy_json: repairProposal.policy,
            analysis_json: null,
            status: 'repair_proposed',
            created_at: nowIso(),
          };
          await tx.insert('policy_versions', cRow);
          const textMatches = sameControls(readPolicyOffline(repairProposal.source_text, 'check', `${policy.name}. ${policy.intake_json.current_policy}`), repairProposal.policy);
          repair = { ...repairProposal, version_id: cRow.id, status: 'proposed', text_matches_structure: textMatches };
          await audit(tx, runId, 'repair_proposed', 'agent:policy_repair', { version_id: cRow.id, changes: repairProposal.changes.length, generated_by: repairProposal.generated_by, text_matches_structure: textMatches });
        }

        const report: RunReport = {
          candidate_label: verB.label,
          pair_results: pairResults,
          release,
          impact,
          narrative: analyst.output,
          repair,
          human_decision: null,
          rerun_of: run.parent_run_id,
          superseded_by: null,
          executed_mode: shadow.mode,
          ai: { mode: ctx.llm.mode, model: ctx.llm.model },
          generated_at: nowIso(),
        };
        const cur = need(await tx.get('test_runs', runId), 'test run');
        await tx.update('test_runs', runId, { release_decision: release.decision, completed_at: nowIso(), report_json: report, rev: cur.rev + 1 });
        await audit(tx, runId, 'release_recommendation', 'engine:deterministic', { decision: release.decision, counts: release.counts, lane: 'shadow', executed_mode: shadow.mode });
        return report;
      };
    },
  });
}

/** Safe-by-construction copy of an execution row (defence in depth: also applied right before insertion). */
export function sanitizeExecution(r: ExecutionRow): ExecutionRow {
  return { ...r, request_json: sanitizeFinancialEvidence(r.request_json), response_json: sanitizeFinancialEvidence(r.response_json), note: r.note === null ? null : String(sanitizeFinancialEvidence(r.note)) };
}

/** Advance a run through every remaining stage. Each stage is idempotent, so this is also the "resume" operation. */
export async function runAllStages(ctx: Ctx, runId: string): Promise<RunReport> {
  await generateTwins(ctx, runId);
  await evaluateRun(ctx, runId);
  return executeRun(ctx, runId);
}

// ───────────────────────── Concurrency-safe report updates ─────────────────────────
/**
 * Read-modify-write of report_json with optimistic concurrency: the write is a compare-and-set on `rev`, so two
 * concurrent writers (e.g. a human decision and a repair approval) can never overwrite each other. On a lost race we
 * re-read and re-apply `mutate`, which may throw to refuse the change based on the fresh state.
 */
async function updateReport(
  store: Store,
  runId: string,
  mutate: (report: RunReport, run: TestRunRow) => RunReport,
  opts: { patch?: Partial<TestRunRow>; expectStage?: RunStage[] } = {},
): Promise<TestRunRow> {
  for (let i = 0; i < 6; i++) {
    const run = need(await store.get('test_runs', runId), 'test run');
    if (!run.report_json || stageRank(run.stage) < stageRank('COMPLETED')) throw new ConflictError('run is not completed yet');
    if (opts.expectStage && !opts.expectStage.includes(run.stage)) throw new ConflictError(`run is ${run.stage}; expected ${opts.expectStage.join(' or ')}`);
    const next = mutate(structuredClone(run.report_json as RunReport), run);
    const won = await store.compareAndSet('test_runs', runId, { rev: run.rev, stage: run.stage }, { ...opts.patch, report_json: next, rev: run.rev + 1 });
    if (won) return won;
  }
  throw new ConflictError('the run was modified concurrently; please retry');
}

// ───────────────────────── Human steps ─────────────────────────
async function loadReport(ctx: Ctx, runId: string): Promise<{ run: TestRunRow; report: RunReport }> {
  const run = need(await ctx.store.get('test_runs', runId), 'test run');
  if (stageRank(run.stage) < stageRank('COMPLETED') || !run.report_json) throw new ConflictError('run is not completed yet');
  return { run, report: run.report_json as RunReport };
}

/**
 * A human approves the proposed repair; PolicyTwin re-runs every scenario against Version C.
 * Safe under concurrency and retries: UNIQUE (parent_run_id) guarantees ONE re-run per approved repair, only the
 * request that created it drives it, and a stalled re-run is resumed through resumeRun(child).
 */
export async function approveRepairAndRerun(ctx: Ctx, runId: string, actor = DEFAULT_ACTOR, note = ''): Promise<TestRunRow> {
  const { run, report } = await loadReport(ctx, runId);
  if (!report.repair) throw new ConflictError('this run has no proposed repair');
  if (report.superseded_by) throw new ConflictError('this repair has already been approved and re-run');
  const policy = need(await ctx.store.get('policies', run.policy_id), 'policy');
  const repair = report.repair;

  const { child, created } = await ctx.store.transaction(async (tx) => {
    const existing = (await tx.list('test_runs', { parent_run_id: runId }))[0];
    if (existing) return { child: existing, created: false };
    const row = await insertRun(tx, policy, { version_a_id: run.policy_version_a, version_b_id: repair.version_id, parent_run_id: runId, adversarial: run.options_json.adversarial, created_by: actor });
    await tx.update('policy_versions', repair.version_id, { status: 'repair_approved' });
    await audit(tx, runId, 'repair_approved', actor, { version_id: repair.version_id, note, rerun_id: row.id });
    return { child: row, created: true };
  }).catch(async (e) => {
    if (!isUniqueViolation(e)) throw e;
    const existing = (await ctx.store.list('test_runs', { parent_run_id: runId }))[0];
    if (!existing) throw e;
    return { child: existing, created: false };
  });

  if (!created) {
    if (stageRank(child.stage) >= stageRank('COMPLETED')) {
      await markSuperseded(ctx, runId, child.id); // the earlier request crashed after finishing the re-run
      return need(await ctx.store.get('test_runs', child.id), 'rerun');
    }
    throw new ConflictError(`this repair has already been approved and its re-run (${child.id}) is in progress; resume it if it has stalled`);
  }
  await runAllStages(ctx, child.id);
  await markSuperseded(ctx, runId, child.id);
  return need(await ctx.store.get('test_runs', child.id), 'rerun');
}

async function markSuperseded(ctx: Ctx, parentId: string, childId: string): Promise<void> {
  await updateReport(ctx.store, parentId, (r) => (r.repair ? { ...r, repair: { ...r.repair, status: 'approved' }, superseded_by: childId } : { ...r, superseded_by: childId }));
}

/** The final release decision is always a human's. A BLOCK can never be approved. Exactly one decision per run. */
export async function recordHumanDecision(ctx: Ctx, runId: string, a: { decision: 'approve' | 'reject'; actor?: string; note?: string }): Promise<HumanDecision> {
  const note = (a.note ?? '').trim();
  const actor = a.actor ?? DEFAULT_ACTOR;
  let hd!: HumanDecision;
  await ctx.store.transaction(async (tx) => {
    await updateReport(
      tx,
      runId,
      (report, run) => {
        if (run.stage === 'DECIDED' || report.human_decision) throw new ConflictError('A human decision has already been recorded for this run.');
        const verdict = report.release.decision;
        if (a.decision === 'approve' && verdict === 'BLOCK') throw new ConflictError('A BLOCK recommendation cannot be approved. Reject it, or approve the proposed repair and re-run.');
        if (a.decision === 'approve' && verdict === 'REVIEW' && note.length < 10) throw new ValidationError('Approving a REVIEW recommendation requires a written justification (at least 10 characters).', [{ path: 'note', message: 'at least 10 characters when approving a REVIEW' }]);
        hd = { decision: a.decision, actor, note, at: nowIso(), release_at_decision: verdict };
        return { ...report, human_decision: hd };
      },
      { patch: { stage: 'DECIDED' }, expectStage: ['COMPLETED', 'DECIDED'] },
    );
    await audit(tx, runId, 'human_decision', actor, hd);
  });
  return hd;
}

// ───────────────────────── LANE 2: targeted PayPal Sandbox proof ─────────────────────────
export interface SandboxProofScenario {
  scenario_id: string;
  scenario_key: string;
  mode: 'simulated' | 'sandbox';
  order_id: string | null;
  capture_id: string | null;
  refund_ids: string[];
  request_ids: string[];
  http_statuses: number[];
  failed_invariants: string[];
  shadow_failed_invariants: string[];
  agrees_with_shadow: boolean;
}
export interface SandboxProof {
  pair_id: string;
  mode: 'simulated' | 'sandbox';
  recorded_at: string;
  actor: string;
  errors: string[];
  scenarios: SandboxProofScenario[];
  /** True when the Sandbox run and the shadow run reached the same invariant outcomes for both scenarios. */
  agrees_with_shadow: boolean;
}

/**
 * Re-execute ONE pair against the configured adapter (the real PayPal Sandbox when credentials exist):
 * create → approve/confirm → capture → refund → canonical read-back → stable-idempotency retry.
 * PayPal resource ids are attached to the SAME scenarios. Idempotent: a repeat call returns the stored proof, and
 * even a forced re-run would reuse the same PayPal-Request-Ids. The Lane-1 release verdict is never changed by Lane 2;
 * a disagreement is surfaced prominently instead.
 */
export async function verifyPairInSandbox(ctx: Ctx, runId: string, pairId: string, actor = DEFAULT_ACTOR): Promise<SandboxProof> {
  const { run, verB, cand } = await load(ctx, runId);
  if (stageRank(run.stage) < stageRank('COMPLETED')) throw new ConflictError('run is not completed yet: finish the full shadow run before verifying a pair in the Sandbox');
  const scenarios = (await ctx.store.list('scenarios', { test_run_id: runId })).filter((s) => s.pair_id === pairId);
  if (scenarios.length !== 2) throw new NotFoundError('pair');

  const existing = await buildProofs(ctx.store, runId);
  const done = existing.find((p) => p.pair_id === pairId);
  if (done) return done;

  await withLease(
    ctx.store,
    runId,
    `SANDBOX_PROOF:${pairId}`,
    async () => {
      const execRows: ExecutionRow[] = [];
      const invRows: InvariantRow[] = [];
      const errors: string[] = [];
      for (const s of scenarios) {
        const newD = evaluatePolicy(cand, s.input_json);
        let trace: ExecutionTrace;
        try {
          const res = await executeScenario({ runId, scenarioId: s.id, scenarioKey: s.scenario_key, policyLabel: verB.label, policy: cand, decision: newD, tx: s.input_json, adapter: ctx.adapter, lane: 'sandbox_proof' });
          trace = res.trace;
          execRows.push(...(res.records as ExecutionRow[]));
          errors.push(...res.errors.map((e) => `${s.scenario_key}: ${e}`));
        } catch (e) {
          errors.push(`${s.scenario_key}: ${e instanceof Error ? e.message.slice(0, 200) : 'unexpected error'}`);
          trace = emptyTrace(s.id, newD.decision, s.input_json);
        }
        invRows.push(...invariantRows(runId, s.id, verB.label, 'sandbox_proof', checkInvariants(trace)));
      }
      await ctx.store.transaction(async (tx) => {
        if (execRows.length) await tx.insertMany('paypal_executions', execRows.map(sanitizeExecution));
        await tx.insertMany('invariant_results', invRows);
        await audit(tx, runId, 'sandbox_proof_recorded', actor, { pair_id: pairId, mode: ctx.adapter.mode, errors, scenario_ids: scenarios.map((x) => x.id) });
      });
    },
    clockOf(ctx),
  );
  const proofs = await buildProofs(ctx.store, runId);
  return need(proofs.find((p) => p.pair_id === pairId), 'sandbox proof');
}

export async function buildProofs(store: Store, runId: string): Promise<SandboxProof[]> {
  const [scenarios, execs, invs, events] = await Promise.all([
    store.list('scenarios', { test_run_id: runId }),
    store.list('paypal_executions', { test_run_id: runId, lane: 'sandbox_proof' }),
    store.list('invariant_results', { test_run_id: runId }),
    store.list('audit_events', { test_run_id: runId, event_type: 'sandbox_proof_recorded' }),
  ]);
  return events.map((ev) => {
    const p = ev.payload_json as { pair_id: string; mode: 'simulated' | 'sandbox'; errors: string[]; scenario_ids: string[] };
    const per: SandboxProofScenario[] = p.scenario_ids.map((sid) => {
      const sc = scenarios.find((s) => s.id === sid)!;
      const rows = execs.filter((e) => e.scenario_id === sid);
      const failed = (lane: InvariantRow['lane']) => invs.filter((i) => i.scenario_id === sid && i.lane === lane && !i.passed).map((i) => i.invariant_code).sort();
      const f = failed('sandbox_proof');
      const sf = failed('shadow');
      return {
        scenario_id: sid,
        scenario_key: sc?.scenario_key ?? sid,
        mode: p.mode,
        order_id: rows.find((r) => r.paypal_order_id)?.paypal_order_id ?? null,
        capture_id: rows.find((r) => r.paypal_capture_id)?.paypal_capture_id ?? null,
        refund_ids: [...new Set(rows.map((r) => r.paypal_refund_id).filter((x): x is string => !!x))],
        request_ids: [...new Set(rows.map((r) => r.request_id).filter((x): x is string => !!x))],
        http_statuses: rows.map((r) => r.http_status).filter((x): x is number => x !== null),
        failed_invariants: f,
        shadow_failed_invariants: sf,
        agrees_with_shadow: JSON.stringify(f) === JSON.stringify(sf),
      };
    });
    return { pair_id: p.pair_id, mode: p.mode, recorded_at: ev.created_at, actor: ev.actor, errors: p.errors, scenarios: per, agrees_with_shadow: per.every((x) => x.agrees_with_shadow) && p.errors.length === 0 };
  });
}

// ───────────────────────── Read model ─────────────────────────
export interface ScenarioView {
  scenario_id: string;
  scenario_type: 'base' | 'twin';
  scenario_key: string;
  input: TxInput;
  old_decision: DecisionRow | null;
  new_decision: DecisionRow | null;
  executions: ExecutionRow[];
  invariants: InvariantRow[];
}

export interface PairView {
  pair_id: string;
  label: string;
  origin: 'core' | 'adversarial';
  category: string;
  changed_field: string;
  expectation: string;
  rationale: string;
  base: ScenarioView;
  twin: ScenarioView;
  result: PairResult | null;
}

export interface RunBundle {
  run: TestRunRow;
  policy: PolicyRow;
  version_a: PolicyVersionRow;
  version_b: PolicyVersionRow;
  pairs: PairView[];
  report: RunReport | null;
  agent_runs: AgentRunRow[];
  audit: AuditRow[];
  stages: RunStageRow[];
  sandbox_proofs: SandboxProof[];
  runtime: RuntimeInfo;
  parent_run_id: string | null;
  child_run_id: string | null;
  /** True for the shared read-only example. */
  read_only: boolean;
}

export async function getRunBundle(ctx: Ctx, runId: string): Promise<RunBundle> {
  const run = need(await ctx.store.get('test_runs', runId), 'test run');
  const policy = need(await ctx.store.get('policies', run.policy_id), 'policy');
  const version_a = need(await ctx.store.get('policy_versions', run.policy_version_a), 'version A');
  const version_b = need(await ctx.store.get('policy_versions', run.policy_version_b), 'candidate version');
  const [scenarios, decisions, executions, invariants, agent_runs, auditRows, stages, sandbox_proofs] = await Promise.all([
    ctx.store.list('scenarios', { test_run_id: runId }),
    ctx.store.list('policy_decisions', { test_run_id: runId }),
    ctx.store.list('paypal_executions', { test_run_id: runId }),
    ctx.store.list('invariant_results', { test_run_id: runId }),
    ctx.store.list('agent_runs', { test_run_id: runId }),
    ctx.store.list('audit_events', { test_run_id: runId }),
    stageRows(ctx.store, runId),
    buildProofs(ctx.store, runId),
  ]);
  const report = (run.report_json as RunReport | null) ?? null;
  const safeExecs = executions.map(sanitizeExecution); // API output is sanitized again
  const view = (s: ScenarioRow): ScenarioView => ({
    scenario_id: s.id,
    scenario_type: s.scenario_type,
    scenario_key: s.scenario_key,
    input: s.input_json,
    old_decision: decisions.find((d) => d.scenario_id === s.id && d.policy_version === version_a.label) ?? null,
    new_decision: decisions.find((d) => d.scenario_id === s.id && d.policy_version === version_b.label) ?? null,
    executions: safeExecs.filter((e) => e.scenario_id === s.id),
    invariants: invariants.filter((i) => i.scenario_id === s.id),
  });
  const ids = [...new Set(scenarios.map((s) => s.pair_id))];
  const pairs: PairView[] = ids.map((pid) => {
    const base = scenarios.find((s) => s.pair_id === pid && s.scenario_type === 'base')!;
    const twin = scenarios.find((s) => s.pair_id === pid && s.scenario_type === 'twin')!;
    return {
      pair_id: pid,
      label: base.meta_json.label,
      origin: base.meta_json.origin,
      category: base.meta_json.category,
      changed_field: base.changed_field,
      expectation: base.expected_behavior,
      rationale: base.meta_json.rationale,
      base: view(base),
      twin: view(twin),
      result: report?.pair_results.find((r) => r.pair_id === pid) ?? null,
    };
  });
  const children = await ctx.store.list('test_runs', { parent_run_id: runId });
  return {
    run: { ...run, report_json: run.report_json },
    policy,
    version_a,
    version_b,
    pairs,
    report,
    agent_runs,
    audit: auditRows.map((a) => ({ ...a, payload_json: sanitizeFinancialEvidence(a.payload_json) })),
    stages: stages.filter((s) => !s.stage_name.startsWith('SANDBOX_PROOF:')),
    sandbox_proofs,
    runtime: describeRuntime(ctx),
    parent_run_id: run.parent_run_id,
    child_run_id: children[0]?.id ?? null,
    read_only: policy.owner_session === 'public',
  };
}

// ───────────────────────── Convenience: one call for the whole vertical flow ─────────────────────────
export async function runDemoFlow(ctx: Ctx, input: PolicyIntake, opts: { adversarial?: boolean; ownerSession?: string; actor?: string; policyId?: string } = {}) {
  const { policy, version_a, version_b } = await createPolicy(ctx, input, opts.actor ?? DEFAULT_ACTOR, opts.ownerSession ?? DEFAULT_OWNER, { id: opts.policyId });
  await analyzePolicy(ctx, policy.id);
  const run = await createTestRun(ctx, { policy_id: policy.id, version_a_id: version_a.id, version_b_id: version_b.id, adversarial: opts.adversarial, created_by: opts.actor });
  const report = await runAllStages(ctx, run.id);
  return { policy, run, report };
}
