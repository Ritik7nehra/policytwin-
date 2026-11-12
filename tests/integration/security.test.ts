import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { MemoryStore } from '@/lib/store/memory';
import { SimulatedPayPal } from '@/lib/paypal/simulated';
import { OfflineLlm, type LlmClient } from '@/lib/agents/llm';
import { createPolicy, createTestRun, runAllStages, runDemoFlow, type Ctx } from '@/lib/pipeline';
import { ensurePublicExamples, publicExampleRunIds, PUBLIC_EXAMPLE_POLICY_ID } from '@/lib/examples';
import { resetRateLimits } from '@/lib/security/ratelimit';
import { COOKIE_NAME, PUBLIC_OWNER, createSessionToken, verifySessionToken, passcodeMatches, clientIp, actorFor } from '@/lib/security/session';
import { resetSessionData } from '@/lib/security/guard';
import { setLogSink } from '@/lib/security/log';

import * as sessionRoute from '@/app/api/session/route';
import * as resetRoute from '@/app/api/session/reset/route';
import * as policiesRoute from '@/app/api/policies/route';
import * as policyRoute from '@/app/api/policies/[id]/route';
import * as runsRoute from '@/app/api/test-runs/route';
import * as runRoute from '@/app/api/test-runs/[id]/route';
import * as twinsRoute from '@/app/api/test-runs/[id]/generate-twins/route';
import * as evalRoute from '@/app/api/test-runs/[id]/evaluate/route';
import * as execRoute from '@/app/api/test-runs/[id]/execute/route';
import * as reportRoute from '@/app/api/test-runs/[id]/report/route';
import * as decisionRoute from '@/app/api/test-runs/[id]/decision/route';
import * as repairRoute from '@/app/api/test-runs/[id]/approve-repair/route';
import * as proofRoute from '@/app/api/test-runs/[id]/sandbox-proof/route';
import * as resumeRoute from '@/app/api/test-runs/[id]/resume/route';
import * as healthRoute from '@/app/api/health/route';

const PASS = 'correct horse battery';
const SECRET = 'unit-test-session-secret-0123456789';
let ctx: Ctx;

beforeEach(async () => {
  vi.stubEnv('DEMO_PASSCODE', PASS);
  vi.stubEnv('SESSION_SECRET', SECRET);
  resetRateLimits();
  const store = new MemoryStore();
  ctx = { store, adapter: new SimulatedPayPal(), llm: new OfflineLlm() };
  (globalThis as any).__policytwin_ctx = Promise.resolve(ctx);
});
afterEach(() => vi.unstubAllEnvs());

// ── helpers ─────────────────────────────────────────────────────────────
const H = 'http://app.test';
const post = (body: unknown, headers: Record<string, string> = {}, ip = '203.0.113.5') =>
  new Request(`${H}/api/x`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'app.test', 'x-forwarded-for': ip, ...headers }, body: JSON.stringify(body) });
