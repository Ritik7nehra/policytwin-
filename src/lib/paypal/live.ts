import type { ApiError, AuthorizationInfo, CallRecord, CaptureInfo, Money, OrderInfo, PayPalAdapter, RefundInfo, Res } from './types';
import { CaptureShape, MalformedResponseError, OrderShape, RefundShape, validated } from './schemas';
import { CircuitBreaker, getBreaker, resilientFetch, type Sleep } from '../resilience';
import { DependencyError } from '../errors';
import { sanitizeFinancialEvidence } from '../security/sanitize';

export interface SandboxConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  webhookId?: string;
  /**
   * Sandbox test card for server-side confirm-payment-source. Never hard-coded: comes from env.
   * Sending raw card details through the API requires PCI SAQ D compliance (PayPal docs), so this
   * path is OFF unless `allowDirectCard` is explicitly set, and the card is never recorded, logged or returned.
   * The recommended production path is PayPal's JavaScript SDK / Hosted Fields (see README).
   */
  card?: { number: string; expiry: string; name: string };
  allowDirectCard?: boolean;
  /** Merchant id to attribute refunds to when PayPal does not echo a payee (see README limitations). */
  merchantId?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. PayPal: 12s. */
  timeoutMs?: number;
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  sleep?: Sleep;
  random?: () => number;
  breaker?: CircuitBreaker;
}

const SANDBOX_HOSTS = new Set(['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']);

/** Hard guard: PolicyTwin must never talk to production PayPal. */
export function assertSandboxBaseUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`PAYPAL_BASE_URL is not a valid URL: ${url}`);
  }
  if (u.protocol !== 'https:' || !SANDBOX_HOSTS.has(u.hostname)) {
    throw new Error(`Refusing to use "${url}": PolicyTwin only talks to the PayPal Sandbox (api-m.sandbox.paypal.com).`);
  }
  return `${u.protocol}//${u.host}`;
}

const NO_DIRECT_CARD =
  'Direct-card Sandbox confirmation is disabled. PayPal requires PCI SAQ D compliance to send raw card details through the API; ' +
  'use the JavaScript SDK / Hosted Fields for payment-source approval, or (Sandbox test cards only) set PAYPAL_ALLOW_DIRECT_CARD_SANDBOX=1 together with PAYPAL_SANDBOX_CARD_NUMBER.';

/**
 * Real PayPal Sandbox adapter (REST v2). Every financial write carries a PayPal-Request-Id, and a
 * retry re-sends the SAME headers, so a timeout followed by a retry can never create a second order,
 * capture or refund.
 */
export class PayPalSandboxAdapter implements PayPalAdapter {
  readonly mode = 'sandbox' as const;
  readonly label = 'PayPal Sandbox (live REST API, test money)';
  private readonly base: string;
  private readonly f: typeof fetch;
  readonly breaker: CircuitBreaker;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly payeeByOrder = new Map<string, string>();

  constructor(private readonly cfg: SandboxConfig) {
    this.base = assertSandboxBaseUrl(cfg.baseUrl ?? 'https://api-m.sandbox.paypal.com');
    this.f = cfg.fetchImpl ?? fetch;
    this.breaker = cfg.breaker ?? getBreaker('paypal');
  }

