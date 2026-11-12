/**
 * In-process sliding-window rate limiter keyed by (bucket, session) and (bucket, IP).
 * Honest scope: counters live in this process (single Render instance). For several instances put the limit in
 * front (platform / CDN) or move the counters to the database.
 */
export type RateBucket = 'read' | 'write' | 'heavy' | 'login' | 'webhook';

export interface RateRule {
  limit: number;
  windowMs: number;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function defaultRules(env: NodeJS.ProcessEnv = process.env): Record<RateBucket, RateRule> {
  return {
    read: { limit: num(env.RATE_LIMIT_READ_PER_MIN, 240), windowMs: 60_000 },
    write: { limit: num(env.RATE_LIMIT_WRITE_PER_MIN, 40), windowMs: 60_000 },
    heavy: { limit: num(env.RATE_LIMIT_HEAVY_PER_MIN, 8), windowMs: 60_000 }, // run creation / execute / repair / sandbox proof
    login: { limit: num(env.RATE_LIMIT_LOGIN_PER_15MIN, 8), windowMs: 15 * 60_000 },
    webhook: { limit: num(env.RATE_LIMIT_WEBHOOK_PER_MIN, 300), windowMs: 60_000 },
  };
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private rules: Record<RateBucket, RateRule> = defaultRules(),
    private readonly now: () => number = Date.now,
  ) {}

  setRules(r: Partial<Record<RateBucket, RateRule>>) {
    this.rules = { ...this.rules, ...r };
  }

  /** Records one hit for `key` in `bucket`; returns ok=false (and a Retry-After) when the window is full. */
  hit(bucket: RateBucket, key: string, multiplier = 1): { ok: true } | { ok: false; retryAfterSec: number } {
    const rule = this.rules[bucket];
    const limit = Math.ceil(rule.limit * multiplier);
    const t = this.now();
    const k = `${bucket}|${key}`;
    const arr = (this.hits.get(k) ?? []).filter((x) => x > t - rule.windowMs);
    if (arr.length >= limit) {
      this.hits.set(k, arr);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + rule.windowMs - t) / 1000)) };
    }
    arr.push(t);
    this.hits.set(k, arr);
    if (this.hits.size > 5000) this.prune(t);
    return { ok: true };
  }

  private prune(t: number) {
    const maxWindow = Math.max(...Object.values(this.rules).map((r) => r.windowMs));
    for (const [k, v] of this.hits) if (!v.length || v[v.length - 1] <= t - maxWindow) this.hits.delete(k);
  }

  reset() {
    this.hits.clear();
  }
}

const g = globalThis as unknown as { __policytwin_limiter?: RateLimiter };
export const limiter = (): RateLimiter => (g.__policytwin_limiter ??= new RateLimiter());
export const resetRateLimits = (): void => {
  g.__policytwin_limiter = new RateLimiter();
};