const get = (headers: Record<string, string> = {}, url = `${H}/api/x`) => new Request(url, { headers: { host: 'app.test', 'x-forwarded-for': '203.0.113.5', ...headers } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const body = async (r: Response) => ({ status: r.status, headers: r.headers, json: await r.json().catch(() => null) });
const cookieOf = (r: Response) => /pt_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];

async function login(ip = '203.0.113.5') {
  const res = await sessionRoute.POST(post({ passcode: PASS }, {}, ip));
  expect(res.status).toBe(200);
  const raw = cookieOf(res)!;
  expect(raw).toBeTruthy();
  return { cookie: `${COOKIE_NAME}=${raw}`, setCookie: res.headers.get('set-cookie')!, json: await res.json() };
}
const authed = (cookie: string, b: unknown, extra: Record<string, string> = {}) => post(b, { cookie, ...extra });

async function makePolicyViaApi(cookie: string) {
  const r = await body(await policiesRoute.POST(authed(cookie, DEMO_POLICY_INPUT)));
  expect(r.status).toBe(201);
  return r.json as { policy: { id: string }; version_a: { id: string }; version_b: { id: string } };
}
async function makeRunViaApi(cookie: string, runAll = true) {
  const p = await makePolicyViaApi(cookie);
  const r = await body(await runsRoute.POST(authed(cookie, { policy_id: p.policy.id, version_a_id: p.version_a.id, version_b_id: p.version_b.id, run_all: runAll })));
  expect(r.status).toBe(201);
  return { policy: p, runId: r.json.id as string };
}

// ── authentication ──────────────────────────────────────────────────────
describe('passcode login and the signed session cookie', () => {
  it('unauthenticated callers get 401 on every protected endpoint', async () => {
    const calls: [string, Promise<Response>][] = [
      ['POST /policies', policiesRoute.POST(post(DEMO_POLICY_INPUT))],
      ['POST /test-runs', runsRoute.POST(post({ policy_id: 'p', version_a_id: 'a', version_b_id: 'b' }))],
      ['GET /policies/:id', policyRoute.GET(get(), params('pol_x'))],
      ['GET /test-runs/:id', runRoute.GET(get(), params('run_x'))],
      ['POST generate-twins', twinsRoute.POST(post({}), params('run_x'))],
      ['POST evaluate', evalRoute.POST(post({}), params('run_x'))],
      ['POST execute', execRoute.POST(post({}), params('run_x'))],
      ['POST decision', decisionRoute.POST(post({ decision: 'reject' }), params('run_x'))],
      ['POST approve-repair', repairRoute.POST(post({}), params('run_x'))],
      ['POST sandbox-proof', proofRoute.POST(post({ pair_id: 'pair_01' }), params('run_x'))],
      ['POST resume', resumeRoute.POST(post({}), params('run_x'))],
      ['POST session/reset', resetRoute.POST(post({}))],
    ];
    for (const [name, p] of calls) expect({ name, status: (await p).status }).toEqual({ name, status: 401 });
  });

  it('wrong passcode → 401, no cookie; right passcode → HttpOnly + SameSite=Lax cookie and a SERVER-derived actor', async () => {
    const bad = await sessionRoute.POST(post({ passcode: 'nope' }));
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const ok = await login();
    expect(ok.setCookie).toMatch(/HttpOnly/i);
    expect(ok.setCookie).toMatch(/SameSite=Lax/i);
    expect(ok.setCookie).toMatch(/Path=\//);
    expect(ok.setCookie).not.toMatch(/Secure/i); // plain http in this test
    expect(ok.json.actor).toMatch(/^demo\.judge#[a-z0-9]{1,6}$/);
    expect(JSON.stringify(ok.json)).not.toContain(PASS);
    const https = await sessionRoute.POST(post({ passcode: PASS }, { 'x-forwarded-proto': 'https' }));
    expect(https.headers.get('set-cookie')).toMatch(/Secure/i);
  });

  it('GET /api/session shows the login gate state, then the session, usage and limits — never the secret', async () => {
    const anon = await body(await sessionRoute.GET(get()));
    expect(anon.json).toMatchObject({ authenticated: false, required: true });
    expect(anon.json.public_example.policy_id).toBe(PUBLIC_EXAMPLE_POLICY_ID);
    const { cookie } = await login();
    const me = await body(await sessionRoute.GET(get({ cookie })));
    expect(me.json).toMatchObject({ authenticated: true, mode: 'passcode', usage: { runs: 0, policies: 0 } });
    expect(me.json.limits).toMatchObject({ maxRunsPerSession: expect.any(Number), aiCallsPerDay: expect.any(Number) });
    expect(JSON.stringify(me.json)).not.toMatch(new RegExp(`${SECRET}|${PASS}`));
  });

  it('rejects tampered, foreign-signed and expired cookies', async () => {
    const { cookie } = await login();
    const [sid, exp, sig] = cookie.split('=')[1].split('.');
    const forged = [`${sid}x.${exp}.${sig}`, `${sid}.${Number(exp) + 1}.${sig}`, `${sid}.${exp}.${sig.slice(0, -2)}AA`, createSessionToken(sid, 'another-secret-another-secret', 3600).token, createSessionToken(sid, SECRET, 3600, Date.now() - 4 * 3600_000).token, 'garbage', ''];
    for (const f of forged) expect((await policiesRoute.POST(post(DEMO_POLICY_INPUT, { cookie: `${COOKIE_NAME}=${f}` }))).status).toBe(401);
    expect(verifySessionToken(cookie.split('=')[1], SECRET)).toMatchObject({ sid });
    expect(verifySessionToken(cookie.split('=')[1], 'wrong-secret-wrong-secret')).toBeNull();
  });

  it('compares passcodes in constant time and handles odd inputs', () => {
    expect(passcodeMatches(PASS, PASS)).toBe(true);
    expect(passcodeMatches(PASS + ' ', PASS)).toBe(false);
    expect(passcodeMatches('', PASS)).toBe(false);
    expect(passcodeMatches('x'.repeat(10_000), PASS)).toBe(false);
  });

  it('rate-limits login attempts per IP (429 + Retry-After) without locking out other IPs', async () => {
    const attempt = (ip: string) => sessionRoute.POST(post({ passcode: 'wrong' }, {}, ip));
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await attempt('198.51.100.9')).status);
    expect(codes.slice(0, 8).every((c) => c === 401)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
    const limited = await attempt('198.51.100.9');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await attempt('198.51.100.77')).status).toBe(401); // a different client is unaffected
  });

  it('logout clears the cookie', async () => {
    const r = await sessionRoute.DELETE(post({}));
    expect(r.headers.get('set-cookie')).toMatch(/pt_session=;|Max-Age=0/);
  });
});

