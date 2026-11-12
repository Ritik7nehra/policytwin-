/**
 * PayPal adapter contract. Two implementations exist:
 *   - SimulatedPayPal: in-process, deterministic, models idempotency and the documented
 *     error behaviours. It is NOT PayPal and is labelled as such everywhere.
 *   - PayPalSandboxAdapter: real REST calls, hard-locked to the Sandbox host.
 * Every method returns a normalized Res<T> plus the raw request/response for the audit trail.
 */
export interface Money {
  currency_code: string;
  value: string;
}

export interface CallRecord {
  method: string;
  path: string;
  request_id: string | null;
  body: unknown;
}

export interface ApiError {
  name: string;
  message: string;
  issue: string | null;
}

export type Res<T> =
  | { ok: true; status: number; data: T; replayed: boolean; call: CallRecord; raw: unknown }
  | { ok: false; status: number; error: ApiError; replayed: boolean; call: CallRecord; raw: unknown };

export interface OrderInfo {
  id: string;
  status: string;
  payee_merchant_id: string;
  amount: Money;
}

export interface CaptureInfo {
  id: string;
  status: string; // COMPLETED | PARTIALLY_REFUNDED | REFUNDED | PENDING …
  amount: Money;
  payee_merchant_id: string;
  update_time: string;
}

export interface AuthorizationInfo {
  id: string;
  status: string;
  amount: Money;
}

export interface RefundInfo {
  id: string;
  status: string;
  amount: Money;
  payee_merchant_id: string;
  capture_id: string;
}

export interface PayPalAdapter {
  readonly mode: 'simulated' | 'sandbox';
  readonly label: string;
  createOrder(a: { requestId: string; intent: 'CAPTURE' | 'AUTHORIZE'; amount: Money; referenceId: string }): Promise<Res<OrderInfo>>;
  confirmPaymentSource(orderId: string, requestId: string): Promise<Res<OrderInfo>>;
  captureOrder(orderId: string, requestId: string): Promise<Res<CaptureInfo>>;
  authorizeOrder(orderId: string, requestId: string): Promise<Res<AuthorizationInfo>>;
  captureAuthorization(authId: string, requestId: string, amount: Money): Promise<Res<CaptureInfo>>;
  voidAuthorization(authId: string, requestId: string): Promise<Res<{ id: string; status: string }>>;
  refundCapture(captureId: string, a: { requestId: string; amount: Money; noteToPayer: string }): Promise<Res<RefundInfo>>;
  getOrder(orderId: string): Promise<Res<OrderInfo>>;
  getCapture(captureId: string): Promise<Res<CaptureInfo>>;
  verifyWebhookSignature(headers: Record<string, string | undefined>, event: unknown): Promise<boolean>;
}
