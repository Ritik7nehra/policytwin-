import type { Ctx } from '../pipeline';
import { claimDueJobs } from './queue';
import { processWebhookEvent, type WebhookEvent } from '../paypal/webhooks';
import { storeWebhookState } from '../paypal/webhook-store';
import { log } from '../security/log';

/**
 * Drain due webhook jobs. Idempotent and safe to run from several instances: a job is claimed with a
 * compare-and-set + lease, and processing itself is lifecycle-guarded (a PROCESSED event is never re-applied).
 */
export async function drainWebhookJobs(ctx: Ctx, opts: { nowMs?: number; limit?: number } = {}): Promise<{ claimed: number; processed: number; retrying: number; failed: number }> {
  const jobs = await claimDueJobs(ctx.store, { kind: 'webhook', nowMs: opts.nowMs, limit: opts.limit ?? 10 });
  const out = { claimed: jobs.length, processed: 0, retrying: 0, failed: 0 };
  for (const job of jobs) {
    const event = (job.payload_json as { event: WebhookEvent }).event;
    try {
      const r = await processWebhookEvent({ state: storeWebhookState(ctx.store, { nowMs: opts.nowMs !== undefined ? () => opts.nowMs! : undefined }), adapter: ctx.adapter, mode: 'canonical_dedupe' }, event);
      if (r.outcome === 'PROCESSED' || r.outcome === 'DUPLICATE') out.processed++;
      else if (r.outcome === 'FAILED_RETRYABLE') out.retrying++;
      else if (r.outcome === 'FAILED_PERMANENT') out.failed++;
    } catch (e) {
      log('error', 'webhook job crashed', { job_id: job.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

const g = globalThis as unknown as { __policytwin_worker?: ReturnType<typeof setInterval> };

/** In-process poller (durability comes from the jobs table, not from this timer). */
export function startJobWorker(ctx: Ctx, everyMs = 15_000): void {
  if (g.__policytwin_worker) return;
  g.__policytwin_worker = setInterval(() => {
    drainWebhookJobs(ctx).catch((e) => log('error', 'job worker tick failed', { error: e instanceof Error ? e.message : String(e) }));
  }, everyMs);
  g.__policytwin_worker.unref?.();
}
