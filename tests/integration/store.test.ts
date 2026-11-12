import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { MemoryStore } from '@/lib/store/memory';
import { PgStore } from '@/lib/store/pg';
import { ConstraintError } from '@/lib/store/errors';
import type { Store, PolicyRow, PolicyVersionRow, TestRunRow, ScenarioRow, DecisionRow, InvariantRow } from '@/lib/store/types';
import { runDemoFlow } from '@/lib/pipeline';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { SimulatedPayPal } from '@/lib/paypal/simulated';
import { OfflineLlm } from '@/lib/agents/llm';
import { resetSessionData } from '@/lib/security/guard';

async function pgMemStore(): Promise<Store> {
  const { Pool } = newDb().adapters.createPg();
  const s = new PgStore(new Pool());
  await s.init();
  return s;
}
async function memStore(): Promise<Store> {
  const s = new MemoryStore();
  await s.init();
  return s;
}

/**
 * Real PostgreSQL, opt-in: set TEST_DATABASE_URL (e.g. postgres://postgres@127.0.0.1:54329/policytwin_test).
 * The suite DROPS and recreates the public schema, so it refuses any database whose name lacks "test".
 */
const REAL_URL = process.env.TEST_DATABASE_URL?.trim();
async function realPgStore(): Promise<Store> {
  const { Pool } = await import('pg');
  const dbName = new URL(REAL_URL!).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}": TEST_DATABASE_URL must point at a database with "test" in its name.`);
  const pool = new Pool({ connectionString: REAL_URL, max: 10 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const s = new PgStore(pool);
  await s.init();
  return s;
}

/**
 * Backend capabilities:
 *  - pg-mem returns the existing row from "ON CONFLICT DO NOTHING RETURNING", and cannot roll back transactions
 *    (a known pg-mem limitation) — so rollback/atomicity assertions run on the memory store and on REAL PostgreSQL.
 */
const SUITES: [string, () => Promise<Store>, { realTransactions: boolean }][] = [
  ['memory', memStore, { realTransactions: true }],
  ['postgres (pg-mem)', pgMemStore, { realTransactions: false }],
  ...(REAL_URL ? ([['postgres (real, TEST_DATABASE_URL)', realPgStore, { realTransactions: true }]] as [string, () => Promise<Store>, { realTransactions: boolean }][]) : []),
];

const T0 = '2026-01-01T00:00:00.000Z';
const policy = (id: string, owner = 's1'): PolicyRow => ({ id, name: `P ${id}`, description: 'd', created_by: 'me', owner_session: owner, created_at: T0, intake_json: DEMO_POLICY_INPUT });
const version = (id: string, policy_id: string, v: number): PolicyVersionRow => ({ id, policy_id, version: v, label: 'A', source_text: 't', structured_policy_json: null, analysis_json: null, status: 'current', created_at: T0 });
const run = (id: string, policy_id: string, a: string, b: string, parent: string | null = null): TestRunRow => ({
  id, policy_id, policy_version_a: a, policy_version_b: b, parent_run_id: parent, status: 'created', stage: 'CREATED', rev: 0, locked_until: null, failed_stage: null, last_error: null,
  release_decision: null, started_at: T0, completed_at: null, created_by: 'me', owner_session: 's1', options_json: { adversarial: true }, report_json: null,
});
const scenario = (id: string, run_id: string, key: string): ScenarioRow => ({ id, test_run_id: run_id, pair_id: 'pair_01', scenario_type: 'base', scenario_key: key, input_json: {} as any, changed_field: 'amount', expected_behavior: 'must_differ', meta_json: { label: 'l', origin: 'core', category: 'amount_boundary', rationale: 'r', severity_if_violated: 'high' } });
const decision = (id: string, run_id: string, sid: string, v: string): DecisionRow => ({ id, test_run_id: run_id, scenario_id: sid, policy_version: v, decision: 'REVIEW', reason_codes: [], explanation: 'e', detail_json: { flags: [], conditions_triggered: [], refund_amount: null } });
const invariant = (id: string, run_id: string, sid: string, v: string, code: string, lane: 'shadow' | 'sandbox_proof' = 'shadow'): InvariantRow => ({ id, test_run_id: run_id, scenario_id: sid, policy_version: v, invariant_code: code, lane, passed: true, severity: 'critical', evidence_json: { name: 'n', applicable: true, detail: 'd', evidence: {} } });

async function seed(s: Store) {
  await s.insert('policies', policy('p1'));
  await s.insert('policy_versions', version('v1', 'p1', 1));
  await s.insert('policy_versions', version('v2', 'p1', 2));
  await s.insert('test_runs', run('r1', 'p1', 'v1', 'v2'));
  await s.insert('scenarios', scenario('sc1', 'r1', 'scenario_01'));
}
const kind = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof ConstraintError ? e.kind : `other:${(e as Error).message}`));