describe('fail closed when access control is missing or weak', () => {
  it('production without DEMO_PASSCODE → 503 AUTH_NOT_CONFIGURED on protected AND session endpoints; health reports it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEMO_PASSCODE', '');
    vi.stubEnv('SESSION_SECRET', '');
    const r = await body(await policiesRoute.POST(post(DEMO_POLICY_INPUT)));
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('AUTH_NOT_CONFIGURED');
    expect((await sessionRoute.POST(post({ passcode: 'x' }))).status).toBe(503);
    const h = await body(await healthRoute.GET());
    expect(h.status).toBe(503);
    expect(h.json.checks.access_control).toBe('misconfigured');
  });

  it('production with a passcode but no/short SESSION_SECRET is also refused', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', '');
    expect((await policiesRoute.POST(post(DEMO_POLICY_INPUT))).status).toBe(503);
    vi.stubEnv('SESSION_SECRET', 'short');
    expect((await policiesRoute.POST(post(DEMO_POLICY_INPUT))).status).toBe(503);
  });

  it('local development without a passcode runs in explicit open mode (shared "local" workspace)', async () => {
    vi.stubEnv('DEMO_PASSCODE', '');
    vi.stubEnv('SESSION_SECRET', '');
    const r = await body(await policiesRoute.POST(post(DEMO_POLICY_INPUT)));
    expect(r.status).toBe(201);
    const h = await body(await healthRoute.GET());
    expect(h.json.checks.access_control).toMatch(/open/);
  });
});

