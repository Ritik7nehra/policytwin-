import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { PayPalSandboxAdapter } from '@/lib/paypal/live';
import { OpenAiLlm } from '@/lib/agents/llm';
import { DependencyError } from '@/lib/errors';
import { breakerStatus, getBreaker, resetBreakers } from '@/lib/resilience';
import { MemoryStore } from '@/lib/store/memory';
import { SimulatedPayPal } from '@/lib/paypal/simulated';
import { OfflineLlm } from '@/lib/agents/llm';
import * as healthRoute from '@/app/api/health/route';

// ───────────────────────── PayPal adapter over a faulty transport ─────────────────────────
interface Seen { url: string; method: string; headers: Record<string, string> }
type Step = { status: number; json?: unknown; text?: string; headers?: Record<string, string> } | 'hang' | 'network_error';

function transport(script: (s: Seen, n: number) => Step) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const s: Seen = { url, method: String(init.method ?? 'GET'), headers: { ...(init.headers as Record<string, string>) } };
    if (!url.endsWith('/v1/oauth2/token')) seen.push(s);
    const step: Step = url.endsWith('/v1/oauth2/token') ? { status: 200, json: { access_token: 'tok', expires_in: 3600 } } : script(s, seen.length);
    if (step === 'network_error') throw new TypeError('fetch failed');
    if (step === 'hang') return new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)));
    return new Response(step.text ?? (step.json === undefined ? '' : JSON.stringify(step.json)), { status: step.status, headers: step.headers });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}
const adapter = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  new PayPalSandboxAdapter({ clientId: 'c', clientSecret: 's', fetchImpl, merchantId: 'M', timeoutMs: 40, attempts: 3, sleep: async () => undefined, random: () => 0.5, breaker: getBreaker('paypal-test', { failureThreshold: 50 }), ...extra });

const REFUND_OK = { id: 'REF-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '40.00' } };
const refundArgs = { requestId: 'run1-scenario_04-refund', amount: { currency_code: 'USD', value: '40.00' }, noteToPayer: 'n' };

beforeEach(() => resetBreakers());

describe('PayPal adapter: timeouts and retries keep the SAME PayPal-Request-Id', () => {
  it('a timed-out refund is retried and the retry carries the identical PayPal-Request-Id (no double refund)', async () => {
    const { seen, fetchImpl } = transport((_s, n) => (n === 1 ? 'hang' : { status: 201, json: REFUND_OK }));
    const r = await adapter(fetchImpl).refundCapture('CAP-1', refundArgs);
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.headers['PayPal-Request-Id'])).toEqual([refundArgs.requestId, refundArgs.requestId]);
    expect(seen.every((s) => s.url.endsWith('/v2/payments/captures/CAP-1/refund'))).toBe(true);
  });

  it('retries a network error, a 503 and a 429 (honouring the budget of 3 attempts), always with the same id', async () => {
    const steps: Step[] = ['network_error', { status: 503, json: { name: 'SERVICE_UNAVAILABLE' } }, { status: 201, json: REFUND_OK }];
    const { seen, fetchImpl } = transport((_s, n) => steps[n - 1]);
    expect((await adapter(fetchImpl).refundCapture('CAP-1', refundArgs)).ok).toBe(true);
    expect(new Set(seen.map((s) => s.headers['PayPal-Request-Id']))).toEqual(new Set([refundArgs.requestId]));

    const t2 = transport((_s, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '1' }, json: { name: 'RATE_LIMIT_REACHED' } } : { status: 201, json: REFUND_OK }));
    expect((await adapter(t2.fetchImpl).refundCapture('CAP-1', refundArgs)).ok).toBe(true);
    expect(t2.seen).toHaveLength(2);
  });

  it('gives up after the attempt budget and surfaces the real status; other 4xx are NOT retried', async () => {
    const down = transport(() => ({ status: 503, json: { name: 'SERVICE_UNAVAILABLE', message: 'try later' } }));
    const r = await adapter(down.fetchImpl).refundCapture('CAP-1', refundArgs);
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(down.seen).toHaveLength(3);

    const declined = transport(() => ({ status: 422, json: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'CAPTURE_FULLY_REFUNDED' }] } }));
    const r2 = await adapter(declined.fetchImpl).refundCapture('CAP-1', refundArgs);
    expect(r2).toMatchObject({ ok: false, status: 422, error: { issue: 'CAPTURE_FULLY_REFUNDED' } });
    expect(declined.seen).toHaveLength(1);
  });

  it('PayPal unreachable: DependencyError (→ HTTP 503 at the API) instead of a hang or a raw stack trace', async () => {
    const { fetchImpl } = transport(() => 'network_error');
    await expect(adapter(fetchImpl).createOrder({ requestId: 'r', intent: 'CAPTURE', amount: { currency_code: 'USD', value: '1.00' }, referenceId: 'x' })).rejects.toBeInstanceOf(DependencyError);
  });
});

