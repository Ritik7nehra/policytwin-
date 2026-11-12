/**
 * sanitizeFinancialEvidence — the ONE function every piece of payment-related evidence passes
 * through before it is (1) inserted into the database, (2) logged, (3) returned by an API route,
 * or (4) rendered into a report.
 *
 * Policy: PolicyTwin never needs a card number, expiry, cardholder name, payer identity, email,
 * phone or address to prove a financial invariant. The only evidence kept is
 *     method · endpoint · request id · amount · currency · resource id · HTTP status · issue code
 * plus non-identifying state (status, timestamps, event ids/types).
 *
 * Two layers:
 *  1. KEY layer   – whole sub-trees under sensitive keys (payment_source, card, payer, shipping,
 *                   address, email, phone, name, number, expiry, cvv, tokens, secrets…) are removed.
 *  2. VALUE layer – any remaining string is scrubbed for Luhn-valid card numbers (13–19 digits,
 *                   spaces/dashes allowed), e-mail addresses and bearer/basic credentials.
 * The function is pure, idempotent and never throws.
 */

export const REDACTED = '[REDACTED]';

/** Keys whose entire value is dropped (compared after lower-casing and stripping separators). */
const DROP_KEYS = new Set(
  [
    'payment_source',
    'card',
    'card_number',
    'number',
    'expiry',
    'expiration',
    'expiration_date',
    'exp_month',
    'exp_year',
    'security_code',
    'cvv',
    'cvc',
    'cvv2',
    'last_digits',
    'brand',
    'bin_details',
    'payer',
    'payer_id',
    'payee_email',
    'email',
    'email_address',
    'phone',
    'phone_number',
    'national_number',
    'shipping',
    'shipping_address',
    'billing_address',
    'address',
    'address_line_1',
    'address_line_2',
    'admin_area_1',
    'admin_area_2',
    'postal_code',
    'given_name',
    'surname',
    'full_name',
    'first_name',
    'last_name',
    'cardholder_name',
    'name_on_card',
    'birth_date',
    'tax_info',
    'ip_address',
    'authorization_header',
    'access_token',
    'refresh_token',
    'id_token',
    'client_secret',
    'client_id',
    'secret',
    'password',
    'passcode',
    'api_key',
    'cookie',
    'set_cookie',
    'links', // HATEOAS links add nothing to the evidence and can embed tokens
  ].map((k) => k.replace(/[^a-z0-9]/g, '')),
);

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
const ERROR_CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/; // PayPal error names, e.g. UNPROCESSABLE_ENTITY

const CARD_RE = /(?<![\w.])(?:\d[ -]?){13,19}(?![\w])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const AUTH_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum > 0 && sum % 10 === 0;
}

export function scrubString(s: string): string {
  return s
    .replace(CARD_RE, (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '[REDACTED-PAN]' : m;
    })
    .replace(EMAIL_RE, '[REDACTED-EMAIL]')
    .replace(AUTH_RE, '$1 [REDACTED]');
}

const MAX_DEPTH = 12;

function walk(value: unknown, key: string | null, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    if (key !== null && norm(key) === 'name') return ERROR_CODE_RE.test(value) ? value : undefined; // keep PayPal error names, drop person/card names
    return scrubString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (seen.has(value as object)) return '[CIRCULAR]';
  seen.add(value as object);
  try {
    if (Array.isArray(value)) return value.map((v) => walk(v, null, depth + 1, seen)).filter((v) => v !== undefined);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return { error: scrubString(value.message) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const nk = norm(k);
      if (DROP_KEYS.has(nk)) continue;
      if (nk === 'name' && v !== null && typeof v === 'object') continue; // { name: { given_name… } } is a person
      const w = walk(v, k, depth + 1, seen);
      if (w !== undefined) out[k] = w;
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}

/** Remove everything that identifies a card, a payer or a credential; keep only safe evidence. */
export function sanitizeFinancialEvidence<T = unknown>(value: T): T {
  try {
    const r = walk(value, null, 0, new WeakSet());
    return (r === undefined ? null : r) as T;
  } catch {
    return '[UNSANITIZABLE]' as unknown as T;
  }
}

/** True if `value` still contains anything the sanitizer would remove (used by tests and a DB-layer guard). */
export function containsSensitive(value: unknown): boolean {
  const before = JSON.stringify(value ?? null);
  const after = JSON.stringify(sanitizeFinancialEvidence(value) ?? null);
  return before !== after;
}

// ───────────────────────── The only evidence shape PolicyTwin stores for a PayPal call ─────────────────────────
export interface SafeCallEvidence {
  method: string;
  endpoint: string;
  request_id: string | null;
  amount: string | null;
  currency: string | null;
}
export interface SafeResponseEvidence {
  http_status: number | null;
  resource_id: string | null;
  resource_status: string | null;
  amount: string | null;
  currency: string | null;
  /** Normalised PayPal issue code (e.g. CAPTURE_FULLY_REFUNDED), or null on success. */
  issue_code: string | null;
  error_name: string | null;
  debug_id: string | null;
}

const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? scrubString(v) : null);

function findAmount(o: any): { value: string | null; currency: string | null } {
  const a = o?.amount ?? o?.purchase_units?.[0]?.amount ?? o?.purchase_units?.[0]?.payments?.captures?.[0]?.amount;
  return { value: asStr(a?.value), currency: asStr(a?.currency_code) };
}

/** Project a PayPal request into the safe call shape (never copies the body wholesale). */
export function safeCallEvidence(call: { method: string; path: string; request_id: string | null; body: unknown }): SafeCallEvidence {
  const body: any = call.body ?? {};
  const amt = findAmount(body?.purchase_units ? { purchase_units: body.purchase_units } : body);
  return { method: call.method, endpoint: scrubString(call.path), request_id: call.request_id, amount: amt.value, currency: amt.currency };
}

/** Project a PayPal response into the safe response shape. */
export function safeResponseEvidence(status: number | null, raw: unknown): SafeResponseEvidence {
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const cap = r?.purchase_units?.[0]?.payments?.captures?.[0];
  const auth = r?.purchase_units?.[0]?.payments?.authorizations?.[0];
  const amt = findAmount(r);
  const name = typeof r.name === 'string' && ERROR_CODE_RE.test(r.name) ? r.name : null;
  const issue = asStr(r?.details?.[0]?.issue);
  return {
    http_status: status,
    resource_id: asStr(cap?.id ?? auth?.id ?? r.id),
    resource_status: asStr(cap?.status ?? auth?.status ?? r.status),
    amount: amt.value,
    currency: amt.currency,
    issue_code: issue,
    error_name: name,
    debug_id: asStr(r.debug_id),
  };
}
