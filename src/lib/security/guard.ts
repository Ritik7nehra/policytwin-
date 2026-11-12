import { ForbiddenError, HttpError, QuotaExceededError, RateLimitedError, UnauthenticatedError } from '../errors';
import { limiter, type RateBucket } from './ratelimit';
import { COOKIE_NAME, OPEN_SID, PUBLIC_OWNER, actorFor, authConfig, clientIp, parseCookies, verifySessionToken, type Session } from './session';
import type { Store } from '../store/types';
import { log } from './log';

export type GuardKind = 'read' | 'write' | 'heavy';

export interface Limits {
  maxRunsPerSession: number;
  maxPoliciesPerSession: number;
  /** Max LLM-backed agent calls per UTC day (all sessions). Beyond it agents fall back to the deterministic implementation. */
  aiCallsPerDay: number;
}
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
  return { maxRunsPerSession: n(env.MAX_RUNS_PER_SESSION, 12), maxPoliciesPerSession: n(env.MAX_POLICIES_PER_SESSION, 20), aiCallsPerDay: n(env.MAX_AI_CALLS_PER_DAY, 150) };
}

const OPEN_SESSION: Session = { sid: OPEN_SID, actor: 'policy.analyst (local dev)', mode: 'open', expiresAt: null };

/** Cross-site request forgery defence for cookie auth: refuse state-changing requests from another origin. */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  if (origin) {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* malformed origin → refuse below */
    }
    if (!host || originHost !== host) throw new ForbiddenError('Cross-origin request refused');
    return;
  }
  if (req.headers.get('sec-fetch-site') === 'cross-site') throw new ForbiddenError('Cross-site request refused');
}

/** Resolve the session from the signed cookie (or open mode in local dev). Returns null if there is none. */
export function sessionFrom(req: Request, env: NodeJS.ProcessEnv = process.env): Session | null {
  const cfg = authConfig(env);
  if (cfg.misconfigured) throw new HttpError(503, 'AUTH_NOT_CONFIGURED', `Server access control is not configured: ${cfg.misconfigured}`);
  if (!cfg.required) return OPEN_SESSION;
  const token = parseCookies(req.headers.get('cookie'))[COOKIE_NAME];
  const v = verifySessionToken(token, cfg.secret!);
  return v ? { sid: v.sid, actor: actorFor(v.sid), mode: 'passcode', expiresAt: v.expiresAt } : null;
}

export interface GuardOptions {
  kind: GuardKind;
  /** Public read-only endpoints (the shared example report) may be called without a session. */
  allowAnonymous?: boolean;
}

/**
 * Authenticate + CSRF-check + rate-limit a request. Returns the session (or null for an anonymous public read).
 * Rate limits apply per session AND per client IP.
 */
export function guard(req: Request, o: GuardOptions): Session | null {
  if (o.kind !== 'read') assertSameOrigin(req);
  const session = sessionFrom(req);
  if (!session && !o.allowAnonymous) throw new UnauthenticatedError('Enter the demo passcode to continue');
  const bucket: RateBucket = o.kind;
  const l = limiter();
  const ip = clientIp(req);
  const checks = [l.hit(bucket, `ip:${ip}`, 2), ...(session ? [l.hit(bucket, `sid:${session.sid}`)] : [])];
  const blocked = checks.find((c) => !c.ok);
  if (blocked && !blocked.ok) {
    log('warn', 'rate limited', { bucket, ip, sid: session?.sid });
    throw new RateLimitedError(blocked.retryAfterSec);
  }
  return session;
}

export const requireSession = (s: Session | null): Session => {
  if (!s) throw new UnauthenticatedError('Enter the demo passcode to continue');
  return s;
};

/** Ownership: a session may read its own workspace and the public examples; it may write only to its own workspace. */
export function assertAccess(session: Session | null, owner: string, mode: 'read' | 'write'): void {
  if (owner === PUBLIC_OWNER) {
    if (mode === 'write') throw new ForbiddenError('This is a read-only public example. Create your own policy to run it.');
    return;
  }
  if (!session) throw new UnauthenticatedError('Enter the demo passcode to continue');
  if (session.sid !== owner) throw new ForbiddenError();
}

export async function assertRunQuota(store: Store, session: Session, limits: Limits = limitsFromEnv()): Promise<void> {
  const used = await store.count('test_runs', { owner_session: session.sid });
  if (used >= limits.maxRunsPerSession) throw new QuotaExceededError(`This demo session has reached its limit of ${limits.maxRunsPerSession} test runs. Use "Reset my demo data" to start over.`);
}
export async function assertPolicyQuota(store: Store, session: Session, limits: Limits = limitsFromEnv()): Promise<void> {
  const used = await store.count('policies', { owner_session: session.sid });
  if (used >= limits.maxPoliciesPerSession) throw new QuotaExceededError(`This demo session has reached its limit of ${limits.maxPoliciesPerSession} policies. Use "Reset my demo data" to start over.`);
}

/** Delete everything a session owns (children first, honouring foreign keys). Returns row counts. */
export async function resetSessionData(store: Store, sid: string): Promise<Record<string, number>> {
  if (sid === PUBLIC_OWNER) throw new ForbiddenError('Public examples cannot be reset');
  return store.transaction(async (tx) => {
    const runs = await tx.list('test_runs', { owner_session: sid });
    const runIds = new Set(runs.map((r) => r.id));
    const counts: Record<string, number> = {};
    const bump = (k: string, n: number) => (counts[k] = (counts[k] ?? 0) + n);
    for (const id of runIds) {
      for (const t of ['paypal_executions', 'invariant_results', 'policy_decisions'] as const) bump(t, await tx.deleteWhere(t, { test_run_id: id }));
      bump('agent_runs', await tx.deleteWhere('agent_runs', { test_run_id: id }));
      bump('audit_events', await tx.deleteWhere('audit_events', { test_run_id: id }));
      bump('run_stages', await tx.deleteWhere('run_stages', { run_id: id }));
      bump('scenarios', await tx.deleteWhere('scenarios', { test_run_id: id }));
    }
    // test_runs reference each other (parent_run_id): delete children first.
    const remaining = new Set(runIds);
    while (remaining.size) {
      const leaves = runs.filter((r) => remaining.has(r.id) && !runs.some((o) => remaining.has(o.id) && o.parent_run_id === r.id));
      if (!leaves.length) break;
      for (const r of leaves) {
        bump('test_runs', await tx.deleteWhere('test_runs', { id: r.id }));
        remaining.delete(r.id);
      }
    }
    for (const p of await tx.list('policies', { owner_session: sid })) {
      bump('policy_versions', await tx.deleteWhere('policy_versions', { policy_id: p.id }));
      bump('policies', await tx.deleteWhere('policies', { id: p.id }));
    }
    return counts;
  });
}
