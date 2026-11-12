import type { Store, TestRunRow, RunStage, RunStageRow } from '../store/types';
import { RUN_STAGES } from '../store/tables';
import { ConflictError, NotFoundError } from '../errors';
import { scrubString } from '../security/sanitize';
import { log } from '../security/log';

/**
 * Per-run state machine
 *
 *   CREATED → GENERATING → TWINS_READY → EVALUATING → EVALUATED → EXECUTING → COMPLETED → DECIDED
 *
 * - Every stage call checks the current state, takes a LEASE with an atomic compare-and-set (so exactly one
 *   concurrent caller proceeds), returns the stored result when the stage already completed, refuses illegal
 *   transitions with 409, persists the failure (stage reverts, failed_stage/last_error set) and can be resumed:
 *   an expired lease is taken over, a failed stage is simply called again.
 * - All writes of a stage commit in ONE transaction together with the stage transition, so a stage is never
 *   half-applied.
 * - The unique stage key is run_stages.id = `${runId}:${stageName}` (UNIQUE (run_id, stage_name)).
 */
export type StageName = 'GENERATE_TWINS' | 'EVALUATE' | 'EXECUTE';

interface StageDef {
  from: RunStage;
  running: RunStage;
  to: RunStage;
  hint: string;
}
export const STAGE_DEFS: Record<StageName, StageDef> = {
  GENERATE_TWINS: { from: 'CREATED', running: 'GENERATING', to: 'TWINS_READY', hint: 'twins have already been generated or the run is in a later stage' },
  EVALUATE: { from: 'TWINS_READY', running: 'EVALUATING', to: 'EVALUATED', hint: 'no scenarios: generate twins first' },
  EXECUTE: { from: 'EVALUATED', running: 'EXECUTING', to: 'COMPLETED', hint: 'evaluate the run first' },
};

const LEGACY_STATUS: Record<RunStage, TestRunRow['status']> = {
  CREATED: 'created',
  GENERATING: 'created',
  TWINS_READY: 'twins_generated',
  EVALUATING: 'twins_generated',
  EVALUATED: 'evaluated',
  EXECUTING: 'evaluated',
  COMPLETED: 'completed',
  DECIDED: 'completed',
};
export const legacyStatus = (s: RunStage) => LEGACY_STATUS[s];
export const stageRank = (s: RunStage) => RUN_STAGES.indexOf(s);

export const LEASE_MS = 120_000;

export interface StageClock {
  now(): number;
}
export const systemClock: StageClock = { now: () => Date.now() };
const iso = (ms: number) => new Date(ms).toISOString();

