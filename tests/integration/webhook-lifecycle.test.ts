import { beforeEach, describe, expect, it } from 'vitest';
import { SimulatedPayPal } from '@/lib/paypal/simulated';
import { MAX_WEBHOOK_ATTEMPTS, processWebhookEvent, normalizeEvent, type WebhookEvent } from '@/lib/paypal/webhooks';
import { storeWebhookState } from '@/lib/paypal/webhook-store';
import { drainWebhookJobs } from '@/lib/jobs/worker';
import { claimDueJobs, enqueueJob, failJob, queueStats } from '@/lib/jobs/queue';
import { MemoryStore } from '@/lib/store/memory';
import type { Ctx } from '@/lib/pipeline';
import { OfflineLlm } from '@/lib/agents/llm';
import { resetRateLimits } from '@/lib/security/ratelimit';
import * as webhookRoute from '@/app/api/webhooks/paypal/route';

const T0 = Date.parse('2026-03-01T00:00:00Z');
const ev = (id: string, capId: string, type = 'PAYMENT.CAPTURE.COMPLETED'): WebhookEvent => ({ id, event_type: type, create_time: '2026-01-01T00:00:00Z', resource: { id: capId, status: 'COMPLETED' } });

/** A capture adapter whose canonical fetch can be made to fail, hang or succeed. */
class ControlledPayPal extends SimulatedPayPal {
  mode_: 'ok' | 'http' | 'throw' | 'gate' = 'ok';
  httpStatus = 503;
  gate: Promise<void> = Promise.resolve();
  calls = 0;
  override async getCapture(id: string) {
    this.calls++;
    if (this.mode_ === 'throw') throw new TypeError('fetch failed');
    if (this.mode_ === 'http') return { ok: false as const, status: this.httpStatus, error: { name: 'X', message: 'down', issue: null }, replayed: false, call: { method: 'GET', path: `/v2/payments/captures/${id}`, request_id: null, body: null }, raw: {} } as any;
    if (this.mode_ === 'gate') await this.gate;
    return super.getCapture(id);
  }
}

let pp: ControlledPayPal;
let store: MemoryStore;
let ctx: Ctx;
let capId: string;
beforeEach(async () => {
  resetRateLimits();
  pp = new ControlledPayPal();
  store = new MemoryStore();
  ctx = { store, adapter: pp, llm: new OfflineLlm() };
  const o = await pp.createOrder({ requestId: 'o', intent: 'CAPTURE', amount: { currency_code: 'USD', value: '40.00' }, referenceId: 'r' });
  if (!o.ok) throw new Error('order');
  await pp.confirmPaymentSource(o.data.id, 'c');
  const c = await pp.captureOrder(o.data.id, 'cap');
  if (!c.ok) throw new Error('capture');
  capId = c.data.id;
});

const run = (event: WebhookEvent, state = storeWebhookState(store, { nowMs: () => T0, random: () => 0.999 })) => processWebhookEvent({ state, adapter: pp, mode: 'canonical_dedupe' }, normalizeEvent(event));