  private http(url: string, init: RequestInit, label: string): Promise<Response> {
    return resilientFetch(this.f, url, init, {
      label,
      timeoutMs: this.cfg.timeoutMs ?? 12_000,
      attempts: this.cfg.attempts ?? 3,
      breaker: this.breaker,
      sleep: this.cfg.sleep,
      random: this.cfg.random,
    });
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const r = await this.http(
      `${this.base}/v1/oauth2/token`,
      { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' },
      'paypal',
    );
    if (!r.ok) throw new DependencyError('paypal', `PayPal OAuth failed: HTTP ${r.status}`);
    const j = (await r.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!j?.access_token || typeof j.expires_in !== 'number') throw new DependencyError('paypal', 'PayPal authentication returned an unusable token response');
    this.token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  /** Public so the integration test can verify authentication on its own. */
  async authenticate(): Promise<boolean> {
    await this.accessToken();
    return true;
  }

  /**
   * `body` goes on the wire; `recorded` is what may be remembered (never contains payment_source).
   */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; recorded?: unknown; requestId?: string } = {},
  ): Promise<{ status: number; json: any; call: CallRecord }> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (method === 'POST') headers.Prefer = 'return=representation';
    if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
    const call: CallRecord = { method, path, request_id: opts.requestId ?? null, body: sanitizeFinancialEvidence(opts.recorded ?? opts.body ?? null) };
    const r = await this.http(`${this.base}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }, 'paypal');
    const text = await r.text();
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { malformed_body: true };
      }
    }
    return { status: r.status, json, call };
  }

  private toRes<T>(r: { status: number; json: any; call: CallRecord }, map: (j: any) => T): Res<T> {
    const raw = sanitizeFinancialEvidence(r.json);
    if (r.status >= 200 && r.status < 300) {
      try {
        return { ok: true, status: r.status, data: map(r.json), replayed: false, call: r.call, raw };
      } catch (e) {
        const detail = e instanceof MalformedResponseError ? e.detail : 'unexpected response shape';
        const error: ApiError = { name: 'MALFORMED_RESPONSE', message: `PayPal returned HTTP ${r.status} but the body failed validation (${detail})`, issue: 'MALFORMED_RESPONSE' };
        return { ok: false, status: r.status, error, replayed: false, call: r.call, raw };
      }
    }
    const error: ApiError = {
      name: typeof r.json?.name === 'string' ? r.json.name : `HTTP_${r.status}`,
      message: typeof r.json?.message === 'string' ? r.json.message : 'PayPal request failed',
      issue: typeof r.json?.details?.[0]?.issue === 'string' ? r.json.details[0].issue : null,
    };
    return { ok: false, status: r.status, error, replayed: false, call: r.call, raw };
  }

  private merchant(orderId?: string): string {
    return (orderId && this.payeeByOrder.get(orderId)) || this.cfg.merchantId || 'SANDBOX-APP-MERCHANT';
  }

  private mapOrder = (j: any): OrderInfo => {
    const o = validated(OrderShape, j);
    const pu = o.purchase_units?.[0];
    const payee = pu?.payee?.merchant_id;
    if (payee) this.payeeByOrder.set(o.id, payee);
    return { id: o.id, status: o.status, payee_merchant_id: payee ?? this.merchant(o.id), amount: pu?.amount ?? { currency_code: '', value: '' } };
  };

  private mapCapture = (j: any, orderId?: string): CaptureInfo => {
    const nested = j?.purchase_units?.[0]?.payments?.captures?.[0];
    const c = validated(CaptureShape, nested ?? j); // order capture response, or capture resource
    return { id: c.id, status: c.status, amount: c.amount, payee_merchant_id: this.merchant(orderId ?? j?.id), update_time: c.update_time ?? c.create_time ?? '' };
  };

  async createOrder(a: { requestId: string; intent: 'CAPTURE' | 'AUTHORIZE'; amount: Money; referenceId: string }): Promise<Res<OrderInfo>> {
    const r = await this.call('POST', '/v2/checkout/orders', {
      requestId: a.requestId,
      body: { intent: a.intent, purchase_units: [{ reference_id: a.referenceId, amount: a.amount }] },
    });
    return this.toRes(r, this.mapOrder);
  }

  async confirmPaymentSource(orderId: string, requestId: string): Promise<Res<OrderInfo>> {
    const card = this.cfg.card;
    if (!this.cfg.allowDirectCard || !card?.number) throw new Error(NO_DIRECT_CARD);
    const r = await this.call('POST', `/v2/checkout/orders/${orderId}/confirm-payment-source`, {
      requestId,
      // The wire body carries the sandbox test card; what is remembered is only a marker with no card data.
      body: { payment_source: { card: { number: card.number, expiry: card.expiry, name: card.name } } },
      recorded: { payment_source_type: 'card (details withheld)' },
    });
    return this.toRes(r, this.mapOrder);
  }

  async captureOrder(orderId: string, requestId: string): Promise<Res<CaptureInfo>> {
    const r = await this.call('POST', `/v2/checkout/orders/${orderId}/capture`, { requestId, body: {} });
    return this.toRes(r, (j) => this.mapCapture(j, orderId));
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<Res<AuthorizationInfo>> {
    const r = await this.call('POST', `/v2/checkout/orders/${orderId}/authorize`, { requestId, body: {} });
    return this.toRes(r, (j) => {
      const o = validated(OrderShape, j);
      const a = o.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!a) throw new MalformedResponseError('purchase_units.0.payments.authorizations.0: missing');
      return { id: a.id, status: a.status, amount: a.amount };
    });
  }

  async captureAuthorization(authId: string, requestId: string, amount: Money): Promise<Res<CaptureInfo>> {
    const r = await this.call('POST', `/v2/payments/authorizations/${authId}/capture`, { requestId, body: { amount, final_capture: true } });
    return this.toRes(r, (j) => this.mapCapture(j));
  }

  async voidAuthorization(authId: string, requestId: string): Promise<Res<{ id: string; status: string }>> {
    const r = await this.call('POST', `/v2/payments/authorizations/${authId}/void`, { requestId, body: {} });
    return this.toRes(r, () => ({ id: authId, status: 'VOIDED' })); // 204 No Content on success
  }

  async refundCapture(captureId: string, a: { requestId: string; amount: Money; noteToPayer: string }): Promise<Res<RefundInfo>> {
    const r = await this.call('POST', `/v2/payments/captures/${captureId}/refund`, {
      requestId: a.requestId,
      body: { amount: a.amount, note_to_payer: a.noteToPayer },
    });
    return this.toRes(r, (j) => {
      const x = validated(RefundShape, j);
      return {
        id: x.id,
        status: x.status,
        amount: x.amount ?? a.amount,
        // The refund resource documents no payee field; attribute to the merchant whose credentials issued it.
        payee_merchant_id: this.merchant(),
        capture_id: captureId,
      };
    });
  }

  async getOrder(orderId: string): Promise<Res<OrderInfo>> {
    return this.toRes(await this.call('GET', `/v2/checkout/orders/${orderId}`), this.mapOrder);
  }

  async getCapture(captureId: string): Promise<Res<CaptureInfo>> {
    return this.toRes(await this.call('GET', `/v2/payments/captures/${captureId}`), (j) => this.mapCapture(j));
  }

  /** POST /v1/notifications/verify-webhook-signature — the only accepted verification path. */
  async verifyWebhookSignature(headers: Record<string, string | undefined>, event: unknown): Promise<boolean> {
    if (!this.cfg.webhookId) return false;
    const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
    const r = await this.call('POST', '/v1/notifications/verify-webhook-signature', {
      body: {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: this.cfg.webhookId,
        webhook_event: event,
      },
      recorded: { webhook_id: this.cfg.webhookId, transmission_id: h('paypal-transmission-id') ?? null },
    });
    return r.status === 200 && r.json?.verification_status === 'SUCCESS';
  }
}
