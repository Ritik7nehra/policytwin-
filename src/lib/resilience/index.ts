import { DependencyError } from '../errors';
import { log } from '../security/log';

/**
 * Timeouts, bounded retries and a circuit breaker for every outbound dependency (PayPal, OpenAI).
 *  - Retry ONLY network failures, timeouts, HTTP 429 and HTTP 5xx.
 *  - The caller's request (headers included) is re-sent unchanged, so a PayPal-Request-Id is reused.
 *  - Exponential backoff with full jitter; `sleep` and `random` are injectable so tests are instant.
 */
export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TimeoutError extends Error {
  constructor(readonly label: string, readonly ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

// ───────────────────────── Circuit breaker ─────────────────────────
export type BreakerState = 'closed' | 'open' | 'half_open';
export interface BreakerSnapshot {
  name: string;
  state: BreakerState;
  consecutive_failures: number;
  opened_at: string | null;
  last_error: string | null;
  last_success_at: string | null;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private lastError: string | null = null;
  private lastSuccess: number | null = null;
  private probing = false;

  constructor(
    readonly name: string,
    private readonly opts: { failureThreshold?: number; cooldownMs?: number; now?: () => number } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }
  private get threshold() {
    return this.opts.failureThreshold ?? 5;
  }
  private get cooldown() {
    return this.opts.cooldownMs ?? 30_000;
  }

  /** Throws DependencyError when the circuit is open (and the cooldown has not elapsed). */
  assertAllowed(): void {
    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.cooldown) {
        this.state = 'half_open';
        this.probing = false;
      } else {
        throw new DependencyError(this.name, `${this.name} is unavailable (circuit open after repeated failures); retry shortly`);
      }
    }
    if (this.state === 'half_open') {
      if (this.probing) throw new DependencyError(this.name, `${this.name} is recovering (circuit half-open)`);
      this.probing = true; // exactly one probe request at a time
    }
  }
  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    this.probing = false;
    this.lastSuccess = this.now();
  }
  onFailure(err: unknown): void {
    this.failures++;
    this.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    this.probing = false;
    if (this.state === 'half_open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.now();
      log('warn', 'circuit opened', { dependency: this.name, failures: this.failures });
    }
  }
  snapshot(): BreakerSnapshot {
    // Report "open" lazily moving to half_open once the cooldown passed.
    const state = this.state === 'open' && this.now() - this.openedAt >= this.cooldown ? 'half_open' : this.state;
    return {
      name: this.name,
      state,
      consecutive_failures: this.failures,
      opened_at: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      last_error: this.lastError,
      last_success_at: this.lastSuccess ? new Date(this.lastSuccess).toISOString() : null,
    };
  }
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.probing = false;
  }
}

const registry = new Map<string, CircuitBreaker>();
export function getBreaker(name: string, opts?: ConstructorParameters<typeof CircuitBreaker>[1]): CircuitBreaker {
  let b = registry.get(name);
  if (!b) {
    b = new CircuitBreaker(name, opts);
    registry.set(name, b);
  }
  return b;
}
export const breakerStatus = (): BreakerSnapshot[] => [...registry.values()].map((b) => b.snapshot());
export const resetBreakers = (): void => registry.clear();

// ───────────────────────── Backoff / retry ─────────────────────────
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap) + 1; // full jitter, never 0
}

export interface ResilienceOptions {
  /** Total attempts including the first (PayPal / OpenAI: 3). */
  attempts?: number;
  timeoutMs: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  breaker?: CircuitBreaker;
  sleep?: Sleep;
  random?: () => number;
  label: string;
}

const RETRYABLE_STATUS = (s: number) => s === 429 || (s >= 500 && s <= 599);

/** fetch with timeout + bounded retries (network/timeout/429/5xx) + circuit breaker. Returns the last Response. */
export async function resilientFetch(f: typeof fetch, url: string, init: RequestInit, o: ResilienceOptions): Promise<Response> {
  const attempts = Math.max(1, o.attempts ?? 3);
  const sleep = o.sleep ?? realSleep;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    o.breaker?.assertAllowed();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new TimeoutError(o.label, o.timeoutMs)), o.timeoutMs);
    try {
      const res = await f(url, { ...init, signal: ctl.signal });
      if (RETRYABLE_STATUS(res.status)) {
        o.breaker?.onFailure(new Error(`${o.label}: HTTP ${res.status}`));
        if (attempt < attempts) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, o.maxDelayMs ?? 5000) : backoffDelay(attempt, o.baseDelayMs ?? 250, o.maxDelayMs ?? 5000, o.random);
          // Drain the body so the connection can be reused.
          await res.text().catch(() => undefined);
          log('warn', 'retrying after retryable status', { dependency: o.label, status: res.status, attempt, wait_ms: wait });
          await sleep(wait);
          continue;
        }
        return res; // out of attempts: caller sees the real status
      }
      o.breaker?.onSuccess();
      return res;
    } catch (e) {
      const err = ctl.signal.aborted && ctl.signal.reason instanceof TimeoutError ? ctl.signal.reason : e;
      lastErr = err;
      o.breaker?.onFailure(err);
      if (attempt < attempts) {
        const wait = backoffDelay(attempt, o.baseDelayMs ?? 250, o.maxDelayMs ?? 5000, o.random);
        log('warn', 'retrying after network error', { dependency: o.label, error: err instanceof Error ? err.message : String(err), attempt, wait_ms: wait });
        await sleep(wait);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new DependencyError(o.label, `${o.label} did not respond after ${attempts} attempt(s)`, lastErr);
}

/** Generic retry for SDK calls that throw (used for OpenAI). */
export async function withRetry<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  o: ResilienceOptions & { isRetryable?: (e: unknown) => boolean },
): Promise<T> {
  const attempts = Math.max(1, o.attempts ?? 3);
  const sleep = o.sleep ?? realSleep;
  const isRetryable = o.isRetryable ?? defaultRetryable;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    o.breaker?.assertAllowed();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new TimeoutError(o.label, o.timeoutMs)), o.timeoutMs);
    try {
      const v = await Promise.race([
        fn(attempt, ctl.signal),
        new Promise<never>((_, rej) => ctl.signal.addEventListener('abort', () => rej(ctl.signal.reason), { once: true })),
      ]);
      o.breaker?.onSuccess();
      return v;
    } catch (e) {
      lastErr = e;
      const retryable = isRetryable(e);
      if (retryable) o.breaker?.onFailure(e);
      else o.breaker?.onSuccess(); // a 4xx/validation problem is not a dependency outage
      if (!retryable || attempt >= attempts) break;
      await sleep(backoffDelay(attempt, o.baseDelayMs ?? 400, o.maxDelayMs ?? 5000, o.random));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastErr instanceof DependencyError) throw lastErr;
  if (isRetryable(lastErr)) throw new DependencyError(o.label, `${o.label} did not respond after ${attempts} attempt(s)`, lastErr);
  throw lastErr;
}

export function defaultRetryable(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  const status = (e as { status?: number })?.status;
  if (typeof status === 'number') return RETRYABLE_STATUS(status);
  const code = (e as { code?: string })?.code;
  if (typeof code === 'string' && /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|EPIPE/.test(code)) return true;
  const name = (e as { name?: string })?.name ?? '';
  return /APIConnection|Timeout|AbortError|FetchError/.test(name) || (e instanceof TypeError && /fetch failed/i.test(e.message));
}
