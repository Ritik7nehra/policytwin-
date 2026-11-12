import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { offlineCtx } from '../helpers';
import { SimulatedPayPal } from '@/lib/paypal/simulated';
import type { Ctx } from '@/lib/pipeline';
import { resetRateLimits } from '@/lib/security/ratelimit';

import * as policiesRoute from '@/app/api/policies/route';
import * as policyRoute from '@/app/api/policies/[id]/route';
import * as analyzeRoute from '@/app/api/policies/[id]/analyze/route';
import * as versionsRoute from '@/app/api/policies/[id]/versions/route';
import * as runsRoute from '@/app/api/test-runs/route';
import * as runRoute from '@/app/api/test-runs/[id]/route';
import * as twinsRoute from '@/app/api/test-runs/[id]/generate-twins/route';
import * as evalRoute from '@/app/api/test-runs/[id]/evaluate/route';
import * as execRoute from '@/app/api/test-runs/[id]/execute/route';
import * as reportRoute from '@/app/api/test-runs/[id]/report/route';
import * as repairRoute from '@/app/api/test-runs/[id]/approve-repair/route';
import * as decisionRoute from '@/app/api/test-runs/[id]/decision/route';
import * as webhookRoute from '@/app/api/webhooks/paypal/route';
import * as healthRoute from '@/app/api/health/route';

let ctx: Ctx;
beforeEach(async () => {
  resetRateLimits();
  ctx = await offlineCtx();
  (globalThis as any).__policytwin_ctx = Promise.resolve(ctx); // the routes' process-wide singleton
});

const json = (body: unknown, headers: Record<string, string> = {}) => new Request('http://t/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const read = async (r: Response) => ({ status: r.status, body: await r.json() });

async function newPolicy() {
  const { status, body } = await read(await policiesRoute.POST(json(DEMO_POLICY_INPUT)));
  expect(status).toBe(201);
  return body as { policy: { id: string }; version_a: { id: string }; version_b: { id: string } };
}

describe('REST API — the spec’s endpoint sequence', () => {
  it('POST /api/policies → analyze → test-runs → generate-twins → evaluate → execute → GET → report', async () => {
    const p = await newPolicy();

    const analyzed = await read(await analyzeRoute.POST(json({}), params(p.policy.id)));
    expect(analyzed.status).toBe(200);

    const created = await read(await runsRoute.POST(json({ policy_id: p.policy.id, version_a_id: p.version_a.id, version_b_id: p.version_b.id })));
    expect(created.status).toBe(201);
    const runId = created.body.id as string;
    expect(created.body.status).toBe('created');

    const twins = await read(await twinsRoute.POST(json({}), params(runId)));
    expect(twins.status).toBe(200);
    expect(twins.body.pairs).toHaveLength(10);

    const evaluated = await read(await evalRoute.POST(json({}), params(runId)));
    expect(evaluated.status).toBe(200);

    const executed = await read(await execRoute.POST(json({}), params(runId)));
    expect(executed.status).toBe(200);
    expect(executed.body.report.release.decision).toBe('BLOCK');

    const got = await read(await runRoute.GET(new Request('http://t/x'), params(runId)));
    expect(got.status).toBe(200);
    expect(got.body.run.release_decision).toBe('BLOCK');
    expect(got.body.pairs).toHaveLength(10);

    const html = await reportRoute.GET(new Request(`http://t/x`), params(runId));
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toMatch(/text\/html/);
    const text = await html.text();
    expect(text).toMatch(/BLOCK/);
  });

  it('report: download header and JSON format', async () => {
    const p = await newPolicy();
    const run = await read(await runsRoute.POST(json({ policy_id: p.policy.id, version_a_id: p.version_a.id, version_b_id: p.version_b.id, run_all: true })));
    const dl = await reportRoute.GET(new Request('http://t/x?download=1'), params(run.body.id));
    expect(dl.headers.get('content-disposition')).toMatch(/attachment; filename="policytwin-report-.*BLOCK\.html"/);
    const js = await read(await reportRoute.GET(new Request('http://t/x?format=json'), params(run.body.id)));
    expect(js.body.report.release.decision).toBe('BLOCK');
  });

  it('GET /api/policies/:id and the list endpoint', async () => {
    const p = await newPolicy();
    const one = await read(await policyRoute.GET(new Request('http://t/x'), params(p.policy.id)));
    expect(one.status).toBe(200);
    const list = await read(await policiesRoute.GET(new Request('http://t/x')));
    expect(list.body.policies).toHaveLength(1);
    expect((await read(await runsRoute.GET(new Request('http://t/x')))).body.runs).toEqual([]);
  });

  it('POST /api/policies/:id/versions adds a version', async () => {
    const p = await newPolicy();
    const v = await read(await versionsRoute.POST(json({ source_text: 'Automatically refund missing-delivery claims of $25 or less when tracking is unavailable.', label: 'C' }), params(p.policy.id)));
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ label: 'C', version: 3 });
  });

  it('approve-repair re-runs and returns PASS; decision endpoint records the human choice', async () => {
    const p = await newPolicy();
    const run = await read(await runsRoute.POST(json({ policy_id: p.policy.id, version_a_id: p.version_a.id, version_b_id: p.version_b.id, run_all: true })));
    const blocked = await read(await decisionRoute.POST(json({ decision: 'approve', note: 'please ship this release' }), params(run.body.id)));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/BLOCK/);

    const fixed = await read(await repairRoute.POST(json({ actor: 'sam', note: 'ok' }), params(run.body.id)));
    expect(fixed.status).toBe(200);
    expect(fixed.body.release_decision).toBe('PASS');

    const approved = await read(await decisionRoute.POST(json({ decision: 'approve', actor: 'sam' }), params(fixed.body.run_id)));
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ decision: 'approve', release_at_decision: 'PASS' });
  });
});