describe('webhook lifecycle: VERIFIED → PROCESSING → PROCESSED', () => {
  it('records status, attempt count, timestamps and a finished job', async () => {
    const r = await run(ev('WH-1', capId));
    expect(r).toMatchObject({ outcome: 'PROCESSED', applied: true, canonical_fetched: true });
    expect(await store.get('webhook_events', 'WH-1')).toMatchObject({ status: 'PROCESSED', attempts: 1, last_error: null, next_attempt_at: null, locked_until: null });
    expect((await store.get('webhook_events', 'WH-1'))!.processed_at).toBeTruthy();
    expect((await store.get('webhook_events', 'WH-1'))!.verified_at).toBeTruthy();
    expect((await store.list('jobs'))[0]).toMatchObject({ kind: 'webhook', status: 'DONE' });
    expect((await store.get('resource_states', capId))?.status).toBe('COMPLETED');
  });

  it('a duplicate is ignored ONLY because the stored event is PROCESSED (attempts and state unchanged, no second fetch)', async () => {
    await run(ev('WH-1', capId));
    const fetches = pp.calls;
    const dup = await run(ev('WH-1', capId));
    expect(dup).toMatchObject({ outcome: 'DUPLICATE', ignored_duplicate: true, applied: false });
    expect(pp.calls).toBe(fetches);
    expect((await store.get('webhook_events', 'WH-1'))!.attempts).toBe(1);
    expect(await store.count('jobs')).toBe(1);
  });

  it('stores only a sanitized payload (links, payer data and tokens are never persisted)', async () => {
    await run({ ...ev('WH-2', capId), resource: { id: capId, status: 'COMPLETED', links: [{ rel: 'self', href: 'https://x?token=secret' }], payer: { email_address: 'a@b.co' } } as any });
    const stored = JSON.stringify((await store.get('webhook_events', 'WH-2'))!.payload_json);
    expect(stored).not.toMatch(/token=secret|a@b\.co|payer/);
    expect(stored).toContain(capId);
  });
});

describe('failure → FAILED_RETRYABLE → redelivery', () => {
  it('canonical fetch returns 503: event is NOT processed, state unchanged, failure + backoff recorded, job re-queued', async () => {
    pp.mode_ = 'http';
    const r = await run(ev('WH-1', capId));
    expect(r).toMatchObject({ outcome: 'FAILED_RETRYABLE', applied: false, ignored_duplicate: false });
    expect(r.reason).toMatch(/HTTP 503/);
    expect(await store.get('resource_states', capId)).toBeNull(); // local state untouched
    const row = (await store.get('webhook_events', 'WH-1'))!;
    expect(row).toMatchObject({ status: 'FAILED_RETRYABLE', attempts: 1, locked_until: null });
    expect(row.last_error).toMatch(/503/);
    expect(Date.parse(row.next_attempt_at!)).toBeGreaterThan(T0);
    const job = (await store.list('jobs'))[0];
    expect(job).toMatchObject({ status: 'QUEUED', last_error: row.last_error });
    expect(job.run_at).toBe(row.next_attempt_at);
  });

  it('PayPal redelivers the same event after the outage → it is processed (not swallowed as a duplicate)', async () => {
    pp.mode_ = 'http';
    await run(ev('WH-1', capId));
    pp.mode_ = 'ok';
    const again = await run(ev('WH-1', capId));
    expect(again).toMatchObject({ outcome: 'PROCESSED', applied: true, ignored_duplicate: false });
    expect(await store.get('webhook_events', 'WH-1')).toMatchObject({ status: 'PROCESSED', attempts: 2, last_error: null });
    expect((await store.list('jobs'))[0].status).toBe('DONE');
  });

  it('a thrown network error (timeout / circuit open) is also retryable and never marks the event processed', async () => {
    pp.mode_ = 'throw';
    const r = await run(ev('WH-1', capId));
    expect(r.outcome).toBe('FAILED_RETRYABLE');
    expect(r.reason).toMatch(/canonical fetch error/);
    expect((await store.get('webhook_events', 'WH-1'))!.status).toBe('FAILED_RETRYABLE');
  });

  it('backoff grows with each failed attempt', async () => {
    pp.mode_ = 'http';
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await run(ev('WH-1', capId));
      waits.push(Date.parse((await store.get('webhook_events', 'WH-1'))!.next_attempt_at!) - T0);
    }
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(waits[3]).toBeGreaterThan(waits[0] * 4);
    expect((await store.get('webhook_events', 'WH-1'))!.attempts).toBe(4);
  });

  it('a non-retryable response (HTTP 400) is FAILED_PERMANENT and later redeliveries are not re-applied', async () => {
    pp.mode_ = 'http';
    pp.httpStatus = 400;
    expect((await run(ev('WH-1', capId))).outcome).toBe('FAILED_PERMANENT');
    expect(await store.get('webhook_events', 'WH-1')).toMatchObject({ status: 'FAILED_PERMANENT', next_attempt_at: null });
    expect((await store.list('jobs'))[0].status).toBe('FAILED');
    pp.mode_ = 'ok';
    expect((await run(ev('WH-1', capId))).outcome).toBe('FAILED_PERMANENT');
    expect(await store.get('resource_states', capId)).toBeNull();
  });

  it(`gives up after ${MAX_WEBHOOK_ATTEMPTS} attempts`, async () => {
    pp.mode_ = 'http';
    let last = '';
    for (let i = 0; i < MAX_WEBHOOK_ATTEMPTS; i++) last = (await run(ev('WH-1', capId))).outcome;
    expect(last).toBe('FAILED_PERMANENT');
    expect((await store.get('webhook_events', 'WH-1'))!.attempts).toBe(MAX_WEBHOOK_ATTEMPTS);
  });
});

