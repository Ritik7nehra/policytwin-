import { describe, expect, it } from 'vitest';
import { PayPalSandboxAdapter, assertSandboxBaseUrl } from '@/lib/paypal/live';

/**
 * The live adapter is exercised against an injected fake `fetch` so the contract
 * (hosts, paths, headers, bodies, error mapping) is verified without a network.
 * Real-Sandbox tests live in paypal-live.test.ts and are opt-in.
 */
interface Seen { url: string; method: string; headers: Record<string, string>; body: any }

function fakePayPal(routes: (s: Seen) => { status: number; json?: unknown } | undefined) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const s: Seen = { url, method: String(init.method ?? 'GET'), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body) : null };
    seen.push(s);
    const hit = s.url.endsWith('/v1/oauth2/token') ? { status: 200, json: { access_token: 'tok-1', expires_in: 3600 } } : routes(s);
    const out = hit ?? { status: 404, json: { name: 'RESOURCE_NOT_FOUND', message: 'nope' } };
    return { ok: out.status < 400, status: out.status, text: async () => (out.json === undefined ? '' : JSON.stringify(out.json)), json: async () => out.json } as Response;
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const mk = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  new PayPalSandboxAdapter({ clientId: 'cid', clientSecret: 'secret', fetchImpl, merchantId: 'MERCH-1', ...extra });

describe('sandbox host guard', () => {
  it('accepts the sandbox hosts only', () => {
    expect(assertSandboxBaseUrl('https://api-m.sandbox.paypal.com')).toBe('https://api-m.sandbox.paypal.com');
    expect(assertSandboxBaseUrl('https://api.sandbox.paypal.com/')).toBe('https://api.sandbox.paypal.com');
  });

  it('refuses production, look-alikes, plain http and garbage', () => {
    for (const bad of ['https://api-m.paypal.com', 'https://api.paypal.com', 'https://api-m.sandbox.paypal.com.evil.test', 'http://api-m.sandbox.paypal.com', 'https://evil.test/api-m.sandbox.paypal.com', 'not a url']) {
      expect(() => assertSandboxBaseUrl(bad), bad).toThrow();
    }
  });

  it('the adapter constructor enforces it', () => {
    expect(() => new PayPalSandboxAdapter({ clientId: 'a', clientSecret: 'b', baseUrl: 'https://api-m.paypal.com' })).toThrow(/Sandbox/);
  });
});