const safeMsg = (e: unknown) => scrubString(e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Run one stage. `work` does the slow/untrusted part (agents, simulation) WITHOUT holding a transaction and
 * returns a `commit` function that performs every database write for the stage inside the stage transaction.
 */
export async function runStage<T>(
  store: Store,
  runId: string,
  name: StageName,
  deps: {
    clock?: StageClock;
    alreadyDone: (run: TestRunRow) => Promise<T>;
    work: (run: TestRunRow) => Promise<(tx: Store) => Promise<T>>;
  },
): Promise<T> {
  const clock = deps.clock ?? systemClock;
  const def = STAGE_DEFS[name];
  const run0 = await store.get('test_runs', runId);
  if (!run0) throw new NotFoundError('test run');

  // 1. Already completed (or beyond) → idempotent: return the stored result.
  if (stageRank(run0.stage) >= stageRank(def.to)) return deps.alreadyDone(run0);

  // 2. Illegal transition / someone else is working.
  if (run0.stage === def.running) {
    const lease = run0.locked_until ? Date.parse(run0.locked_until) : 0;
    if (lease > clock.now()) throw new ConflictError(`${name.toLowerCase().replace('_', ' ')} is already in progress for this run; retry in a moment`);
    log('warn', 'taking over a stale stage lease', { run_id: runId, stage: name });
  } else if (run0.stage !== def.from) {
    throw new ConflictError(`cannot ${name.toLowerCase().replace('_', ' ')} while the run is ${run0.stage} (${def.hint})`);
  }

  // 3. Acquire the lease atomically (compare-and-set on the exact state we observed).
  const stageId = `${runId}:${name}`;
  const run = await store.transaction(async (tx) => {
    const got = await tx.compareAndSet('test_runs', runId, { stage: run0.stage, locked_until: run0.locked_until }, { stage: def.running, status: LEGACY_STATUS[def.running], locked_until: iso(clock.now() + LEASE_MS) });
    if (!got) return null;
    const prev = await tx.get('run_stages', stageId);
    const now = iso(clock.now());
    if (prev) await tx.update('run_stages', stageId, { status: 'RUNNING', attempts: prev.attempts + 1, started_at: now, finished_at: null, locked_until: iso(clock.now() + LEASE_MS), last_error: null });
    else await tx.insert('run_stages', { id: stageId, run_id: runId, stage_name: name, status: 'RUNNING', attempts: 1, started_at: now, finished_at: null, locked_until: iso(clock.now() + LEASE_MS), last_error: null });
    return got;
  });
  if (!run) throw new ConflictError(`${name.toLowerCase().replace('_', ' ')} was started by another request; retry in a moment`);

  // 4. Do the work, then commit stage writes + transition atomically.
  try {
    const commit = await deps.work(run);
    return await store.transaction(async (tx) => {
      const still = await tx.compareAndSet('test_runs', runId, { stage: def.running }, {});
      if (!still) throw new ConflictError('the stage lease was lost while working; results discarded');
      const result = await commit(tx);
      await tx.update('test_runs', runId, { stage: def.to, status: LEGACY_STATUS[def.to], locked_until: null, failed_stage: null, last_error: null });
      await tx.update('run_stages', stageId, { status: 'DONE', finished_at: iso(clock.now()), locked_until: null });
      return result;
    });
  } catch (e) {
    // 5. Persist the failure and make the stage resumable.
    const message = safeMsg(e);
    try {
      await store.transaction(async (tx) => {
        const reverted = await tx.compareAndSet('test_runs', runId, { stage: def.running }, { stage: def.from, status: 'failed', locked_until: null, failed_stage: name, last_error: message });
        if (reverted) await tx.update('run_stages', stageId, { status: 'FAILED', finished_at: iso(clock.now()), locked_until: null, last_error: message });
      });
    } catch (inner) {
      log('error', 'could not persist stage failure', { run_id: runId, stage: name, error: safeMsg(inner) });
    }
    throw e;
  }
}

/** A lease on an arbitrary key (e.g. SANDBOX_PROOF:pair_03) that does not move the run's state. */
export async function withLease<T>(
  store: Store,
  runId: string,
  key: string,
  fn: () => Promise<T>,
  clock: StageClock = systemClock,
): Promise<T> {
  const id = `${runId}:${key}`;
  const now = clock.now();
  const acquired = await store.transaction(async (tx) => {
    const prev = await tx.get('run_stages', id);
    const lease = iso(now + LEASE_MS);
    if (!prev) {
      await tx.insert('run_stages', { id, run_id: runId, stage_name: key, status: 'RUNNING', attempts: 1, started_at: iso(now), finished_at: null, locked_until: lease, last_error: null });
      return true;
    }
    if (prev.status === 'RUNNING' && prev.locked_until && Date.parse(prev.locked_until) > now) return false;
    const won = await tx.compareAndSet('run_stages', id, { status: prev.status, attempts: prev.attempts }, { status: 'RUNNING', attempts: prev.attempts + 1, started_at: iso(now), finished_at: null, locked_until: lease, last_error: null });
    return !!won;
  });
  if (!acquired) throw new ConflictError(`${key} is already in progress for this run; retry in a moment`);
  try {
    const v = await fn();
    await store.update('run_stages', id, { status: 'DONE', finished_at: iso(clock.now()), locked_until: null });
    return v;
  } catch (e) {
    await store.update('run_stages', id, { status: 'FAILED', finished_at: iso(clock.now()), locked_until: null, last_error: safeMsg(e) }).catch(() => undefined);
    throw e;
  }
}

export async function stageRows(store: Store, runId: string): Promise<RunStageRow[]> {
  return store.list('run_stages', { run_id: runId });
}