describe('PayPal adapter: a 2xx with an unusable body is never trusted', () => {
  const bad: [string, Step, (a: PayPalSandboxAdapter) => Promise<any>][] = [
    ['capture without an id', { status: 201, json: { status: 'COMPLETED', amount: { currency_code: 'USD', value: '40.00' } } }, (a) => a.captureOrder('O1', 'r')],
    ['capture with a non-money amount', { status: 201, json: { id: 'C1', status: 'COMPLETED', amount: { currency_code: 'USD', value: 'forty' } } }, (a) => a.captureOrder('O1', 'r')],
    ['order without a status', { status: 200, json: { id: 'O1' } }, (a) => a.getOrder('O1')],
    ['refund with an empty status', { status: 201, json: { id: 'R1', status: '' } }, (a) => a.refundCapture('C1', refundArgs)],
    ['HTML instead of JSON', { status: 200, text: '<html>maintenance</html>' }, (a) => a.getOrder('O1')],
    ['an empty body', { status: 200, text: '' }, (a) => a.getCapture('C1')],
    ['a JSON array', { status: 200, json: [1, 2, 3] }, (a) => a.getOrder('O1')],
  ];
  for (const [name, step, call] of bad) {
    it(`${name} → MALFORMED_RESPONSE (ok:false), not a crash and not proof`, async () => {
      const { fetchImpl } = transport(() => step);
      const r = await call(adapter(fetchImpl));
      expect(r.ok).toBe(false);
      expect(r.error).toMatchObject({ name: 'MALFORMED_RESPONSE', issue: 'MALFORMED_RESPONSE' });
      expect(r.status).toBeGreaterThanOrEqual(200);
    });
  }
});

describe('circuit breaker is visible in /api/health', () => {
  it('opens after repeated failures, then fails fast WITHOUT touching the network, and /api/health says so', async () => {
    const t = transport(() => 'network_error');
    const pp = new PayPalSandboxAdapter({ clientId: 'c', clientSecret: 's', fetchImpl: t.fetchImpl, timeoutMs: 40, attempts: 3, sleep: async () => undefined }); // default breaker = the shared 'paypal' one
    const order = { requestId: 'r', intent: 'CAPTURE' as const, amount: { currency_code: 'USD', value: '1.00' }, referenceId: 'x' };
    for (let i = 0; i < 3; i++) await pp.createOrder(order).catch(() => undefined);
    expect(breakerStatus().find((b) => b.name === 'paypal')?.state).toBe('open');
    const before = t.seen.length;
    await expect(pp.createOrder(order)).rejects.toThrow(/circuit open|unavailable/i);
    expect(t.seen.length).toBe(before);

    (globalThis as any).__policytwin_ctx = Promise.resolve({ store: new MemoryStore(), adapter: new SimulatedPayPal(), llm: new OfflineLlm() });
    const res = await healthRoute.GET();
    const json = await res.json();
    expect(res.status).toBe(200); // degraded ≠ down: the app still serves its deterministic features
    expect(json.status).toBe('degraded');
    expect(json.dependencies).toEqual([expect.objectContaining({ name: 'paypal', state: 'open', last_error: expect.any(String) })]);
    expect(JSON.stringify(json)).not.toMatch(/secret|tok/i);
  });
});

// ───────────────────────── OpenAI structured outputs against a local stub server ─────────────────────────
const Out = z.object({ verdict: z.enum(['ok', 'bad']), reasons: z.array(z.string()) });
let server: http.Server;
let baseURL: string;
let requests: { auth: string | undefined; body: any }[] = [];
let handler: (n: number, res: http.ServerResponse) => void = () => undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
      handler(requests.length, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests = [];
});