describe('PayPalSandboxAdapter (fake transport)', () => {
  it('authenticates with HTTP Basic client credentials and caches the token', async () => {
    const { seen, fetchImpl } = fakePayPal(() => ({ status: 200, json: { id: 'ORD-1', status: 'CREATED', purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' }, payee: { merchant_id: 'M-9' } }] } }));
    const pp = mk(fetchImpl);
    await pp.authenticate();
    await pp.getOrder('ORD-1');
    await pp.getOrder('ORD-1');
    const tokenCalls = seen.filter((s) => s.url.endsWith('/v1/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].headers.Authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);
    expect(tokenCalls[0].body).toBe('grant_type=client_credentials');
    expect(seen.find((s) => s.url.includes('/v2/checkout/orders/ORD-1'))!.headers.Authorization).toBe('Bearer tok-1');
  });

  it('fails loudly when OAuth is rejected', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, text: async () => '', json: async () => ({}) })) as unknown as typeof fetch;
    await expect(mk(fetchImpl).authenticate()).rejects.toThrow(/OAuth failed: HTTP 401/);
  });

  it('create order: sandbox host, PayPal-Request-Id and Prefer headers, intent and amount', async () => {
    const { seen, fetchImpl } = fakePayPal((s) => (s.url.endsWith('/v2/checkout/orders') ? { status: 201, json: { id: 'ORD-1', status: 'CREATED', purchase_units: [{ amount: { currency_code: 'USD', value: '40.00' }, payee: { merchant_id: 'M-9' } }] } } : undefined));
    const r = await mk(fetchImpl).createOrder({ requestId: 'run_204-scenario_06-create-order', intent: 'CAPTURE', amount: { currency_code: 'USD', value: '40.00' }, referenceId: 'ref' });
    expect(r.ok).toBe(true);
    const call = seen.find((s) => s.url.endsWith('/v2/checkout/orders'))!;
    expect(call.url.startsWith('https://api-m.sandbox.paypal.com/')).toBe(true);
    expect(call.method).toBe('POST');
    expect(call.headers['PayPal-Request-Id']).toBe('run_204-scenario_06-create-order');
    expect(call.headers.Prefer).toBe('return=representation');
    expect(call.body).toEqual({ intent: 'CAPTURE', purchase_units: [{ reference_id: 'ref', amount: { currency_code: 'USD', value: '40.00' } }] });
    if (r.ok) expect(r.data.payee_merchant_id).toBe('M-9');
  });

  it('refund: stable PayPal-Request-Id travels to the refund endpoint', async () => {
    const { seen, fetchImpl } = fakePayPal((s) => (s.url.endsWith('/v2/payments/captures/CAP-1/refund') ? { status: 201, json: { id: 'REF-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '20.00' } } } : undefined));
    const r = await mk(fetchImpl).refundCapture('CAP-1', { requestId: 'run_204-scenario_06-refund', amount: { currency_code: 'USD', value: '20.00' }, noteToPayer: 'n' });
    expect(r.ok && r.data.id).toBe('REF-1');
    const call = seen.find((s) => s.url.endsWith('/refund'))!;
    expect(call.headers['PayPal-Request-Id']).toBe('run_204-scenario_06-refund');
    expect(call.body).toEqual({ amount: { currency_code: 'USD', value: '20.00' }, note_to_payer: 'n' });
    if (r.ok) expect(r.data.payee_merchant_id).toBe('MERCH-1'); // configured merchant; see README limitation
  });

  it('maps a PayPal error body to a normalized error with the issue code', async () => {
    const { fetchImpl } = fakePayPal(() => ({ status: 422, json: { name: 'UNPROCESSABLE_ENTITY', message: 'x', details: [{ issue: 'CAPTURE_FULLY_REFUNDED' }] } }));
    const r = await mk(fetchImpl).refundCapture('CAP-1', { requestId: 'r', amount: { currency_code: 'USD', value: '1.00' }, noteToPayer: 'n' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.error.issue).toBe('CAPTURE_FULLY_REFUNDED');
    }
  });

  it('void succeeds on 204 No Content', async () => {
    const { fetchImpl } = fakePayPal((s) => (s.url.endsWith('/void') ? { status: 204 } : undefined));
    const r = await mk(fetchImpl).voidAuthorization('AUTH-1', 'rid');
    expect(r.ok && r.data.status).toBe('VOIDED');
  });

  it('GET calls carry no PayPal-Request-Id', async () => {
    const { seen, fetchImpl } = fakePayPal((s) => (s.url.includes('/captures/CAP-1') ? { status: 200, json: { id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '40.00' }, update_time: '2026-01-01T00:00:00Z' } } : undefined));
    await mk(fetchImpl).getCapture('CAP-1');
    expect(seen.find((s) => s.url.includes('/captures/CAP-1'))!.headers['PayPal-Request-Id']).toBeUndefined();
  });

  it('refuses to confirm a payment source when no sandbox card is configured (no hard-coded card data)', async () => {
    const { fetchImpl } = fakePayPal(() => undefined);
    await expect(mk(fetchImpl).confirmPaymentSource('ORD-1', 'rid')).rejects.toThrow(/PAYPAL_SANDBOX_CARD_NUMBER/);
  });

  it('refuses direct-card confirmation unless it is explicitly opted into, even when a card is configured', async () => {
    const { seen, fetchImpl } = fakePayPal(() => undefined);
    await expect(mk(fetchImpl, { card: { number: 'TEST-CARD-FROM-ENV', expiry: '2030-01', name: 'Test Buyer' } }).confirmPaymentSource('ORD-1', 'rid')).rejects.toThrow(/PCI SAQ D/);
    expect(seen.filter((s) => s.url.includes('confirm-payment-source'))).toHaveLength(0);
  });

  it('with the explicit opt-in the env card is sent on the wire — but never recorded, returned or kept in raw', async () => {
    const card = { number: '4111111111111111', expiry: '2030-01', name: 'Jane Q Buyer' };
    const echo = { id: 'ORD-1', status: 'APPROVED', purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }], payment_source: { card: { last_digits: '1111', brand: 'VISA', name: 'Jane Q Buyer' } }, payer: { email_address: 'jane@example.com', name: { given_name: 'Jane' } } };
    const { seen, fetchImpl } = fakePayPal((s) => (s.url.endsWith('/confirm-payment-source') ? { status: 200, json: echo } : undefined));
    const r = await mk(fetchImpl, { card, allowDirectCard: true }).confirmPaymentSource('ORD-1', 'rid');
    expect(seen.find((s) => s.url.endsWith('/confirm-payment-source'))!.body.payment_source.card.number).toBe(card.number); // wire only
    expect(r.ok).toBe(true);
    const remembered = JSON.stringify({ call: r.call, raw: r.raw });
    for (const secret of [card.number, card.expiry, card.name, 'jane@example.com', 'Jane', '1111', 'VISA']) expect(remembered).not.toContain(secret);
  });
});

describe('webhook signature verification (live adapter)', () => {
  const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-transmission-id': 'tid', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-01-01T00:00:00Z' };
  const event = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1' } };

  it('calls verify-webhook-signature with the transmission headers and webhook id', async () => {
    const { seen, fetchImpl } = fakePayPal((s) => (s.url.endsWith('/v1/notifications/verify-webhook-signature') ? { status: 200, json: { verification_status: 'SUCCESS' } } : undefined));
    expect(await mk(fetchImpl, { webhookId: 'WEBHOOK-ID' }).verifyWebhookSignature(headers, event)).toBe(true);
    const body = seen.find((s) => s.url.endsWith('/verify-webhook-signature'))!.body;
    expect(body).toMatchObject({ webhook_id: 'WEBHOOK-ID', transmission_id: 'tid', transmission_sig: 'sig', cert_url: headers['paypal-cert-url'], webhook_event: event });
  });

  it('rejects when PayPal says FAILURE, and when no webhook id is configured', async () => {
    const fail = fakePayPal((s) => (s.url.endsWith('/verify-webhook-signature') ? { status: 200, json: { verification_status: 'FAILURE' } } : undefined));
    expect(await mk(fail.fetchImpl, { webhookId: 'W' }).verifyWebhookSignature(headers, event)).toBe(false);
    const none = fakePayPal(() => undefined);
    expect(await mk(none.fetchImpl).verifyWebhookSignature(headers, event)).toBe(false);
    expect(none.seen).toHaveLength(0); // never even calls PayPal without a webhook id
  });
});
