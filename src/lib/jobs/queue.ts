import type { JobRow, Store } from '../store/types';
import { isUniqueViolation } from '../store/errors';
import { shortId } from '../util';
import { backoffDelay } from '../resilience';
import { scrubString } from '../security/sanitize';

/**
 * A deliberately small PostgreSQL-backed job queue: durable (rows survive restarts), idempotent to enqueue
 * (UNIQUE dedupe_key), claimed with an optimistic compare-and-set + lease (a crashed worker's lease expires and
 * the job is picked up again) and retried with exponential backoff. No external broker.
 */
export const JOB_LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 8;

const iso = (ms: number) => new Date(ms).toISOString();

export async function enqueueJob(store: Store, a: { kind: string; dedupeKey: string; payload: unknown; runAtMs?: number; maxAttempts?: number; nowMs?: number }): Promise<{ job: JobRow; created: boolean }> {
  const now = a.nowMs ?? Date.now();
  const row: JobRow = {
    id: shortId('job'),
    kind: a.kind,
    dedupe_key: a.dedupeKey,
    payload_json: a.payload,
    status: 'QUEUED',
    attempts: 0,
    max_attempts: a.maxAttempts ?? MAX_ATTEMPTS,
    run_at: iso(a.runAtMs ?? now),
    locked_until: null,
    last_error: null,
    created_at: iso(now),
    updated_at: iso(now),
  };
  try {
    return { job: await store.insert('jobs', row), created: true };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const existing = (await store.list('jobs', { dedupe_key: a.dedupeKey }))[0];
    if (!existing) throw e;
    return { job: existing, created: false };
  }
}

/** Claim up to `limit` due jobs (QUEUED and due, or RUNNING with an expired lease). */
export async function claimDueJobs(store: Store, a: { kind: string; limit?: number; nowMs?: number; leaseMs?: number }): Promise<JobRow[]> {
  const now = a.nowMs ?? Date.now();
  const candidates = (await store.list('jobs', { kind: a.kind })).filter(
    (j) => (j.status === 'QUEUED' && Date.parse(j.run_at) <= now) || (j.status === 'RUNNING' && j.locked_until !== null && Date.parse(j.locked_until) <= now),
  );
  const claimed: JobRow[] = [];
  for (const j of candidates.slice(0, a.limit ?? 10)) {
    const won = await store.compareAndSet('jobs', j.id, { status: j.status, attempts: j.attempts, locked_until: j.locked_until }, { status: 'RUNNING', attempts: j.attempts + 1, locked_until: iso(now + (a.leaseMs ?? JOB_LEASE_MS)), updated_at: iso(now) });
    if (won) claimed.push(won);
  }
  return claimed;
}

export async function completeJob(store: Store, id: string, nowMs = Date.now()): Promise<void> {
  await store.update('jobs', id, { status: 'DONE', locked_until: null, last_error: null, updated_at: iso(nowMs) });
}

/** Reschedule with exponential backoff + jitter, or give up (FAILED) once max_attempts is reached or the error is permanent. */
export async function failJob(store: Store, job: JobRow, a: { error: string; permanent?: boolean; nowMs?: number; random?: () => number }): Promise<{ status: 'QUEUED' | 'FAILED'; run_at: string }> {
  const now = a.nowMs ?? Date.now();
  const giveUp = a.permanent || job.attempts >= job.max_attempts;
  const delay = backoffDelay(job.attempts, 30_000, 6 * 3600_000, a.random);
  const run_at = giveUp ? job.run_at : iso(now + delay);
  await store.update('jobs', job.id, { status: giveUp ? 'FAILED' : 'QUEUED', run_at, locked_until: null, last_error: scrubString(a.error).slice(0, 300), updated_at: iso(now) });
  return { status: giveUp ? 'FAILED' : 'QUEUED', run_at };
}

export async function queueStats(store: Store): Promise<{ queued: number; running: number; failed: number; done: number }> {
  const [queued, running, failed, done] = await Promise.all(['QUEUED', 'RUNNING', 'FAILED', 'DONE'].map((s) => store.count('jobs', { status: s as JobRow['status'] })));
  return { queued, running, failed, done };
}
