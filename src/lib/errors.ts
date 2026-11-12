import { ZodError } from 'zod';

/**
 * Typed HTTP errors. Only HttpError subclasses (messages we wrote) and validation issues are ever
 * shown to a client; anything else becomes a generic 500 with a correlation id, and the real cause
 * is logged server-side only.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { retryAfterSeconds?: number; issues?: { path: string; message: string }[] } = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class BadRequestError extends HttpError {
  constructor(message = 'Malformed request') {
    super(400, 'BAD_REQUEST', message);
  }
}
export class UnauthenticatedError extends HttpError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHENTICATED', message);
  }
}
export class ForbiddenError extends HttpError {
  constructor(message = 'You do not have access to this resource') {
    super(403, 'FORBIDDEN', message);
  }
}
export class NotFoundError extends HttpError {
  constructor(what = 'resource') {
    super(404, 'NOT_FOUND', `${what} not found`);
  }
}
export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}
export class PayloadTooLargeError extends HttpError {
  constructor(max: number) {
    super(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds the ${max}-byte limit`);
  }
}
export class ValidationError extends HttpError {
  constructor(message: string, issues: { path: string; message: string }[] = []) {
    super(422, 'VALIDATION_FAILED', message, { issues });
  }
}
export class RateLimitedError extends HttpError {
  constructor(retryAfterSeconds: number, message = 'Too many requests') {
    super(429, 'RATE_LIMITED', message, { retryAfterSeconds });
  }
}
export class QuotaExceededError extends HttpError {
  constructor(message: string) {
    super(429, 'QUOTA_EXCEEDED', message, { retryAfterSeconds: 3600 });
  }
}
/** A dependency (PayPal, OpenAI, the database) is down, timing out, or its circuit breaker is open. */
export class DependencyError extends HttpError {
  constructor(
    readonly dependency: string,
    message?: string,
    readonly cause?: unknown,
  ) {
    super(503, 'DEPENDENCY_UNAVAILABLE', message ?? `${dependency} is temporarily unavailable`, { retryAfterSeconds: 5 });
  }
}

export function zodIssues(e: ZodError): { path: string; message: string }[] {
  // Issue messages never echo the submitted value (zod's default messages do not), and we only keep path + message.
  return e.issues.slice(0, 20).map((i) => ({ path: i.path.join('.') || '(body)', message: i.message }));
}

/** Normalise any thrown value to an HttpError (or null for "unexpected → 500"). */
export function asHttpError(e: unknown): HttpError | null {
  if (e instanceof HttpError) return e;
  if (e instanceof ZodError) return new ValidationError('Request validation failed', zodIssues(e));
  return null;
}
