import { describe, expect, it } from 'vitest';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import {
  addVersion,
  analyzePolicy,
  approveRepairAndRerun,
  createPolicy,
  createTestRun,
  evaluateRun,
  executeRun,
  generateTwins,
  getRunBundle,
  recordHumanDecision,
  runDemoFlow,
} from '@/lib/pipeline';
import { offlineCtx } from '../helpers';

describe('full vertical flow (offline: deterministic agents + simulated PayPal)', () => {
  it('Version B is BLOCKED, with the failures the spec predicts', async () => {
    const ctx = await offlineCtx();
    const { run, report } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    expect(report.release.decision).toBe('BLOCK');
    expect(report.executed_mode).toBe('simulated');
    const by = Object.fromEntries(report.pair_results.map((r) => [r.pair_id, r]));

    expect(by.pair_01).toMatchObject({ outcome: 'UNINTENDED_EXPANSION', severity: 'critical' }); // digital refunded like physical
    expect(by.pair_02.outcome).toBe('AS_EXPECTED'); // threshold works
    expect(by.pair_03.outcome).toBe('AMBIGUOUS'); // currency
    expect(by.pair_04.failed_invariants).toContain('ONE_REFUND_PER_LOGICAL_REQUEST'); // retry
    expect(by.pair_05.failed_invariants).toContain('NO_AUTO_REFUND_WITH_OPEN_DISPUTE'); // dispute
    expect(by.pair_06.failed_invariants).toEqual(expect.arrayContaining(['DUPLICATE_WEBHOOK_NO_DUPLICATE_OPERATION', 'OLDER_WEBHOOK_NO_STATE_REGRESSION'])); // duplicate webhook
    expect(report.release.counts.critical).toBeGreaterThanOrEqual(4);
    expect(report.repair?.status).toBe('proposed');
    expect(report.human_decision).toBeNull(); // PolicyTwin never decides
    expect((await ctx.store.get('test_runs', run.id))?.release_decision).toBe('BLOCK');
  });

  it('the repaired Version C passes after a HUMAN approves the repair and everything re-runs', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const rerun = await approveRepairAndRerun(ctx, run.id, 'tester', 'looks right');
    expect(rerun.parent_run_id).toBe(run.id);
    expect(rerun.release_decision).toBe('PASS');
    expect(rerun.status).toBe('completed');

    const first = await getRunBundle(ctx, run.id);
    expect(first.child_run_id).toBe(rerun.id);
    expect(first.report?.repair?.status).toBe('approved');
    expect(first.report?.superseded_by).toBe(rerun.id);

    const second = await getRunBundle(ctx, rerun.id);
    expect(second.report?.pair_results.every((r) => r.outcome === 'AS_EXPECTED')).toBe(true);
    expect(second.version_b.label).toBe('C');
    // Version C’s text is plain English that round-trips to its structure.
    expect(second.report?.repair).toBeNull();
    expect(second.version_b.source_text).toMatch(/dispute/i);
  });

  it('a repair can only be approved once', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    await approveRepairAndRerun(ctx, run.id);
    await expect(approveRepairAndRerun(ctx, run.id)).rejects.toThrow(/already been approved/);
  });

  it('uses stable, readable PayPal-Request-Ids: <run>-<scenario>-<operation>', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const exec = await ctx.store.list('paypal_executions', { test_run_id: run.id });
    const ids = exec.map((e) => e.request_id).filter(Boolean) as string[];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(new RegExp(`^${run.id}-scenario_\\d+-[a-z-]+(-d\\d+-a\\d+)?$`));
    // Version B says nothing about retries, so each attempt gets its own id (…-refund-d1-a2).
    expect(ids.some((i) => /-refund-d\d+-a\d+$/.test(i))).toBe(true);
    // The recommended form (Version C, after repair) is exactly <run>-<scenario>-refund, e.g. run_204-scenario_06-refund.
    const rerun = await approveRepairAndRerun(ctx, run.id);
    const fixed = (await ctx.store.list('paypal_executions', { test_run_id: rerun.id })).map((e) => e.request_id).filter(Boolean) as string[];
    expect(fixed.some((i) => new RegExp(`^${rerun.id}-scenario_\\d+-refund$`).test(i))).toBe(true);
  });

  it('literal Version B uses a NEW request id per retry (so the retry refunds twice); Version C reuses one', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const rerun = await approveRepairAndRerun(ctx, run.id);
    const refundsOf = async (runId: string, scenarioPair: 'pair_04') => {
      const scenarios = (await ctx.store.list('scenarios', { test_run_id: runId })).filter((s) => s.pair_id === scenarioPair && s.scenario_type === 'twin');
      const ex = (await ctx.store.list('paypal_executions', { test_run_id: runId, scenario_id: scenarios[0].id })).filter((e) => e.operation === 'refund_capture');
      return ex;
    };
    const bRefunds = await refundsOf(run.id, 'pair_04');
    const cRefunds = await refundsOf(rerun.id, 'pair_04');
    // The same decision is evaluated under A (REVIEW → no refund) and B/C; look only at executions that happened.
    const bIds = new Set(bRefunds.map((e) => e.request_id));
    const cIds = new Set(cRefunds.map((e) => e.request_id));
    expect(bRefunds.length).toBe(2);
    expect(bIds.size).toBe(2);
    expect(cRefunds.length).toBe(2);
    expect(cIds.size).toBe(1);
    expect(cRefunds.some((e) => e.status === 'REPLAYED')).toBe(true);
  });

  it('records an audit trail and agent runs for every agent role used', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const bundle = await getRunBundle(ctx, run.id);
    const names = new Set((await ctx.store.list('agent_runs')).map((a) => a.agent_name));
    for (const n of ['policy_reader', 'impact_mapper', 'twin_generator', 'adversarial_scenario', 'impact_analyst', 'policy_repair']) expect([...names].join(',')).toContain(n);
    expect(bundle.audit.map((a) => a.event_type)).toContain('release_recommendation');
    expect(bundle.audit.every((a) => a.payload_hash.length === 64)).toBe(true);
  });
});

