import { NextResponse } from 'next/server';
import { getContext } from '@/lib/context';
import { errorResponse, readJson } from '@/lib/http';
import { LoginSchema } from '@/lib/validation/schemas';
import { UnauthenticatedError, RateLimitedError, HttpError } from '@/lib/errors';
import { actorFor, authConfig, clearCookie, createSessionToken, isSecureRequest, newSid, passcodeMatches, sessionCookie } from '@/lib/security/session';
import { limiter } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/session';
import { assertSameOrigin, limitsFromEnv, sessionFrom } from '@/lib/security/guard';
import { publicExampleRunIds } from '@/lib/examples';
import { PUBLIC_EXAMPLE_POLICY_ID } from '@/lib/examples';
import { log } from '@/lib/security/log';

export const dynamic = 'force-dynamic';

/** GET /api/session — who am I, what are my limits, where is the public example. Always 200 so the UI can render the login gate. */
export async function GET(req: Request) {
  try {
    const cfg = authConfig();
    if (cfg.misconfigured) throw new HttpError(503, 'AUTH_NOT_CONFIGURED', `Server access control is not configured: ${cfg.misconfigured}`);
    const l = limiter().hit('read', `ip:${clientIp(req)}`, 2);
    if (!l.ok) throw new RateLimitedError(l.retryAfterSec);
    const ctx = await getContext();
    const session = sessionFrom(req);
    const example = { policy_id: PUBLIC_EXAMPLE_POLICY_ID, run_ids: await publicExampleRunIds(ctx).catch(() => []) };
    if (!session) return NextResponse.json({ authenticated: false, required: true, public_example: example });
    const [runs, policies] = await Promise.all([ctx.store.count('test_runs', { owner_session: session.sid }), ctx.store.count('policies', { owner_session: session.sid })]);
    return NextResponse.json({
      authenticated: true,
      required: cfg.required,
      mode: session.mode,
      actor: session.actor,
      expires_at: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
      limits: ctx.limits ?? limitsFromEnv(),
      usage: { runs, policies },
      public_example: example,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST /api/session { passcode } — exchange the demo passcode for a signed, HttpOnly session cookie. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const cfg = authConfig();
    if (cfg.misconfigured) throw new HttpError(503, 'AUTH_NOT_CONFIGURED', `Server access control is not configured: ${cfg.misconfigured}`);
    if (!cfg.required) return NextResponse.json({ authenticated: true, required: false, mode: 'open', actor: 'policy.analyst (local dev)' });
    const ip = clientIp(req);
    const rl = limiter().hit('login', `ip:${ip}`);
    if (!rl.ok) throw new RateLimitedError(rl.retryAfterSec, 'Too many passcode attempts; wait a few minutes');
    const { passcode } = await readJson(req, LoginSchema, 2048);
    if (!passcodeMatches(passcode, cfg.passcode!)) {
      log('warn', 'failed login', { ip });
      throw new UnauthenticatedError('Incorrect passcode');
    }
    const sid = newSid();
    const { token, expiresAt } = createSessionToken(sid, cfg.secret!, cfg.ttlSec);
    const res = NextResponse.json({ authenticated: true, required: true, mode: 'passcode', actor: actorFor(sid), expires_at: new Date(expiresAt).toISOString() });
    res.headers.append('Set-Cookie', sessionCookie(token, cfg.ttlSec, isSecureRequest(req)));
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE /api/session — sign out. */
export async function DELETE(req: Request) {
  try {
    assertSameOrigin(req);
    const res = NextResponse.json({ authenticated: false });
    res.headers.append('Set-Cookie', clearCookie(isSecureRequest(req)));
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
