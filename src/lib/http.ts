import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { BadRequestError, DependencyError, HttpError, PayloadTooLargeError, ValidationError, asHttpError, zodIssues } from './errors';
import { log } from './security/log';
import { shortId } from './util';
import { IdParam, LIMITS } from './validation/schemas';
import { ConstraintError } from './store/errors';

/** Run a handler and map thrown errors to JSON responses. Internal error text is NEVER sent to clients. */
export async function respond<T>(fn: () => Promise<T>, okStatus = 200, headers?: Record<string, string>): Promise<NextResponse> {
  try {
    const out = await fn();
    if (out instanceof NextResponse) return out;
    return NextResponse.json(out, { status: okStatus, headers });
  } catch (e) {
    return errorResponse(e);
  }
}

export function errorResponse(e: unknown): NextResponse {
  const http = asHttpError(e) ?? (e instanceof ConstraintError ? new HttpError(409, 'CONFLICT', constraintMessage(e)) : null);
  if (http) {
    const headers: Record<string, string> = {};
    if (http.extra.retryAfterSeconds) headers['Retry-After'] = String(http.extra.retryAfterSeconds);
    if (http.status >= 500) log('error', 'dependency error', { code: http.code, message: http.message, cause: http instanceof DependencyError && http.cause instanceof Error ? http.cause.message : undefined });
    return NextResponse.json({ error: http.message, code: http.code, ...(http.extra.issues ? { issues: http.extra.issues } : {}) }, { status: http.status, headers });
  }
  // Unknown failure: log the real cause server-side, give the client only a correlation id.
  const ref = shortId('err');
  log('error', 'unhandled error', { ref, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.split('\n').slice(0, 4).join(' | ') : undefined });
  return NextResponse.json({ error: 'Internal error', code: 'INTERNAL', reference: ref }, { status: 500 });
}

function constraintMessage(e: ConstraintError): string {
  if (e.kind === 'unique') return 'This change conflicts with an existing record (it may already have been applied)';
  if (e.kind === 'foreign_key') return 'This change refers to a record that does not exist';
  return 'The request violates a data integrity rule';
}

/** Read a request body as text, enforcing a byte cap both from Content-Length and while streaming. */
export async function readBodyText(req: Request, maxBytes: number = LIMITS.body): Promise<string> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError(maxBytes);
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Parse + validate a JSON body: 400 malformed JSON, 413 too large, 422 schema failure. */
export async function readJson<S extends ZodType>(req: Request, schema: S, maxBytes: number = LIMITS.body): Promise<z.infer<S>> {
  const text = await readBodyText(req, maxBytes);
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new BadRequestError('invalid JSON body');
    }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ValidationError('Request body must be a JSON object', [{ path: '(body)', message: 'expected an object' }]);
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Request validation failed', zodIssues(r.error));
  return r.data;
}

/** Validate a path id (never trust route params). */
export function parseId(id: string): string {
  const r = IdParam.safeParse(id);
  if (!r.success) throw new BadRequestError('Invalid id: use letters, digits, "_" or "-" (max 64 characters)');
  return r.data;
}

export type IdParams = { params: Promise<{ id: string }> };