describe('REST API — error handling', () => {
  it('answers 422 for validation failures (with field paths, never echoing input) and 404 for unknown ids', async () => {
    const bad = await read(await policiesRoute.POST(json({ name: 'x' })));
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect(bad.body.issues.map((i: any) => i.path)).toEqual(expect.arrayContaining(['current_policy', 'proposed_policy']));
    expect((await read(await runsRoute.POST(json({ policy_id: 'p' })))).status).toBe(422);
    expect((await read(await runRoute.GET(new Request('http://t/x'), params('run_nope')))).status).toBe(404);
    expect((await read(await twinsRoute.POST(json({}), params('run_nope')))).status).toBe(404);
    expect((await read(await decisionRoute.POST(json({ decision: 'approve' }), params('run_nope')))).status).toBe(404);
  });

  it('rejects an invalid decision value with 422 before touching the run', async () => {
    const p = await newPolicy();
    const run = await read(await runsRoute.POST(json({ policy_id: p.policy.id, version_a_id: p.version_a.id, version_b_id: p.version_b.id, run_all: true })));
    const r = await read(await decisionRoute.POST(json({ decision: 'maybe' }), params(run.body.id)));
    expect(r.status).toBe(422);
  });

  it('rejects malformed JSON bodies with 400', async () => {
    const bad = new Request('http://t/x', { method: 'POST', body: '{nope' });
    const r = await read(await policiesRoute.POST(bad));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid JSON/);
  });

  it('never leaks internal error text: an unexpected failure becomes a generic 500 with a reference id', async () => {
    const p = await newPolicy();
    const orig = ctx.store.list.bind(ctx.store);
    (ctx.store as any).list = async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2');
    };
    const r = await read(await policyRoute.GET(new Request('http://t/x'), params(p.policy.id)));
    (ctx.store as any).list = orig;
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3/);
    expect(r.body.reference).toMatch(/^err_/);
  });
});

describe('GET /api/health', () => {
  it('reports the runtime mode and the safety disclosures', async () => {
    const { body } = await read(await healthRoute.GET());
    expect(body.runtime).toMatchObject({ paypal_mode: 'simulated', ai_mode: 'deterministic', db_mode: 'memory' });
    const text = JSON.stringify(body.disclosures).toLowerCase();
    for (const must of ['fictional', 'synthetic', 'test money', 'not legal or compliance advice', 'human makes the final']) expect(text).toContain(must);
  });
});

describe('POST /api/webhooks/paypal — verify → dedupe → store once → canonical fetch → update → 200', () => {
  async function capturedId(): Promise<string> {
    const pp = ctx.adapter as SimulatedPayPal;
    const o = await pp.createOrder({ requestId: 'wo', intent: 'CAPTURE', amount: { currency_code: 'USD', value: '40.00' }, referenceId: 'r' });
    if (!o.ok) throw new Error();
    await pp.confirmPaymentSource(o.data.id, 'wc');
    const c = await pp.captureOrder(o.data.id, 'wcap');
    if (!c.ok) throw new Error();
    return c.data.id;
  }
  const event = (id: string, capId: string) => ({ id, event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-01-01T00:00:00Z', resource: { id: capId } });
  const signed = { 'x-policytwin-simulated': 'true' };

  it('rejects an unsigned/unverifiable request with 401 and stores nothing', async () => {
    const cap = await capturedId();
    const r = await read(await webhookRoute.POST(json(event('WH-1', cap))));
    expect(r.status).toBe(401);
    expect(await ctx.store.list('webhook_events')).toHaveLength(0);
  });

  it('verifies, stores once, applies the canonical state, and returns 200 for the duplicate too', async () => {
    const cap = await capturedId();
    const first = await read(await webhookRoute.POST(json(event('WH-1', cap), signed)));
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ ignored_duplicate: false, applied: true, canonical_fetched: true, state_after: 'COMPLETED' });
    const dup = await read(await webhookRoute.POST(json(event('WH-1', cap), signed)));
    expect(dup.status).toBe(200); // still 200 so PayPal stops retrying
    expect(dup.body.result.ignored_duplicate).toBe(true);
    expect(await ctx.store.list('webhook_events')).toHaveLength(1);
    expect((await ctx.store.get('resource_states', cap))?.status).toBe('COMPLETED');
  });

  it('does not let a late older event regress state', async () => {
    const cap = await capturedId();
    const pp = ctx.adapter as SimulatedPayPal;
    await pp.refundCapture(cap, { requestId: 'rf', amount: { currency_code: 'USD', value: '40.00' }, noteToPayer: 'n' });
    await webhookRoute.POST(json({ ...event('WH-2', cap), event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF', links: [{ rel: 'up', href: `https://x/v2/payments/captures/${cap}` }] } }, signed));
    expect((await ctx.store.get('resource_states', cap))?.status).toBe('REFUNDED');
    await webhookRoute.POST(json(event('WH-1-old', cap), signed));
    expect((await ctx.store.get('resource_states', cap))?.status).toBe('REFUNDED');
  });

  it('400 for non-JSON and for payloads that are not PayPal events', async () => {
    expect((await read(await webhookRoute.POST(new Request('http://t/x', { method: 'POST', body: 'nope' })))).status).toBe(400);
    expect((await read(await webhookRoute.POST(json({ hello: 'world' })))).status).toBe(400);
  });
});