describe.each(SUITES)('Store contract — %s', (_name, make, caps) => {
  it('inserts, gets, lists with a filter, updates and upserts', async () => {
    const s = await make();
    await s.insert('policies', policy('p1'));
    await s.insert('policies', policy('p2'));
    expect((await s.get('policies', 'p1'))?.name).toBe('P p1');
    expect(await s.get('policies', 'nope')).toBeNull();
    expect((await s.list('policies')).map((p) => p.id)).toEqual(['p1', 'p2']); // insertion order
    expect((await s.list('policies', { name: 'P p2' })).map((p) => p.id)).toEqual(['p2']);
    expect(await s.count('policies')).toBe(2);
    expect((await s.update('policies', 'p1', { description: 'changed' })).description).toBe('changed');
    await s.upsert('resource_states', { id: 'CAP', status: 'COMPLETED', as_of: '1' });
    await s.upsert('resource_states', { id: 'CAP', status: 'REFUNDED', as_of: '2' });
    expect(await s.list('resource_states')).toHaveLength(1);
    expect((await s.get('resource_states', 'CAP'))?.status).toBe('REFUNDED');
  });

  it('round-trips JSON columns and returns TIMESTAMPTZ as ISO strings', async () => {
    const s = await make();
    await s.insert('policies', policy('p1'));
    const got = await s.get('policies', 'p1');
    expect(got?.intake_json).toEqual(DEMO_POLICY_INPUT);
    expect(got?.created_at).toBe(T0);
  });

  it('supports range conditions on timestamps and IS NULL matching', async () => {
    const s = await make();
    await s.insert('policies', { ...policy('p1'), created_at: '2026-01-01T00:00:00.000Z' });
    await s.insert('policies', { ...policy('p2'), created_at: '2026-06-01T00:00:00.000Z' });
    expect((await s.list('policies', { created_at: { gte: '2026-03-01T00:00:00.000Z' } })).map((p) => p.id)).toEqual(['p2']);
    expect((await s.list('policies', { created_at: { lt: '2026-03-01T00:00:00.000Z' } })).map((p) => p.id)).toEqual(['p1']);
    await s.insert('policy_versions', version('v1', 'p1', 1));
    expect(await s.count('policy_versions', { structured_policy_json: null })).toBe(1);
  });

  describe('integrity constraints (identical on every backend)', () => {
    it('NOT NULL, status CHECK lists and foreign keys', async () => {
      const s = await make();
      expect(await kind(s.insert('policies', { ...policy('x'), owner_session: null as any }))).toBe('not_null');
      await s.insert('policies', policy('p1'));
      expect(await kind(s.insert('policy_versions', { ...version('v', 'p1', 1), label: 'Z' as any }))).toBe('check');
      expect(await kind(s.insert('policy_versions', { ...version('v', 'missing', 1) }))).toBe('foreign_key');
      expect(await kind(s.insert('policies', { ...policy('y'), created_at: 'not a date' }))).toMatch(/check|other/);
    });

    it('unique policy version numbers per policy', async () => {
      const s = await make();
      await s.insert('policies', policy('p1'));
      await s.insert('policy_versions', version('v1', 'p1', 1));
      expect(await kind(s.insert('policy_versions', version('v1b', 'p1', 1)))).toBe('unique');
      await s.insert('policies', policy('p2'));
      expect(await kind(s.insert('policy_versions', version('v2a', 'p2', 1)))).toBe('ok'); // same number, different policy
    });

    it('unique scenario key per run, unique decision per scenario+version, unique invariant per scenario+version+code+lane', async () => {
      const s = await make();
      await seed(s);
      expect(await kind(s.insert('scenarios', scenario('sc1b', 'r1', 'scenario_01')))).toBe('unique');
      await s.insert('policy_decisions', decision('d1', 'r1', 'sc1', 'A'));
      expect(await kind(s.insert('policy_decisions', decision('d2', 'r1', 'sc1', 'A')))).toBe('unique');
      expect(await kind(s.insert('policy_decisions', decision('d3', 'r1', 'sc1', 'B')))).toBe('ok');
      await s.insert('invariant_results', invariant('i1', 'r1', 'sc1', 'B', 'NO_DOUBLE_REFUND'));
      expect(await kind(s.insert('invariant_results', invariant('i2', 'r1', 'sc1', 'B', 'NO_DOUBLE_REFUND')))).toBe('unique');
      expect(await kind(s.insert('invariant_results', invariant('i3', 'r1', 'sc1', 'B', 'NO_DOUBLE_REFUND', 'sandbox_proof')))).toBe('ok'); // other lane
    });

    it('at most one re-run per approved repair (unique parent_run_id)', async () => {
      const s = await make();
      await seed(s);
      await s.insert('policy_versions', { ...version('v3', 'p1', 3), label: 'C' });
      await s.insert('test_runs', run('r2', 'p1', 'v1', 'v3', 'r1'));
      expect(await kind(s.insert('test_runs', run('r3', 'p1', 'v1', 'v3', 'r1')))).toBe('unique');
      expect(await kind(s.insert('test_runs', run('r4', 'p1', 'v1', 'v3', null)))).toBe('ok'); // NULL parents never collide
      expect(await kind(s.insert('test_runs', run('r5', 'p1', 'v1', 'v3', null)))).toBe('ok');
    });

    it('restricts deleting a row that is still referenced', async () => {
      const s = await make();
      await seed(s);
      expect(await kind(s.deleteWhere('policies', { id: 'p1' }))).toBe('foreign_key');
    });
  });

  it('compareAndSet lets exactly one of many concurrent callers win', async () => {
    const s = await make();
    await seed(s);
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => s.compareAndSet('test_runs', 'r1', { stage: 'CREATED', locked_until: null }, { stage: 'GENERATING', last_error: `by ${i}` })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await s.get('test_runs', 'r1'))?.stage).toBe('GENERATING');
    expect(await s.compareAndSet('test_runs', 'r1', { stage: 'CREATED' }, { stage: 'EVALUATED' })).toBeNull();
  });

  it('transactions commit together; nested calls join the outer transaction', async () => {
    const s = await make();
    await s.transaction(async (tx) => {
      await tx.insert('policies', policy('p1'));
      await tx.transaction(async (inner) => {
        await inner.insert('policy_versions', version('v1', 'p1', 1));
      });
    });
    expect(await s.count('policies')).toBe(1);
    expect(await s.count('policy_versions')).toBe(1);
  });

  it.runIf(caps.realTransactions)('a failing transaction leaves NOTHING behind (rollback), and insertMany is all-or-nothing', async () => {
    const s = await make();
    await s.insert('policies', policy('p1'));
    await s.insert('policy_versions', version('v1', 'p1', 1));
    await expect(
      s.transaction(async (tx) => {
        await tx.insert('policies', policy('p9'));
        await tx.insert('policy_versions', version('v9', 'p9', 1));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await s.get('policies', 'p9')).toBeNull();
    expect(await s.get('policy_versions', 'v9')).toBeNull();
    // the second row violates UNIQUE (policy_id, version): the first row must not survive
    await expect(s.insertMany('policy_versions', [version('v10', 'p1', 10), version('v11', 'p1', 1)])).rejects.toBeInstanceOf(ConstraintError);
    expect(await s.get('policy_versions', 'v10')).toBeNull();
  });

  it('session reset deletes only that session’s data, children before parents', async () => {
    const s = await make();
    await runDemoFlow({ store: s, adapter: new SimulatedPayPal(), llm: new OfflineLlm() }, DEMO_POLICY_INPUT, { ownerSession: 'sA' });
    await runDemoFlow({ store: s, adapter: new SimulatedPayPal(), llm: new OfflineLlm() }, DEMO_POLICY_INPUT, { ownerSession: 'sB' });
    const before = await s.count('policies');
    const deleted = await resetSessionData(s, 'sA');
    expect(deleted.policies).toBe(1);
    expect(deleted.scenarios).toBe(20);
    expect(await s.count('policies')).toBe(before - 1);
    expect(await s.count('policies', { owner_session: 'sB' })).toBe(1);
    expect((await s.list('scenarios')).every((x) => x.test_run_id.length > 0)).toBe(true);
    expect(await s.count('scenarios')).toBe(20); // sB's scenarios are untouched
  });

  it('runs the whole pipeline on this store and reaches BLOCK', async () => {
    const s = await make();
    const { report } = await runDemoFlow({ store: s, adapter: new SimulatedPayPal(), llm: new OfflineLlm() }, DEMO_POLICY_INPUT);
    expect(report.release.decision).toBe('BLOCK');
    expect((await s.list('scenarios')).length).toBe(20);
    expect((await s.list('invariant_results')).length).toBeGreaterThan(100);
    const r = (await s.list('test_runs'))[0];
    expect(r.stage).toBe('COMPLETED');
    expect(r.status).toBe('completed');
  });
});
