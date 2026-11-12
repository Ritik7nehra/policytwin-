import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { MemoryStore } from '@/lib/store/memory';
import { SimulatedPayPal } from '@/lib/paypal/simulated';
import { OfflineLlm } from '@/lib/agents/llm';
import { runDemoFlow, type Ctx } from '@/lib/pipeline';
import { ensurePublicExamples, PUBLIC_EXAMPLE_POLICY_ID } from '@/lib/examples';
import { resetRateLimits } from '@/lib/security/ratelimit';
import * as overviewRoute from '@/app/api/overview/route';
import * as sessionRoute from '@/app/api/session/route';
import { COOKIE_NAME } from '@/lib/security/session';

let ctx: Ctx;
const H = 'http://app.test';
const req = (headers: Record<string, string> = {}) => new Request(`${H}/api/overview`, { headers: { host: 'app.test', 'x-forwarded-for': '203.0.113.9', ...headers } });
async function login(ip = '203.0.113.9') {
  const res = await sessionRoute.POST(new Request(`${H}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'app.test', 'x-forwarded-for': ip }, body: JSON.stringify({ passcode: 'pw-for-overview' }) }));
  return `${COOKIE_NAME}=${/pt_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`;
}

beforeEach(async () => {
  vi.stubEnv('DEMO_PASSCODE', 'pw-for-overview');
  vi.stubEnv('SESSION_SECRET', 'overview-test-secret-0123456789');
  resetRateLimits();
  ctx = { store: new MemoryStore(), adapter: new SimulatedPayPal(), llm: new OfflineLlm() };
  (globalThis as any).__policytwin_ctx = Promise.resolve(ctx);
  await ensurePublicExamples(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/overview', () => {
  it('anonymous callers see only the public example and its real counts', async () => {
    const res = await overviewRoute.GET(req());
    expect(res.status).toBe(200);
    const o = await res.json();
    expect(o.recent_policies.map((p: any) => p.id)).toEqual([PUBLIC_EXAMPLE_POLICY_ID]);
    expect(o.recent_policies[0].read_only).toBe(true);
    expect(o.totals.policies).toBe(1);
    expect(o.totals.runs).toBe(2); // the BLOCK run and its approved-repair re-run
    expect(o.totals.verdicts).toEqual({ PASS: 1, REVIEW: 0, BLOCK: 1 });
    expect(o.public_example.run_ids).toHaveLength(2);
  });

  it('every number equals what the stored reports say (nothing invented)', async () => {
    const o = await (await overviewRoute.GET(req())).json();
    const runs = await ctx.store.list('test_runs');
    const reps = runs.map((r) => r.report_json as any);
    expect(o.totals.pairs).toBe(reps.reduce((n, r) => n + r.release.counts.pairs, 0));
    expect(o.totals.passed_pairs).toBe(reps.reduce((n, r) => n + r.release.counts.passed, 0));
    expect(o.totals.invariant_failures).toBe(reps.reduce((n, r) => n + r.release.counts.invariant_failures, 0));
    expect(o.totals.scenarios).toBe(o.totals.pairs * 2);
  });

  it('a signed-in user sees their own work plus the example, never another session’s', async () => {
    const mine = await login('203.0.113.10');
    const other = await login('203.0.113.11');
    await runDemoFlow(ctx, DEMO_POLICY_INPUT, { ownerSession: 'someone-else', actor: 'x' });
    const before = await (await overviewRoute.GET(req({ cookie: mine }))).json();
    expect(before.totals.policies).toBe(1); // example only; the other session's policy is invisible
    const cookieSid = mine.split('=')[1].split('.')[0];
    await runDemoFlow(ctx, DEMO_POLICY_INPUT, { ownerSession: cookieSid, actor: 'me' });
    const after = await (await overviewRoute.GET(req({ cookie: mine }))).json();
    expect(after.totals.policies).toBe(2);
    expect(after.totals.runs).toBe(3);
    expect(after.recent_runs.some((r: any) => r.read_only)).toBe(true);
    const theirs = await (await overviewRoute.GET(req({ cookie: other }))).json();
    expect(theirs.totals.policies).toBe(1);
  });

  it('never leaks owner sessions, secrets or raw report bodies', async () => {
    const text = JSON.stringify(await (await overviewRoute.GET(req())).json());
    expect(text).not.toMatch(/owner_session|report_json|passcode|secret|client_secret|access_token/i);
  });
});
