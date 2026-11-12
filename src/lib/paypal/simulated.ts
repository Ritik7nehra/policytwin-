import { fromCents, toCents } from '../money';
import type {
  ApiError,
  AuthorizationInfo,
  CallRecord,
  CaptureInfo,
  Money,
  OrderInfo,
  PayPalAdapter,
  RefundInfo,
  Res,
} from './types';

interface SimOrder {
  id: string;
  intent: 'CAPTURE' | 'AUTHORIZE';
  status: 'CREATED' | 'APPROVED' | 'COMPLETED';
  amount: Money;
  payee: string;
  captureId?: string;
  authorizationId?: string;
}
interface SimCapture {
  id: string;
  orderId: string;
  amount: Money;
  status: 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
  refundedCents: number;
  update_time: string;
  authorizationId?: string;
}
interface SimAuth {
  id: string;
  orderId: string;
  amount: Money;
  status: 'CREATED' | 'VOIDED' | 'CAPTURED';
}

/**
 * In-process stand-in for the PayPal Sandbox. It reproduces the behaviours PolicyTwin
 * depends on:
 *  - PayPal-Request-Id idempotency (same id + same endpoint → the original response is replayed)
 *  - refund ceilings (a fully refunded capture cannot be refunded again)
 *  - a voided authorization cannot be captured
 *  - monotonic update_time on resources
 * Error issue codes mirror PayPal's documented names where known (e.g. CAPTURE_FULLY_REFUNDED);
 * the remaining ones are approximations and are labelled "SIM_" in the issue name field.
 * This is NOT PayPal, and results from it must never be presented as Sandbox results.
 */
export class SimulatedPayPal implements PayPalAdapter {
  readonly mode = 'simulated' as const;
  readonly label = 'Simulated PayPal Sandbox (in-process — not PayPal)';
  private seq = 0;
  private tick = 0;
  private orders = new Map<string, SimOrder>();
  private captures = new Map<string, SimCapture>();
  private auths = new Map<string, SimAuth>();
  private refunds = new Map<string, RefundInfo>();
  private idem = new Map<string, Res<any>>();

  constructor(private readonly merchantId = 'SIM-MERCHANT-0001') {}