// ── authorization ───────────────────────────────────────────────────────
describe('workspace isolation (cross-session access)', () => {
  it('session B cannot read, run, decide on or fetch the report of session A’s data (403), but unknown ids are 404', async () => {
    const a = await login('10.0.0.1');
    const b = await login('10.0.0.2');
    expect(a.cookie).not.toBe(b.cookie);
    const { runId, policy } = await makeRunViaApi(a.cookie);

    expect((await runRoute.GET(get({ cookie: a.cookie }), params(runId))).status).toBe(200);
    const attempts: [string, Response][] = [
      ['read run', await runRoute.GET(get({ cookie: b.cookie }), params(runId))],
      ['read policy', await policyRoute.GET(get({ cookie: b.cookie }), params(policy.policy.id))],
      ['report', await reportRoute.GET(get({ cookie: b.cookie }), params(runId))],
      ['execute', await execRoute.POST(post({}, { cookie: b.cookie }), params(runId))],
      ['decision', await decisionRoute.POST(post({ decision: 'reject', note: 'mine now' }, { cookie: b.cookie }), params(runId))],
      ['approve repair', await repairRoute.POST(post({}, { cookie: b.cookie }), params(runId))],
      ['sandbox proof', await proofRoute.POST(post({ pair_id: 'pair_01' }, { cookie: b.cookie }), params(runId))],
      ['new run on A’s policy', await runsRoute.POST(post({ policy_id: policy.policy.id, version_a_id: policy.version_a.id, version_b_id: policy.version_b.id }, { cookie: b.cookie }))],
    ];
    for (const [name, res] of attempts) expect({ name, status: res.status }).toEqual({ name, status: 403 });
    expect((await runRoute.GET(get({ cookie: b.cookie }), params('run_doesnotexist'))).status).toBe(404);
    expect(((await ctx.store.get('test_runs', runId))!.report_json as any).human_decision).toBeNull(); // nothing changed

    const list = await body(await runsRoute.GET(get({ cookie: b.cookie })));
    expect(list.json.runs.map((r: any) => r.id)).not.toContain(runId);
    const pols = await body(await policiesRoute.GET(get({ cookie: b.cookie })));
    expect(JSON.stringify(pols.json)).not.toContain(policy.policy.id);
  });

  it('the actor is derived on the server: a client-supplied actor/created_by is ignored', async () => {
    const { cookie, json } = await login();
    const p = await body(await policiesRoute.POST(authed(cookie, { ...DEMO_POLICY_INPUT, created_by: 'the.cfo', actor: 'the.cfo' })));
    expect(p.status).toBe(201);
    expect((await ctx.store.get('policies', p.json.policy.id))!.created_by).toBe(json.actor);
    const { runId } = await makeRunViaApi(cookie);
    const d = await body(await decisionRoute.POST(authed(cookie, { decision: 'reject', note: 'blocked', actor: 'the.cfo' }), params(runId)));
    expect(d.status).toBe(200);
    expect(d.json.actor).toBe(json.actor);
    expect(JSON.stringify((await ctx.store.list('audit_events', { test_run_id: runId })).map((e) => e.actor))).not.toContain('the.cfo');
  });

  it('public example reports are readable without a session and strictly read-only', async () => {
    await ensurePublicExamples(ctx);
    const ids = await publicExampleRunIds(ctx);
    expect(ids.length).toBeGreaterThan(0);
    const [id] = ids;
    expect((await ctx.store.get('test_runs', id))!.owner_session).toBe(PUBLIC_OWNER);
    const anon = await body(await runRoute.GET(get(), params(id)));
    expect(anon.status).toBe(200);
    expect(anon.json.read_only).toBe(true);
    expect((await reportRoute.GET(get(), params(id))).status).toBe(200);

    const { cookie } = await login();
    const writes: [string, Response][] = [
      ['decision', await decisionRoute.POST(authed(cookie, { decision: 'reject', note: 'x' }), params(id))],
      ['execute', await execRoute.POST(authed(cookie, {}), params(id))],
      ['approve repair', await repairRoute.POST(authed(cookie, {}), params(id))],
      ['sandbox proof', await proofRoute.POST(authed(cookie, { pair_id: 'pair_01' }), params(id))],
      ['resume', await resumeRoute.POST(authed(cookie, {}), params(id))],
    ];
    for (const [name, res] of writes) expect({ name, status: res.status }).toEqual({ name, status: 403 });
    expect(((await ctx.store.get('test_runs', id))!.report_json as any).human_decision).toBeNull();
    // anonymous writes are 401, not 403
    expect((await decisionRoute.POST(post({ decision: 'reject' }), params(id))).status).toBe(401);
  });

  it('CSRF: a state-changing request from another origin is refused even with a valid cookie', async () => {
    const { cookie } = await login();
    expect((await policiesRoute.POST(authed(cookie, DEMO_POLICY_INPUT, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await policiesRoute.POST(authed(cookie, DEMO_POLICY_INPUT, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await policiesRoute.POST(authed(cookie, DEMO_POLICY_INPUT, { origin: 'http://app.test' }))).status).toBe(201);
    expect((await sessionRoute.POST(post({ passcode: PASS }, { origin: 'https://evil.example' }))).status).toBe(403);
  });
});

// ── abuse protection ────────────────────────────────────────────────────
describe('rate limits, quotas and input limits', () => {
  it('heavy endpoints are limited per session (429 + Retry-After + machine-readable code)', async () => {
    const { cookie } = await login();
    const { runId } = await makeRunViaApi(cookie, false); // costs 1 heavy hit
    const statuses: number[] = [];
    let last!: Response;
    for (let i = 0; i < 10; i++) {
      last = await evalRoute.POST(authed(cookie, {}), params(runId));
      statuses.push(last.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(8);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await last.json()).code).toBe('RATE_LIMITED');
  });

  it('is also limited per IP, so cycling sessions from one address does not bypass it', async () => {
    const sessions = [];
    for (let i = 0; i < 3; i++) sessions.push((await login('192.0.2.50')).cookie);
    let blocked = 0;
    for (let i = 0; i < 24; i++) {
      const r = await evalRoute.POST(post({}, { cookie: sessions[i % 3] }, '192.0.2.50'), params('run_x'));
      if (r.status === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it('caps runs per session (429 QUOTA_EXCEEDED) and policies per session; reset gives the allowance back', async () => {
    ctx.limits = { maxRunsPerSession: 2, maxPoliciesPerSession: 3, aiCallsPerDay: 150 };
    const { cookie } = await login();
    const p = await makePolicyViaApi(cookie);
    const mk = () => runsRoute.POST(authed(cookie, { policy_id: p.policy.id, version_a_id: p.version_a.id, version_b_id: p.version_b.id }));
    expect((await mk()).status).toBe(201);
    expect((await mk()).status).toBe(201);
    const third = await body(await mk());
    expect(third.status).toBe(429);
    expect(third.json.code).toBe('QUOTA_EXCEEDED');
    expect(third.json.error).toMatch(/limit of 2 test runs/);
    await makePolicyViaApi(cookie);
    await makePolicyViaApi(cookie);
    expect((await policiesRoute.POST(authed(cookie, DEMO_POLICY_INPUT))).status).toBe(429);

    expect((await resetRoute.POST(authed(cookie, {}))).status).toBe(200);
    const again = await makePolicyViaApi(cookie);
    expect(again.policy.id).toBeTruthy();
  });

  it('daily AI budget: once exhausted, agents use the deterministic fallback and make NO further LLM calls', async () => {
    let calls = 0;
    const llm: LlmClient = {
      mode: 'openai',
      model: 'stub',
      async structured() {
        calls++;
        throw new Error('model unavailable');
      },
    };
    const c: Ctx = { ...ctx, llm, limits: { maxRunsPerSession: 12, maxPoliciesPerSession: 20, aiCallsPerDay: 2 } };
    const { report } = await runDemoFlow(c, DEMO_POLICY_INPUT);
    expect(report.release.decision).toBe('BLOCK'); // the verdict is deterministic regardless of AI availability
    expect(calls).toBe(2);
    const agentRuns = await ctx.store.list('agent_runs');
    expect(agentRuns.filter((a) => a.status === 'fallback_quota').length).toBeGreaterThan(0);
    expect(agentRuns.filter((a) => a.status === 'fallback_error')).toHaveLength(2);
  });

  it('request bodies are bounded and validated: 413 oversized, 400 malformed JSON, 422 schema violations, 400 malformed ids', async () => {
    const { cookie } = await login();
    const huge = await body(await policiesRoute.POST(authed(cookie, { ...DEMO_POLICY_INPUT, business_reason: 'x'.repeat(200_000) })));
    expect(huge.status).toBe(413);
    const broken = await policiesRoute.POST(new Request(`${H}/api/x`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', host: 'app.test' }, body: '{not json' }));
    expect(broken.status).toBe(400);
    const tooLong = await body(await policiesRoute.POST(authed(cookie, { ...DEMO_POLICY_INPUT, name: 'n'.repeat(500) })));
    expect(tooLong.status).toBe(422);
    expect(tooLong.json.issues?.[0]?.path ?? JSON.stringify(tooLong.json)).toMatch(/name/);
    const missing = await body(await policiesRoute.POST(authed(cookie, { name: 'only a name' })));
    expect(missing.status).toBe(422);
    const wrongType = await body(await policiesRoute.POST(authed(cookie, { ...DEMO_POLICY_INPUT, name: 42 })));
    expect(wrongType.status).toBe(422);
    const badId = await runRoute.GET(get({ cookie }), params('../../etc/passwd'));
    expect(badId.status).toBe(400);
    const { runId } = await makeRunViaApi(cookie);
    expect((await decisionRoute.POST(authed(cookie, { decision: 'maybe' }), params(runId))).status).toBe(422);
    expect((await proofRoute.POST(authed(cookie, { pair_id: 'pair_01; DROP TABLE' }), params(runId))).status).toBe(422);
  });

  it('errors never leak internals: no stack traces, SQL, file paths or secrets in any error body', async () => {
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    const { cookie } = await login();
    vi.spyOn(ctx.store, 'transaction').mockRejectedValueOnce(new Error(`connect ECONNREFUSED 10.1.2.3:5432 password=${SECRET} at /srv/app/node_modules/pg/lib/client.js:12`));
    const r = await body(await policiesRoute.POST(authed(cookie, DEMO_POLICY_INPUT)));
    restore();
    expect(r.status).toBe(500);
    const text = JSON.stringify(r.json);
    expect(text).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|node_modules|password|client\.js/);
    expect(text).not.toContain(SECRET);
    expect(r.json.reference).toBeTruthy(); // support can correlate it with the (sanitized) server log
    expect(lines.join('\n')).toContain(r.json.reference);
  });
});

// ── demo reset ──────────────────────────────────────────────────────────
describe('demo reset', () => {
  it('deletes only the caller’s data; other sessions and the public example survive', async () => {
    await ensurePublicExamples(ctx);
    const a = await login('10.1.0.1');
    const b = await login('10.1.0.2');
    const ra = await makeRunViaApi(a.cookie);
    const rb = await makeRunViaApi(b.cookie);
    await decisionRoute.POST(authed(a.cookie, { decision: 'reject', note: 'blocked' }), params(ra.runId));
    await repairRoute.POST(authed(a.cookie, { note: 'ok' }), params(ra.runId)); // creates a child run (parent_run_id FK)

    const res = await body(await resetRoute.POST(authed(a.cookie, {})));
    expect(res.status).toBe(200);
    expect(res.json.deleted.test_runs).toBeGreaterThanOrEqual(2);
    expect(await ctx.store.count('test_runs', { owner_session: verifySessionToken(a.cookie.split('=')[1], SECRET)!.sid })).toBe(0);
    expect(await ctx.store.get('test_runs', ra.runId)).toBeNull();
    expect(await ctx.store.get('test_runs', rb.runId)).not.toBeNull();
    expect(await ctx.store.get('policies', PUBLIC_EXAMPLE_POLICY_ID)).not.toBeNull();
    expect((await publicExampleRunIds(ctx)).length).toBeGreaterThan(0);
    expect((await sessionRoute.GET(get({ cookie: a.cookie }))).status).toBe(200); // still signed in
  });

  it('refuses to reset the public workspace', async () => {
    await expect(resetSessionData(ctx.store, PUBLIC_OWNER)).rejects.toThrow(/cannot be reset/);
  });
});

describe('helpers', () => {
  it('uses the right-most X-Forwarded-For hop (the one added by our own proxy), not a client-controlled one', () => {
    const r = new Request(H, { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } });
    expect(clientIp(r)).toBe('203.0.113.9');
    expect(actorFor('Ab-_Cd1234')).toBe('demo.judge#abcd12');
  });
  it('zod is wired (smoke)', () => expect(z.string().safeParse('a').success).toBe(true));
});
