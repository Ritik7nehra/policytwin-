import { describe, expect, it } from 'vitest';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { MemoryStore } from '@/lib/store/memory';
import type { Store, TableName } from '@/lib/store/types';
import { SimulatedPayPal } from '@/lib/paypal/simulated';
import { OfflineLlm } from '@/lib/agents/llm';
import { LEASE_MS } from '@/lib/runner/stages';
import {
  approveRepairAndRerun,
  createPolicy,
  createTestRun,
  evaluateRun,
  executeRun,
  generateTwins,
  getRunBundle,
  recordHumanDecision,
  runAllStages,
  runDemoFlow,
  verifyPairInSandbox,
  type Ctx,
} from '@/lib/pipeline';
import { offlineCtx } from '../helpers';

/** A Store wrapper that lets a test fail the Nth write to a table (inside or outside a transaction). */
type Hook = (op: 'insert' | 'insertMany', table: TableName, row: any) => void;
function flaky(inner: Store, hook: Hook): Store {
  return {
    mode: inner.mode,
    init: () => inner.init(),
    ping: () => inner.ping(),
    insert: (t, row) => (hook('insert', t, row), inner.insert(t, row)),
    insertMany: (t, rows) => (hook('insertMany', t, rows), inner.insertMany(t, rows)),
    get: (t, id) => inner.get(t, id),
    list: (t, w) => inner.list(t, w),
    count: (t, w) => inner.count(t, w),
    update: (t, id, p) => inner.update(t, id, p),
    upsert: (t, r) => inner.upsert(t, r),
    compareAndSet: (t, id, e, p) => inner.compareAndSet(t, id, e, p),
    deleteWhere: (t, w) => inner.deleteWhere(t, w),
    transaction: (fn) => inner.transaction((tx) => fn(flaky(tx, hook))),
  } as Store;
}

async function freshRun(ctx: Ctx) {
  const p = await createPolicy(ctx, DEMO_POLICY_INPUT);
  const versions = await ctx.store.list('policy_versions', { policy_id: p.policy.id });
  const a = versions.find((v) => v.label === 'A')!;
  const b = versions.find((v) => v.label === 'B')!;
  return createTestRun(ctx, { policy_id: p.policy.id, version_a_id: a.id, version_b_id: b.id });
}