describe('concurrent delivery of the same event', () => {
  it('a duplicate that arrives while the first is PROCESSING is not swallowed and not double-applied', async () => {
    let release!: () => void;
    pp.mode_ = 'gate';
    pp.gate = new Promise<void>((r) => (release = r));
    const first = run(ev('WH-1', capId));
    await new Promise((r) => setTimeout(r, 10));
    expect((await store.get('webhook_events', 'WH-1'))!.status).toBe('PROCESSING');
    const dup = await run(ev('WH-1', capId));
    expect(dup).toMatchObject({ outcome: 'IN_PROGRESS', ignored_duplicate: true, applied: false });
    release();
    expect((await first).outcome).toBe('PROCESSED');
    expect(await store.count('webhook_events')).toBe(1);
    expect(await store.count('jobs')).toBe(1);
    expect(pp.calls).toBe(1); // the canonical fetch happened once
    expect((await store.get('webhook_events', 'WH-1'))!.status).toBe('PROCESSED');
  });

  it('a crashed worker (PROCESSING with an expired lease) is taken over by the next delivery', async () => {
    const state = (t: number) => storeWebhookState(store, { nowMs: () => t });
    await state(T0).beginEvent({ event_id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_id: capId, payload: ev('WH-1', capId) }); // …and the process dies here
    expect((await store.get('webhook_events', 'WH-1'))!.status).toBe('PROCESSING');
    expect((await run(ev('WH-1', capId), state(T0 + 1000))).outcome).toBe('IN_PROGRESS'); // lease still valid
    const later = await run(ev('WH-1', capId), state(T0 + 10 * 60_000));
    expect(later).toMatchObject({ outcome: 'PROCESSED', applied: true });
    expect((await store.get('webhook_events', 'WH-1'))!.attempts).toBe(2);
  });

  it('simultaneous first deliveries race on the primary key: exactly one wins, no duplicate rows', async () => {
    const results = await Promise.all([run(ev('WH-9', capId)), run(ev('WH-9', capId)), run(ev('WH-9', capId))]);
    expect(results.filter((r) => r.outcome === 'PROCESSED' && r.applied)).toHaveLength(1);
    expect(await store.count('webhook_events')).toBe(1);
    expect(await store.count('jobs')).toBe(1);
  });
});