describe('stage-by-stage API of the pipeline', () => {
  it('rejects out-of-order stages with a clear message', async () => {
    const ctx = await offlineCtx();
    const { policy, version_a, version_b } = await createPolicy(ctx, DEMO_POLICY_INPUT);
    await analyzePolicy(ctx, policy.id);
    const run = await createTestRun(ctx, { policy_id: policy.id, version_a_id: version_a.id, version_b_id: version_b.id });
    await expect(evaluateRun(ctx, run.id)).rejects.toThrow();
    await expect(executeRun(ctx, run.id)).rejects.toThrow();
    const pairs = await generateTwins(ctx, run.id);
    expect(pairs).toHaveLength(10);
  });

  it('validates the intake and unknown ids', async () => {
    const ctx = await offlineCtx();
    await expect(createPolicy(ctx, { ...DEMO_POLICY_INPUT, proposed_policy: '  ' })).rejects.toThrow(/proposed_policy is required/);
    await expect(addVersion(ctx, 'nope', { source_text: 'x' })).rejects.toThrow(/not found/);
    await expect(getRunBundle(ctx, 'nope')).rejects.toThrow(/not found/);
  });

  it('adds a new version to an existing policy', async () => {
    const ctx = await offlineCtx();
    const { policy } = await createPolicy(ctx, DEMO_POLICY_INPUT);
    const v = await addVersion(ctx, policy.id, { source_text: 'Automatically refund missing-delivery claims of $25 or less when tracking is unavailable.' });
    expect(v.version).toBe(3);
    expect(v.label).toBe('C');
  });

  it('supports a core-only run (six pairs)', async () => {
    const ctx = await offlineCtx();
    const { policy, version_a, version_b } = await createPolicy(ctx, DEMO_POLICY_INPUT);
    await analyzePolicy(ctx, policy.id);
    const run = await createTestRun(ctx, { policy_id: policy.id, version_a_id: version_a.id, version_b_id: version_b.id, adversarial: false });
    expect(await generateTwins(ctx, run.id)).toHaveLength(6);
  });
});