describe('stage state machine', () => {
  it('walks CREATED → TWINS_READY → EVALUATED → COMPLETED and keeps the legacy status in sync', async () => {
    const ctx = await offlineCtx();
    const run = await freshRun(ctx);
    expect(run).toMatchObject({ stage: 'CREATED', status: 'created' });
    await generateTwins(ctx, run.id);
    expect(await ctx.store.get('test_runs', run.id)).toMatchObject({ stage: 'TWINS_READY', status: 'twins_generated', locked_until: null });
    await evaluateRun(ctx, run.id);
    expect(await ctx.store.get('test_runs', run.id)).toMatchObject({ stage: 'EVALUATED', status: 'evaluated' });
    await executeRun(ctx, run.id);
    expect(await ctx.store.get('test_runs', run.id)).toMatchObject({ stage: 'COMPLETED', status: 'completed', release_decision: 'BLOCK' });
    await recordHumanDecision(ctx, run.id, { decision: 'reject', note: 'blocked' });
    expect((await ctx.store.get('test_runs', run.id))!.stage).toBe('DECIDED');
    const stages = await ctx.store.list('run_stages', { run_id: run.id });
    expect(stages.map((s) => s.id).sort()).toEqual([`${run.id}:EVALUATE`, `${run.id}:EXECUTE`, `${run.id}:GENERATE_TWINS`]);
    expect(stages.every((s) => s.status === 'DONE' && s.attempts === 1)).toBe(true);
  });

  it('refuses illegal transitions with 409 and leaves the run untouched', async () => {
    const ctx = await offlineCtx();
    const run = await freshRun(ctx);
    await expect(evaluateRun(ctx, run.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(executeRun(ctx, run.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(recordHumanDecision(ctx, run.id, { decision: 'reject' })).rejects.toBeInstanceOf(ConflictError);
    await expect(verifyPairInSandbox(ctx, run.id, 'pair_01')).rejects.toBeInstanceOf(ConflictError);
    expect((await ctx.store.get('test_runs', run.id))!.stage).toBe('CREATED');
    expect(await ctx.store.count('scenarios', { test_run_id: run.id })).toBe(0);
  });

  it('is idempotent: repeating a finished stage returns the stored result and writes nothing new', async () => {
    const ctx = await offlineCtx();
    const { run, report } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const counts = async () => ({
      scenarios: await ctx.store.count('scenarios', { test_run_id: run.id }),
      decisions: await ctx.store.count('policy_decisions', { test_run_id: run.id }),
      executions: await ctx.store.count('paypal_executions', { test_run_id: run.id }),
      invariants: await ctx.store.count('invariant_results', { test_run_id: run.id }),
      audit: await ctx.store.count('audit_events', { test_run_id: run.id }),
    });
    const before = await counts();
    const again = await executeRun(ctx, run.id);
    await generateTwins(ctx, run.id);
    await evaluateRun(ctx, run.id);
    expect(again.release.decision).toBe(report.release.decision);
    expect(await counts()).toEqual(before);
  });

  it('repeated / concurrent execute: only one execution happens, no duplicate rows', async () => {
    const ctx = await offlineCtx();
    const run = await freshRun(ctx);
    await generateTwins(ctx, run.id);
    await evaluateRun(ctx, run.id);
    const results = await Promise.allSettled([executeRun(ctx, run.id), executeRun(ctx, run.id), executeRun(ctx, run.id)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const b of bad) expect(b.reason).toBeInstanceOf(ConflictError); // "already in progress" — never a 500, never a duplicate
    const baseline = await offlineCtx();
    const { run: ref } = await runDemoFlow(baseline, DEMO_POLICY_INPUT);
    expect(await ctx.store.count('paypal_executions', { test_run_id: run.id })).toBe(await baseline.store.count('paypal_executions', { test_run_id: ref.id }));
    expect(await ctx.store.count('invariant_results', { test_run_id: run.id })).toBe(await baseline.store.count('invariant_results', { test_run_id: ref.id }));
    const stage = (await ctx.store.get('run_stages', `${run.id}:EXECUTE`))!;
    expect(stage).toMatchObject({ status: 'DONE', attempts: 1 });
  });

  it('a live lease blocks other callers; an expired lease is taken over (safe resume after a crash)', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const ctx = { ...(await offlineCtx()), clock: { now: () => now } };
    const run = await freshRun(ctx);
    // Simulate a worker that took the lease and died.
    await ctx.store.update('test_runs', run.id, { stage: 'GENERATING', status: 'created', locked_until: new Date(now + LEASE_MS).toISOString() });
    await expect(generateTwins(ctx, run.id)).rejects.toThrow(/already in progress/);
    now += LEASE_MS + 1;
    const pairs = await generateTwins(ctx, run.id);
    expect(pairs).toHaveLength(10);
    expect(await ctx.store.get('test_runs', run.id)).toMatchObject({ stage: 'TWINS_READY', locked_until: null, failed_stage: null });
  });

  it('partial DB failure rolls the WHOLE stage back; the run is marked failed and resumes cleanly', async () => {
    const base = await offlineCtx();
    let armed = true;
    const store = flaky(base.store, (op, table, row) => {
      // Fail the audit insert that is the LAST write of GENERATE_TWINS — after the scenarios were already inserted in the same transaction.
      if (armed && op === 'insert' && table === 'audit_events' && row.event_type === 'twins_generated') throw new Error('simulated connection loss during commit');
    });
    const ctx: Ctx = { ...base, store };
    const run = await freshRun(ctx);
    await expect(generateTwins(ctx, run.id)).rejects.toThrow(/simulated connection loss/);

    const after = (await base.store.get('test_runs', run.id))!;
    expect(after).toMatchObject({ stage: 'CREATED', status: 'failed', failed_stage: 'GENERATE_TWINS', locked_until: null });
    expect(after.last_error).toMatch(/connection loss/);
    expect(await base.store.count('scenarios', { test_run_id: run.id })).toBe(0); // nothing half-written
    expect(await base.store.get('run_stages', `${run.id}:GENERATE_TWINS`)).toMatchObject({ status: 'FAILED', attempts: 1 });

    armed = false;
    await runAllStages(ctx, run.id); // resume = just call it again
    const done = (await base.store.get('test_runs', run.id))!;
    expect(done).toMatchObject({ stage: 'COMPLETED', status: 'completed', failed_stage: null, last_error: null });
    expect(await base.store.get('run_stages', `${run.id}:GENERATE_TWINS`)).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(await base.store.count('scenarios', { test_run_id: run.id })).toBe(20);
  });

  it('a failure in EXECUTE keeps twins and decisions, reverts to EVALUATED, and resumes', async () => {
    const base = await offlineCtx();
    let armed = true;
    const store = flaky(base.store, (op, table) => {
      if (armed && op === 'insertMany' && table === 'invariant_results') throw new Error('disk full');
    });
    const ctx: Ctx = { ...base, store };
    const run = await freshRun(ctx);
    await expect(runAllStages(ctx, run.id)).rejects.toThrow(/disk full/);
    expect(await base.store.get('test_runs', run.id)).toMatchObject({ stage: 'EVALUATED', status: 'failed', failed_stage: 'EXECUTE' });
    expect(await base.store.count('paypal_executions', { test_run_id: run.id })).toBe(0);
    expect(await base.store.count('scenarios', { test_run_id: run.id })).toBe(20);
    armed = false;
    const report = await runAllStages(ctx, run.id);
    expect(report.release.decision).toBe('BLOCK');
  });
});

describe('human steps under concurrency', () => {
  it('two concurrent final decisions: exactly one is recorded, the other gets 409', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const results = await Promise.allSettled([
      recordHumanDecision(ctx, run.id, { decision: 'reject', actor: 'alice', note: 'no' }),
      recordHumanDecision(ctx, run.id, { decision: 'reject', actor: 'bob', note: 'also no' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(lost.reason).toBeInstanceOf(ConflictError);
    const audit = await ctx.store.list('audit_events', { test_run_id: run.id, event_type: 'human_decision' });
    expect(audit).toHaveLength(1);
    const stored = (await ctx.store.get('test_runs', run.id))!;
    expect(stored.stage).toBe('DECIDED');
    expect((stored.report_json as any).human_decision.actor).toBe(audit[0].actor);
  });

  it('a BLOCK can never be approved, even concurrently with a reject; the recorded decision is never overwritten', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const [approve, reject] = await Promise.allSettled([recordHumanDecision(ctx, run.id, { decision: 'approve', note: 'ship it please' }), recordHumanDecision(ctx, run.id, { decision: 'reject', note: 'no' })]);
    expect(approve.status).toBe('rejected');
    expect(reject.status).toBe('fulfilled');
    expect(((await ctx.store.get('test_runs', run.id))!.report_json as any).human_decision.decision).toBe('reject');
    await expect(recordHumanDecision(ctx, run.id, { decision: 'approve', note: 'override attempt, long enough' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('two concurrent repair approvals create exactly ONE re-run of Version C', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const results = await Promise.allSettled([approveRepairAndRerun(ctx, run.id, 'alice', 'ok'), approveRepairAndRerun(ctx, run.id, 'bob', 'ok')]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictError);
    const children = await ctx.store.list('test_runs', { parent_run_id: run.id });
    expect(children).toHaveLength(1);
    const versionsC = (await ctx.store.list('policy_versions', { policy_id: run.policy_id })).filter((v) => v.label === 'C');
    expect(versionsC).toHaveLength(1);
    expect(await ctx.store.list('audit_events', { test_run_id: run.id, event_type: 'repair_approved' })).toHaveLength(1);
    await expect(approveRepairAndRerun(ctx, run.id)).rejects.toBeInstanceOf(ConflictError);
    const parent = await getRunBundle(ctx, run.id);
    expect(parent.child_run_id).toBe(children[0].id);
  });

  it('a human decision and a repair approval racing each other never lose either write (optimistic concurrency)', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const [d, r] = await Promise.allSettled([recordHumanDecision(ctx, run.id, { decision: 'reject', note: 'no' }), approveRepairAndRerun(ctx, run.id, 'alice', 'ok')]);
    expect(d.status).toBe('fulfilled');
    expect(r.status).toBe('fulfilled');
    const stored = (await ctx.store.get('test_runs', run.id))!;
    const report = stored.report_json as any;
    expect(report.human_decision?.decision).toBe('reject');
    expect(report.superseded_by).toBeTruthy();
    expect(report.repair.status).toBe('approved');
  });
});

describe('Lane 2 — verify a selected pair in the PayPal Sandbox (simulated adapter here)', () => {
  it('attaches resource ids to the SAME scenarios, tags provenance, and never changes the Lane-1 verdict', async () => {
    const ctx = await offlineCtx();
    const { run, report } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const shadowBefore = (await ctx.store.list('invariant_results', { test_run_id: run.id })).filter((i) => i.lane === 'shadow').length;
    const proof = await verifyPairInSandbox(ctx, run.id, 'pair_04', 'tester');
    expect(proof.pair_id).toBe('pair_04');
    expect(proof.scenarios).toHaveLength(2);
    for (const s of proof.scenarios) {
      expect(s.order_id).toBeTruthy();
      expect(s.capture_id).toBeTruthy();
      expect(s.mode).toBe('simulated'); // honest label: the adapter is the simulator
    }
    const lane2 = await ctx.store.list('paypal_executions', { test_run_id: run.id, lane: 'sandbox_proof' });
    expect(lane2.length).toBeGreaterThan(0);
    expect(new Set(lane2.map((e) => e.scenario_id))).toEqual(new Set(proof.scenarios.map((s) => s.scenario_id)));
    const stored = (await ctx.store.get('test_runs', run.id))!;
    expect(stored.release_decision).toBe(report.release.decision); // Lane 2 cannot flip the verdict
    expect((await ctx.store.list('invariant_results', { test_run_id: run.id })).filter((i) => i.lane === 'shadow')).toHaveLength(shadowBefore);
    const bundle = await getRunBundle(ctx, run.id);
    expect(bundle.sandbox_proofs.map((p) => p.pair_id)).toEqual(['pair_04']);
  });

  it('is idempotent — also under concurrency: one proof, no duplicated PayPal calls', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const rs = await Promise.allSettled([verifyPairInSandbox(ctx, run.id, 'pair_01'), verifyPairInSandbox(ctx, run.id, 'pair_01')]);
    expect(rs.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of rs) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictError);
    const first = await verifyPairInSandbox(ctx, run.id, 'pair_01');
    const n = await ctx.store.count('paypal_executions', { test_run_id: run.id, lane: 'sandbox_proof' });
    const second = await verifyPairInSandbox(ctx, run.id, 'pair_01');
    expect(second).toEqual(first);
    expect(await ctx.store.count('paypal_executions', { test_run_id: run.id, lane: 'sandbox_proof' })).toBe(n);
    expect(await ctx.store.list('audit_events', { test_run_id: run.id, event_type: 'sandbox_proof_recorded' })).toHaveLength(1);
  });

  it('rejects unknown pairs (404) and surfaces a disagreement with the shadow run instead of hiding it', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    await expect(verifyPairInSandbox(ctx, run.id, 'pair_99')).rejects.toBeInstanceOf(NotFoundError);

    // A "real" adapter that misbehaves: every refund is rejected with a 500. pair_04 is the retry case, where the
    // shadow run FAILS ONE_REFUND_PER_LOGICAL_REQUEST — with refunds failing, Lane 2 reaches a different outcome.
    class BrokenRefunds extends SimulatedPayPal {
      override async refundCapture(...a: Parameters<SimulatedPayPal['refundCapture']>) {
        const r = await super.refundCapture(...a);
        return { ...r, ok: false as const, status: 500, error: { name: 'INTERNAL_SERVER_ERROR', message: 'boom', issue: null, debug_id: null, details: [] } } as any;
      }
    }
    const ctx2: Ctx = { ...ctx, adapter: new BrokenRefunds() };
    const proof = await verifyPairInSandbox(ctx2, run.id, 'pair_04');
    expect(proof.agrees_with_shadow).toBe(false);
    expect(proof.scenarios.some((s) => s.shadow_failed_invariants.includes('ONE_REFUND_PER_LOGICAL_REQUEST') && !s.failed_invariants.includes('ONE_REFUND_PER_LOGICAL_REQUEST'))).toBe(true);
    // Lane 2 never rewrites Lane 1.
    expect((await ctx.store.get('test_runs', run.id))!.release_decision).toBe('BLOCK');
  });
});

describe('the stores agree on the integrity rules the pipeline relies on', () => {
  it('unique scenario keys per run, unique decision per scenario+version', async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT);
    const s = (await ctx.store.list('scenarios', { test_run_id: run.id }))[0];
    await expect(ctx.store.insert('scenarios', { ...s, id: 'dup' })).rejects.toThrow(/unique/i);
    const d = (await ctx.store.list('policy_decisions', { test_run_id: run.id }))[0];
    await expect(ctx.store.insert('policy_decisions', { ...d, id: 'dup' })).rejects.toThrow(/unique/i);
    const m = new MemoryStore();
    await expect(m.insert('test_runs', { ...(await ctx.store.get('test_runs', run.id))!, id: 'orphan' })).rejects.toThrow(/foreign key/i);
  });
});