describe('durable job queue', () => {
  it('drains due jobs only; a failed event is retried after its backoff by the worker, then completes', async () => {
    pp.mode_ = 'http';
    await run(ev('WH-1', capId));
    const row = (await store.get('webhook_events', 'WH-1'))!;
    const due = Date.parse(row.next_attempt_at!);

    expect(await drainWebhookJobs(ctx, { nowMs: due - 1 })).toMatchObject({ claimed: 0 }); // not due yet

    pp.mode_ = 'http';
    expect(await drainWebhookJobs(ctx, { nowMs: due + 1 })).toMatchObject({ claimed: 1, retrying: 1, processed: 0 }); // still down → rescheduled
    const row2 = (await store.get('webhook_events', 'WH-1'))!;
    expect(row2.attempts).toBe(2);
    expect(Date.parse(row2.next_attempt_at!)).toBeGreaterThan(due);

    pp.mode_ = 'ok';
    expect(await drainWebhookJobs(ctx, { nowMs: Date.parse(row2.next_attempt_at!) + 1 })).toMatchObject({ claimed: 1, processed: 1 });
    expect(await store.get('webhook_events', 'WH-1')).toMatchObject({ status: 'PROCESSED', attempts: 3 });
    expect(await queueStats(store)).toMatchObject({ queued: 0, running: 0, failed: 0, done: 1 });
    expect((await store.get('resource_states', capId))?.status).toBe('COMPLETED');
  });

  it('claiming is exclusive (two workers never get the same job) and a dead worker’s lease expires', async () => {
    await enqueueJob(store, { kind: 'k', dedupeKey: 'a', payload: {}, nowMs: T0 });
    const [w1, w2] = await Promise.all([claimDueJobs(store, { kind: 'k', nowMs: T0 }), claimDueJobs(store, { kind: 'k', nowMs: T0 })]);
    expect(w1.length + w2.length).toBe(1);
    expect(await claimDueJobs(store, { kind: 'k', nowMs: T0 + 1000 })).toHaveLength(0);
    expect(await claimDueJobs(store, { kind: 'k', nowMs: T0 + 5 * 60_000 })).toHaveLength(1); // lease expired → re-claimed
  });

  it('enqueue is idempotent per dedupe key, and failJob reschedules then gives up at max_attempts', async () => {
    const a = await enqueueJob(store, { kind: 'k', dedupeKey: 'same', payload: { n: 1 }, maxAttempts: 2, nowMs: T0 });
    const b = await enqueueJob(store, { kind: 'k', dedupeKey: 'same', payload: { n: 2 }, nowMs: T0 });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    const [j1] = await claimDueJobs(store, { kind: 'k', nowMs: T0 });
    expect((await failJob(store, j1, { error: 'x', nowMs: T0, random: () => 0.5 })).status).toBe('QUEUED');
    const [j2] = await claimDueJobs(store, { kind: 'k', nowMs: T0 + 24 * 3600_000 });
    expect((await failJob(store, j2, { error: 'token=abc Bearer abcdefghijklmnop123', nowMs: T0 })).status).toBe('FAILED');
    expect((await store.get('jobs', a.job.id))!.last_error).not.toMatch(/abcdefghijklmnop123/);
  });
});

describe('POST /api/webhooks/paypal uses the same lifecycle', () => {
  const post = (body: unknown) => webhookRoute.POST(new Request('http://t/x', { method: 'POST', headers: { 'content-type': 'application/json', 'x-policytwin-simulated': 'true' }, body: JSON.stringify(body) }));
  beforeEach(() => {
    (globalThis as any).__policytwin_ctx = Promise.resolve(ctx);
  });

  it('canonical fetch failure → 200 FAILED_RETRYABLE (PayPal need not retry; our queue will); redelivery after recovery → PROCESSED', async () => {
    pp.mode_ = 'http';
    const bad = await post(ev('WH-5', capId));
    expect(bad.status).toBe(200);
    expect(((await bad.json()) as any).result.outcome).toBe('FAILED_RETRYABLE');
    pp.mode_ = 'ok';
    const good = await post(ev('WH-5', capId));
    expect(((await good.json()) as any).result).toMatchObject({ outcome: 'PROCESSED', applied: true });
    const dup = await post(ev('WH-5', capId));
    expect(((await dup.json()) as any).result.outcome).toBe('DUPLICATE');
  });

  it('refuses oversized bodies (413) before parsing anything', async () => {
    const res = await post({ id: 'x'.repeat(300_000), event_type: 'X', resource: { id: 'y' } });
    expect(res.status).toBe(413);
    expect(await store.count('webhook_events')).toBe(0);
  });
});