const completion = (content: string | null, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'stub-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null, ...extra } }],
});
const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const llm = (o: Record<string, unknown> = {}) => new OpenAiLlm('sk-test-not-a-real-key', 'stub-model', { baseURL, timeoutMs: 400, attempts: 2, sleep: async () => undefined, random: () => 0.5, ...o });
const ask = (l: OpenAiLlm) => l.structured({ agent: 'a', system: 'sys', user: 'usr', schema: Out, schemaName: 'out' });

describe('OpenAI: structured outputs', () => {
  it('sends a strict JSON-schema response_format and returns the parsed, Zod-validated object', async () => {
    handler = (_n, res) => send(res, 200, completion(JSON.stringify({ verdict: 'ok', reasons: ['fine'] })));
    await expect(ask(llm())).resolves.toEqual({ verdict: 'ok', reasons: ['fine'] });
    expect(requests).toHaveLength(1);
    expect(requests[0].auth).toBe('Bearer sk-test-not-a-real-key');
    expect(requests[0].body).toMatchObject({ model: 'stub-model', response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true } } });
    expect(requests[0].body.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
  });

  it('rejects content that violates the schema, non-JSON content, refusals and empty messages — nothing unvalidated escapes', async () => {
    for (const content of [JSON.stringify({ verdict: 'maybe', reasons: [] }), JSON.stringify({ verdict: 'ok' }), 'definitely not json', '']) {
      handler = (_n, res) => send(res, 200, completion(content));
      await expect(ask(llm())).rejects.toBeTruthy();
    }
    handler = (_n, res) => send(res, 200, completion(null, { refusal: 'I cannot help with that' }));
    await expect(ask(llm())).rejects.toThrow(/refus/i);
  });

  it('retries 429 / 5xx with backoff, then succeeds', async () => {
    handler = (n, res) => (n === 1 ? send(res, 429, { error: { message: 'rate limited', type: 'rate_limit' } }, { 'retry-after': '0' }) : send(res, 200, completion(JSON.stringify({ verdict: 'ok', reasons: [] }))));
    await expect(ask(llm())).resolves.toMatchObject({ verdict: 'ok' });
    expect(requests).toHaveLength(2);
    requests = [];
    handler = (n, res) => (n === 1 ? send(res, 503, { error: { message: 'overloaded' } }) : send(res, 200, completion(JSON.stringify({ verdict: 'bad', reasons: ['x'] }))));
    await expect(ask(llm())).resolves.toMatchObject({ verdict: 'bad' });
    expect(requests).toHaveLength(2);
  });

  it('does NOT retry a 400/401, and maps persistent outages to DependencyError after the attempt budget', async () => {
    handler = (_n, res) => send(res, 401, { error: { message: 'bad key' } });
    await expect(ask(llm())).rejects.toBeTruthy();
    expect(requests).toHaveLength(1);
    requests = [];
    resetBreakers();
    handler = (_n, res) => send(res, 500, { error: { message: 'boom' } });
    await expect(ask(llm())).rejects.toBeInstanceOf(DependencyError);
    expect(requests).toHaveLength(2);
  });

  it('enforces the timeout: a hung first attempt is abandoned and retried', async () => {
    handler = (n, res) => {
      if (n === 1) return; // never answers
      send(res, 200, completion(JSON.stringify({ verdict: 'ok', reasons: [] })));
    };
    await expect(ask(llm({ timeoutMs: 120 }))).resolves.toMatchObject({ verdict: 'ok' });
    expect(requests).toHaveLength(2);
  });

  it('opens the "openai" circuit after repeated failures and stops calling the API', async () => {
    resetBreakers();
    handler = (_n, res) => send(res, 500, { error: { message: 'down' } });
    for (let i = 0; i < 3; i++) await ask(llm()).catch(() => undefined);
    expect(breakerStatus().find((b) => b.name === 'openai')?.state).toBe('open');
    const n = requests.length;
    await expect(ask(llm())).rejects.toBeInstanceOf(DependencyError);
    expect(requests.length).toBe(n);
  });
});
