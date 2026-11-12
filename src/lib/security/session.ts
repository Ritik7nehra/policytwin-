import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Demo access control (hackathon-grade, deliberately not enterprise SSO):
 *  - a judge/demo passcode (DEMO_PASSCODE) creates a signed session;
 *  - the session cookie is HMAC-SHA256 signed, HttpOnly, SameSite=Lax, Secure on HTTPS/production;
 *  - the ACTOR recorded in audit trails is derived from the session on the server — a client-supplied name is never trusted;
 *  - in production the app FAILS CLOSED when DEMO_PASSCODE or SESSION_SECRET is missing.
 * Local development (NODE_ENV != production, no passcode set) runs in OPEN mode with one shared "local" workspace.
 */
export const COOKIE_NAME = 'pt_session';
export const OPEN_SID = 'local';
export const PUBLIC_OWNER = 'public';

export interface Session {
  sid: string;
  actor: string;
  mode: 'open' | 'passcode';
  expiresAt: number | null;
}

export interface AuthConfig {
  /** Is a valid session required for protected endpoints? */
  required: boolean;
  passcode: string | null;
  secret: string | null;
  ttlSec: number;
  /** Production without DEMO_PASSCODE / SESSION_SECRET → every protected endpoint answers 503 AUTH_NOT_CONFIGURED. */
  misconfigured: string | null;
}

let ephemeralSecret: string | null = null;

export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const passcode = env.DEMO_PASSCODE?.trim() || null;
  const prod = env.NODE_ENV === 'production';
  const configuredSecret = env.SESSION_SECRET?.trim() || null;
  const ttlSec = Math.max(300, Number(env.SESSION_TTL_HOURS || 8) * 3600);
  if (!passcode) {
    if (prod) return { required: true, passcode: null, secret: null, ttlSec, misconfigured: 'DEMO_PASSCODE is not set (the app refuses to run unauthenticated in production)' };
    return { required: false, passcode: null, secret: null, ttlSec, misconfigured: null };
  }
  if (configuredSecret && configuredSecret.length < 16) return { required: true, passcode, secret: null, ttlSec, misconfigured: 'SESSION_SECRET must be at least 16 characters' };
  if (!configuredSecret && prod) return { required: true, passcode, secret: null, ttlSec, misconfigured: 'SESSION_SECRET is not set' };
  ephemeralSecret ??= randomBytes(32).toString('hex'); // dev only: sessions end when the process restarts
  return { required: true, passcode, secret: configuredSecret ?? ephemeralSecret, ttlSec, misconfigured: null };
}

const b64u = (b: Buffer) => b.toString('base64url');

export const newSid = (): string => randomBytes(9).toString('base64url');
export const actorFor = (sid: string): string => `demo.judge#${sid.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toLowerCase()}`;

function sign(secret: string, payload: string): string {
  return b64u(createHmac('sha256', secret).update(payload).digest());
}

export function createSessionToken(sid: string, secret: string, ttlSec: number, nowMs = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = nowMs + ttlSec * 1000;
  const payload = `${sid}.${expiresAt}`;
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt };
}

export function verifySessionToken(token: string | undefined | null, secret: string, nowMs = Date.now()): { sid: string; expiresAt: number } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [sid, exp, sig] = parts;
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(sid) || !/^\d{10,15}$/.test(exp)) return null;
  const expected = sign(secret, `${sid}.${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiresAt = Number(exp);
  if (!(expiresAt > nowMs)) return null;
  return { sid, expiresAt };
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, ttlSec: number, secure: boolean): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlSec}${secure ? '; Secure' : ''}`;
}
export function clearCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Constant-time passcode comparison (hash both sides so the length never leaks). */
export function passcodeMatches(input: string, expected: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(input), h(expected));
}

export function isSecureRequest(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  const proto = req.headers.get('x-forwarded-proto');
  return proto === 'https' || new URL(req.url).protocol === 'https:';
}

/** Rightmost X-Forwarded-For entry = the address the platform proxy (Render) actually saw. */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}
