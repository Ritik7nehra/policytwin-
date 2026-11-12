import type { Store, WebhookEventRow } from '../store/types';
import type { CaptureState } from '../types';
import { MAX_WEBHOOK_ATTEMPTS, type BeginResult, type FailInfo, type WebhookState } from './webhooks';
import { isUniqueViolation } from '../store/errors';
import { enqueueJob, JOB_LEASE_MS } from '../jobs/queue';
import { backoffDelay } from '../resilience';
import { scrubString, sanitizeFinancialEvidence } from '../security/sanitize';

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Webhook state persisted in the Store with the full lifecycle and a durable job per event:
 *   first sighting → row VERIFIED→PROCESSING + job (one transaction)
 *   success        → PROCESSED + job DONE
 *   failure        → FAILED_RETRYABLE (attempt count, last error, next_attempt_at via exponential backoff) + job re-queued
 *                    … or FAILED_PERMANENT (non-retryable, or attempts exhausted) + job FAILED
 */
export function storeWebhookState(store: Store, opts: { nowMs?: () => number; random?: () => number } = {}): WebhookState {
  const now = () => (opts.nowMs ?? Date.now)();
  const jobKey = (eventId: string) => `webhook:${eventId}`;

  async function jobFor(s: Store, eventId: string) {
    return (await s.list('jobs', { dedupe_key: jobKey(eventId) }))[0] ?? null;
  }

  return {
    async beginEvent(e): Promise<BeginResult> {
      return store.transaction(async (tx) => {
        const t = now();
        const existing = await tx.get('webhook_events', e.event_id);
        if (!existing) {
          const row: WebhookEventRow = {
            id: e.event_id,
            event_type: e.event_type,
            resource_id: e.resource_id,
            status: 'VERIFIED',
            attempts: 0,
            last_error: null,
            next_attempt_at: null,
            locked_until: null,
            received_at: iso(t),
            verified_at: iso(t),
            processed_at: null,
            payload_json: sanitizeFinancialEvidence(e.payload),
          };
          try {
            await tx.insert('webhook_events', row);
          } catch (err) {
            if (isUniqueViolation(err)) return 'in_progress' as BeginResult; // lost a race with a concurrent first delivery
            throw err;
          }
          await enqueueJob(tx, { kind: 'webhook', dedupeKey: jobKey(e.event_id), payload: { event: sanitizeFinancialEvidence(e.payload) }, nowMs: t });
          await tx.compareAndSet('webhook_events', e.event_id, { status: 'VERIFIED' }, { status: 'PROCESSING', attempts: 1, locked_until: iso(t + JOB_LEASE_MS) });
          return 'new' as BeginResult;
        }
        if (existing.status === 'PROCESSED') return 'duplicate_processed' as BeginResult;
        if (existing.status === 'FAILED_PERMANENT') return 'failed_permanent' as BeginResult;
        if (existing.status === 'PROCESSING' && existing.locked_until && Date.parse(existing.locked_until) > t) return 'in_progress' as BeginResult;
        // FAILED_RETRYABLE, VERIFIED/RECEIVED, or a PROCESSING attempt whose lease expired (crashed worker) → take it over.
        const won = await tx.compareAndSet(
          'webhook_events',
          e.event_id,
          { status: existing.status, attempts: existing.attempts },
          { status: 'PROCESSING', attempts: existing.attempts + 1, locked_until: iso(t + JOB_LEASE_MS) },
        );
        return (won ? 'retry' : 'in_progress') as BeginResult;
      });
    },

    async completeEvent(eventId) {
      await store.transaction(async (tx) => {
        const t = iso(now());
        await tx.update('webhook_events', eventId, { status: 'PROCESSED', processed_at: t, locked_until: null, last_error: null, next_attempt_at: null });
        const job = await jobFor(tx, eventId);
        if (job) await tx.update('jobs', job.id, { status: 'DONE', locked_until: null, last_error: null, updated_at: t });
      });
    },

    async failEvent(eventId, f: FailInfo) {
      return store.transaction(async (tx) => {
        const t = now();
        const ev = await tx.get('webhook_events', eventId);
        const attempts = ev?.attempts ?? 1;
        const permanent = !f.retryable || attempts >= MAX_WEBHOOK_ATTEMPTS;
        const status = permanent ? ('FAILED_PERMANENT' as const) : ('FAILED_RETRYABLE' as const);
        const next = permanent ? null : iso(t + backoffDelay(attempts, 30_000, 6 * 3600_000, opts.random));
        const error = scrubString(f.error).slice(0, 300);
        await tx.update('webhook_events', eventId, { status, last_error: error, next_attempt_at: next, locked_until: null });
        const job = await jobFor(tx, eventId);
        if (job) await tx.update('jobs', job.id, { status: permanent ? 'FAILED' : 'QUEUED', run_at: next ?? job.run_at, locked_until: null, last_error: error, updated_at: iso(t) });
        return { status, attempts };
      });
    },

    getResource: async (id) => {
      const r = await store.get('resource_states', id);
      return r ? { status: r.status as CaptureState, as_of: r.as_of } : null;
    },
    setResource: async (id, v) => {
      await store.upsert('resource_states', { id, status: v.status, as_of: v.as_of });
    },
  };
}

