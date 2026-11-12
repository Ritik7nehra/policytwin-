import { describe, expect, it } from 'vitest';
import { CircuitBreaker, TimeoutError, backoffDelay, resilientFetch, withRetry, getBreaker, breakerStatus, resetBreakers } from '@/lib/resilience';
import { DependencyError } from '@/lib/errors';

const instant = async () => undefined;
const res = (status: number, headers: Record<string, string> = {}) => new Response(status === 204 ? null : '{}', { status, headers });

describe('backoff', () => {
  it('grows exponentially, is capped, uses full jitter and is never zero', () => {
    expect(backoffDelay(1, 100, 10_000, () => 0.999)).toBe(100);
    expect(backoffDelay(2, 100, 10_000, () => 0.999)).toBe(200);
    expect(backoffDelay(4, 100, 10_000, () => 0.999)).toBe(800);
    expect(backoffDelay(20, 100, 1_000, () => 0.999)).toBe(1_000);
    expect(backoffDelay(3, 100, 10_000, () => 0)).toBe(1);
  });
});

describe('resilientFetch', () => {
  it('retries a network failure and re-sends the SAME headers (so the same PayPal-Request-Id)', async () => {
    const seen: Record<string, string>[] = [];
    let n = 0;
    const f = (async (_u: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      if (++n === 1) throw new TypeError('fetch failed');
      return res(200);
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const r = await resilientFetch(f, 'https://x', { method: 'POST', headers: { 'PayPal-Request-Id': 'rid-1' } }, { label: 'paypal', timeoutMs: 1000, sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
    expect(r.status).toBe(200);
    expect(n).toBe(2);
    expect(seen.map((h) => h['PayPal-Request-Id'])).toEqual(['rid-1', 'rid-1']);
    expect(waits).toHaveLength(1);
  });

  it('retries 429 (honouring Retry-After) and 5xx, but NOT other 4xx', async () => {
    const codes = [429, 503, 200];
    const f = (async () => res(codes.shift()!, codes.length === 2 ? { 'retry-after': '2' } : {})) as unknown as typeof fetch;
    const waits: number[] = [];
    const r = await resilientFetch(f, 'https://x', {}, { label: 'paypal', timeoutMs: 1000, sleep: async (ms) => void waits.push(ms), attempts: 3 });
    expect(r.status).toBe(200);
    expect(waits[0]).toBe(2000);

    let calls = 0;
    const g = (async () => (calls++, res(422))) as unknown as typeof fetch;
    expect((await resilientFetch(g, 'https://x', {}, { label: 'paypal', timeoutMs: 1000, sleep: instant })).status).toBe(422);
    expect(calls).toBe(1);
  });

  it('gives up after the maximum attempts: returns the last retryable response, or throws DependencyError for network failures', async () => {
    let calls = 0;
    const f503 = (async () => (calls++, res(503))) as unknown as typeof fetch;
    expect((await resilientFetch(f503, 'https://x', {}, { label: 'paypal', timeoutMs: 1000, sleep: instant, attempts: 3 })).status).toBe(503);
    expect(calls).toBe(3);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(resilientFetch(down, 'https://x', {}, { label: 'paypal', timeoutMs: 1000, sleep: instant, attempts: 2 })).rejects.toBeInstanceOf(DependencyError);
  });

  it('times out a hung request (abort) and retries it', async () => {
    let n = 0;
    const f = ((_u: string, init: RequestInit) =>
      ++n === 1
        ? new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))
        : Promise.resolve(res(200))) as unknown as typeof fetch;
    const r = await resilientFetch(f, 'https://x', {}, { label: 'paypal', timeoutMs: 20, sleep: instant });
    expect(r.status).toBe(200);
    expect(n).toBe(2);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures, fails fast, half-opens after the cooldown and closes on success', () => {
    let now = 1_000;
    const b = new CircuitBreaker('x', { failureThreshold: 3, cooldownMs: 1000, now: () => now });
    for (let i = 0; i < 3; i++) {
      b.assertAllowed();
      b.onFailure(new Error('down'));
    }
    expect(b.snapshot().state).toBe('open');
    expect(() => b.assertAllowed()).toThrow(DependencyError);
    now += 1001;
    expect(b.snapshot().state).toBe('half_open');
    b.assertAllowed(); // one probe
    expect(() => b.assertAllowed()).toThrow(DependencyError); // second concurrent probe refused
    b.onSuccess();
    expect(b.snapshot().state).toBe('closed');
  });

  it('is reported by status (this is what /api/health shows)', () => {
    resetBreakers();
    getBreaker('paypal').onFailure(new Error('boom'));
    expect(breakerStatus()).toEqual([expect.objectContaining({ name: 'paypal', state: 'closed', consecutive_failures: 1, last_error: 'boom' })]);
    resetBreakers();
  });

  it('resilientFetch trips the breaker and then fails fast without calling the network', async () => {
    const b = new CircuitBreaker('paypal', { failureThreshold: 2, cooldownMs: 60_000 });
    let calls = 0;
    const f = (async () => (calls++, res(500))) as unknown as typeof fetch;
    await resilientFetch(f, 'https://x', {}, { label: 'paypal', timeoutMs: 1000, sleep: instant, attempts: 2, breaker: b });
    expect(calls).toBe(2);
    await expect(resilientFetch(f, 'https://x', {}, { label: 'paypal', timeoutMs: 1000, sleep: instant, breaker: b })).rejects.toBeInstanceOf(DependencyError);
    expect(calls).toBe(2);
  });
});

describe('withRetry (SDK calls)', () => {
  it('retries retryable errors only, with a timeout', async () => {
    let n = 0;
    const out = await withRetry(async () => {
      if (++n < 2) throw Object.assign(new Error('rate limited'), { status: 429 });
      return 'ok';
    }, { label: 'openai', timeoutMs: 1000, sleep: instant });
    expect(out).toBe('ok');
    let m = 0;
    await expect(withRetry(async () => (m++, Promise.reject(Object.assign(new Error('bad request'), { status: 400 }))), { label: 'openai', timeoutMs: 1000, sleep: instant })).rejects.toThrow('bad request');
    expect(m).toBe(1);
    await expect(withRetry(() => new Promise(() => undefined), { label: 'openai', timeoutMs: 15, attempts: 1, sleep: instant })).rejects.toBeInstanceOf(DependencyError);
    expect(new TimeoutError('x', 5).message).toMatch(/timed out/);
  });
});