describe('human final decision', () => {
  it('cannot approve a BLOCK, but can reject it', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    await expect(recordHumanDecision(ctx, run.id, { decision: 'approve', note: 'ship it anyway please' })).rejects.toThrow(/BLOCK/);
    const hd = await recordHumanDecision(ctx, run.id, { decision: 'reject', note: 'needs the repair' });
    expect(hd).toMatchObject({ decision: 'reject', release_at_decision: 'BLOCK' });
    await expect(recordHumanDecision(ctx, run.id, { decision: 'reject' })).rejects.toThrow(/already been recorded/);
    expect((await getRunBundle(ctx, run.id)).report?.human_decision?.decision).toBe('reject');
  });

  it('a PASS is only a recommendation: it still needs a human approval record', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const rerun = await approveRepairAndRerun(ctx, run.id);
    expect((await getRunBundle(ctx, rerun.id)).report?.human_decision).toBeNull();
    const hd = await recordHumanDecision(ctx, rerun.id, { decision: 'approve', actor: 'jordan' });
    expect(hd).toMatchObject({ decision: 'approve', actor: 'jordan', release_at_decision: 'PASS' });
  });

  it('refuses a decision on a run that has not completed', async () => {
    const ctx = await offlineCtx();
    const { policy, version_a, version_b } = await createPolicy(ctx, DEMO_POLICY_INPUT);
    const run = await createTestRun(ctx, { policy_id: policy.id, version_a_id: version_a.id, version_b_id: version_b.id });
    await expect(recordHumanDecision(ctx, run.id, { decision: 'reject' })).rejects.toThrow(/not completed/);
  });
});

describe('a stated exception that PolicyTwin cannot execute never yields a clean PASS', () => {
  const FULLY_SPECIFIED_WITH_EXCEPTION =
    'For physical goods of $50 or less, automatically refund a missing-delivery claim when tracking is unavailable, except for new customers. For digital goods, require access evidence; if evidence is missing or conflicting, send the case for review. Apply the same evidence requirement to services. Only USD transactions are in scope; other currencies go to review. If a dispute is open on the transaction, send the case for review. Treat retried refund requests as the same logical request using a stable PayPal-Request-Id, and ignore duplicate webhook deliveries using event-ID deduplication.';

  it('every control is defined and every invariant holds — yet the verdict is REVIEW, quoting the exception', async () => {
    const ctx = await offlineCtx();
    const { report } = await runDemoFlow(ctx, { ...DEMO_POLICY_INPUT, proposed_policy: FULLY_SPECIFIED_WITH_EXCEPTION });
    expect(report.pair_results.every((r) => r.severity === 'none' || r.severity === 'medium')).toBe(true);
    expect(report.release.counts.critical).toBe(0);
    expect(report.release.decision).toBe('REVIEW');
    expect(report.release.unverified_terms).toHaveLength(1);
    expect(report.release.reasons.join(' ')).toContain('except for new customers');
  });

  it('approving that REVIEW needs a written justification', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, { ...DEMO_POLICY_INPUT, proposed_policy: FULLY_SPECIFIED_WITH_EXCEPTION });
    await expect(recordHumanDecision(ctx, run.id, { decision: 'approve', note: 'ok' })).rejects.toThrow(/written justification/);
    await expect(recordHumanDecision(ctx, run.id, { decision: 'approve', note: 'Exception reviewed manually by compliance owner.' })).resolves.toMatchObject({ decision: 'approve', release_at_decision: 'REVIEW' });
  });

  it('the repaired Version C keeps the exception and so re-runs as REVIEW, never PASS', async () => {
    const ctx = await offlineCtx();
    const loose = 'Automatically refund transactions of $50 or less when tracking information is unavailable, except for new customers.';
    const { run, report } = await runDemoFlow(ctx, { ...DEMO_POLICY_INPUT, proposed_policy: loose });
    expect(report.release.decision).toBe('BLOCK');
    expect(report.repair?.source_text).toContain('except for new customers');
    const rerun = await approveRepairAndRerun(ctx, run.id);
    expect(rerun.release_decision).toBe('REVIEW');
    const bundle = await getRunBundle(ctx, rerun.id);
    expect(bundle.report?.release.counts.critical).toBe(0);
    expect(bundle.report?.release.reasons.join(' ')).toContain('Not verified by PolicyTwin');
  });
});