  private time(): string {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + ++this.tick * 1000).toISOString();
  }
  private id(prefix: string): string {
    return `${prefix}-SIM-${String(++this.seq).padStart(5, '0')}`;
  }

  private ok<T>(status: number, data: T, call: CallRecord, raw?: unknown): Res<T> {
    return { ok: true, status, data, replayed: false, call, raw: raw ?? data };
  }
  private fail<T>(status: number, name: string, issue: string, message: string, call: CallRecord): Res<T> {
    const error: ApiError = { name, message, issue };
    return { ok: false, status, error, replayed: false, call, raw: { name, message, details: [{ issue, description: message }] } };
  }

  /** PayPal-Request-Id semantics: the same id on the same endpoint replays the first response. */
  private idempotent<T>(method: string, path: string, requestId: string | null, body: unknown, fn: (call: CallRecord) => Res<T>): Res<T> {
    const call: CallRecord = { method, path, request_id: requestId, body };
    if (!requestId) return fn(call);
    const key = `${method} ${path}|${requestId}`;
    const prev = this.idem.get(key);
    if (prev) return { ...prev, replayed: true, call };
    const out = fn(call);
    this.idem.set(key, out);
    return out;
  }

  private orderInfo(o: SimOrder): OrderInfo {
    return { id: o.id, status: o.status, payee_merchant_id: o.payee, amount: o.amount };
  }
  private captureInfo(c: SimCapture): CaptureInfo {
    return { id: c.id, status: c.status, amount: c.amount, payee_merchant_id: this.merchantId, update_time: c.update_time };
  }

  async createOrder(a: { requestId: string; intent: 'CAPTURE' | 'AUTHORIZE'; amount: Money; referenceId: string }): Promise<Res<OrderInfo>> {
    return this.idempotent('POST', '/v2/checkout/orders', a.requestId, { intent: a.intent, purchase_units: [{ reference_id: a.referenceId, amount: a.amount }] }, (call) => {
      try {
        toCents(a.amount.value);
      } catch {
        return this.fail(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE', 'amount.value is not a valid money string', call);
      }
      const o: SimOrder = { id: this.id('ORD'), intent: a.intent, status: 'CREATED', amount: a.amount, payee: this.merchantId };
      this.orders.set(o.id, o);
      return this.ok(201, this.orderInfo(o), call);
    });
  }

  async confirmPaymentSource(orderId: string, requestId: string): Promise<Res<OrderInfo>> {
    return this.idempotent('POST', `/v2/checkout/orders/${orderId}/confirm-payment-source`, requestId, { payment_source: { card: '(simulated test card)' } }, (call) => {
      const o = this.orders.get(orderId);
      if (!o) return this.fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Order not found', call);
      if (o.status !== 'CREATED') return this.fail(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_PROCESSED', 'Order cannot be confirmed in its current state', call);
      o.status = 'APPROVED';
      return this.ok(200, this.orderInfo(o), call);
    });
  }

  async captureOrder(orderId: string, requestId: string): Promise<Res<CaptureInfo>> {
    return this.idempotent('POST', `/v2/checkout/orders/${orderId}/capture`, requestId, {}, (call) => {
      const o = this.orders.get(orderId);
      if (!o) return this.fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Order not found', call);
      if (o.status === 'COMPLETED') return this.fail(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED', 'Order already captured', call);
      if (o.status !== 'APPROVED' || o.intent !== 'CAPTURE') return this.fail(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', 'Payer has not approved this CAPTURE order', call);
      const c: SimCapture = { id: this.id('CAP'), orderId, amount: o.amount, status: 'COMPLETED', refundedCents: 0, update_time: this.time() };
      this.captures.set(c.id, c);
      o.status = 'COMPLETED';
      o.captureId = c.id;
      return this.ok(201, this.captureInfo(c), call);
    });
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<Res<AuthorizationInfo>> {
    return this.idempotent('POST', `/v2/checkout/orders/${orderId}/authorize`, requestId, {}, (call) => {
      const o = this.orders.get(orderId);
      if (!o) return this.fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Order not found', call);
      if (o.status !== 'APPROVED' || o.intent !== 'AUTHORIZE') return this.fail(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', 'Payer has not approved this AUTHORIZE order', call);
      const a: SimAuth = { id: this.id('AUTH'), orderId, amount: o.amount, status: 'CREATED' };
      this.auths.set(a.id, a);
      o.status = 'COMPLETED';
      o.authorizationId = a.id;
      return this.ok(201, { id: a.id, status: a.status, amount: a.amount }, call);
    });
  }

  async captureAuthorization(authId: string, requestId: string, amount: Money): Promise<Res<CaptureInfo>> {
    return this.idempotent('POST', `/v2/payments/authorizations/${authId}/capture`, requestId, { amount, final_capture: true }, (call) => {
      const a = this.auths.get(authId);
      if (!a) return this.fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Authorization not found', call);
      if (a.status === 'VOIDED') return this.fail(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_VOIDED', 'Authorization has been voided and cannot be captured', call);
      if (a.status === 'CAPTURED') return this.fail(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_ALREADY_CAPTURED', 'Authorization already captured', call);
      const c: SimCapture = { id: this.id('CAP'), orderId: a.orderId, amount, status: 'COMPLETED', refundedCents: 0, update_time: this.time(), authorizationId: authId };
      this.captures.set(c.id, c);
      a.status = 'CAPTURED';
      return this.ok(201, this.captureInfo(c), call);
    });
  }

  async voidAuthorization(authId: string, requestId: string): Promise<Res<{ id: string; status: string }>> {
    return this.idempotent('POST', `/v2/payments/authorizations/${authId}/void`, requestId, {}, (call) => {
      const a = this.auths.get(authId);
      if (!a) return this.fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Authorization not found', call);
      if (a.status === 'CAPTURED') return this.fail(422, 'UNPROCESSABLE_ENTITY', 'PREVIOUSLY_CAPTURED', 'Authorization was already captured', call);
      a.status = 'VOIDED';
      return this.ok(200, { id: a.id, status: 'VOIDED' }, call);
    });
  }

  async refundCapture(captureId: string, a: { requestId: string; amount: Money; noteToPayer: string }): Promise<Res<RefundInfo>> {
    return this.idempotent('POST', `/v2/payments/captures/${captureId}/refund`, a.requestId, { amount: a.amount, note_to_payer: a.noteToPayer }, (call) => {
      const c = this.captures.get(captureId);
      if (!c) return this.fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Capture not found', call);
      const capCents = toCents(c.amount.value);
      const remaining = capCents - c.refundedCents;
      if (remaining <= 0) return this.fail(422, 'UNPROCESSABLE_ENTITY', 'CAPTURE_FULLY_REFUNDED', 'The capture has already been fully refunded.', call);
      if (a.amount.currency_code !== c.amount.currency_code) return this.fail(422, 'UNPROCESSABLE_ENTITY', 'SIM_REFUND_CURRENCY_MISMATCH', 'Refund currency must match the capture currency', call);
      const reqCents = toCents(a.amount.value);
      if (reqCents <= 0 || reqCents > remaining) return this.fail(422, 'UNPROCESSABLE_ENTITY', 'SIM_REFUND_AMOUNT_EXCEEDED', 'Refund amount exceeds the remaining captured amount', call);
      c.refundedCents += reqCents;
      c.status = c.refundedCents === capCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      c.update_time = this.time();
      const r: RefundInfo = { id: this.id('REF'), status: 'COMPLETED', amount: a.amount, payee_merchant_id: this.merchantId, capture_id: captureId };
      this.refunds.set(r.id, r);
      return this.ok(201, r, call);
    });
  }

  async getOrder(orderId: string): Promise<Res<OrderInfo>> {
    const call: CallRecord = { method: 'GET', path: `/v2/checkout/orders/${orderId}`, request_id: null, body: null };
    const o = this.orders.get(orderId);
    return o ? this.ok(200, this.orderInfo(o), call) : this.fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Order not found', call);
  }

  async getCapture(captureId: string): Promise<Res<CaptureInfo>> {
    const call: CallRecord = { method: 'GET', path: `/v2/payments/captures/${captureId}`, request_id: null, body: null };
    const c = this.captures.get(captureId);
    return c ? this.ok(200, this.captureInfo(c), call) : this.fail(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Capture not found', call);
  }

  /** Simulated webhooks carry a marker header; the real adapter never accepts it. */
  async verifyWebhookSignature(headers: Record<string, string | undefined>): Promise<boolean> {
    return headers['x-policytwin-simulated'] === 'true';
  }

  // Test helper
  refundedCents(captureId: string): number {
    return this.captures.get(captureId)?.refundedCents ?? 0;
  }
  remaining(captureId: string): string {
    const c = this.captures.get(captureId);
    return c ? fromCents(toCents(c.amount.value) - c.refundedCents) : '0.00';
  }
}
