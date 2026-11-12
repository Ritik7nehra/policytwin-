import { afterAll, describe, expect, it } from 'vitest';
import { PayPalSandboxAdapter } from '@/lib/paypal/live';
import { writeEvidence } from '../evidence';

/**
 * Opt-in tests against the REAL PayPal Sandbox (test money). They are skipped — and write NO evidence — unless
 *   PAYPAL_LIVE_TESTS=1, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set.
 *     PAYPAL_LIVE_TESTS=1 npm run test:integration
 * The create → confirm → capture → refund test additionally needs PAYPAL_SANDBOX_CARD_NUMBER and a sandbox business
 * account with Advanced Credit and Debit Card Payments enabled. It uses the direct-card path, which PayPal says requires
 * PCI SAQ D compliance in production — acceptable for Sandbox test cards only, and therefore an explicit opt-in here.
 * The evidence file (evidence/paypal-sandbox-<timestamp>.json) lists resource ids, request ids, HTTP statuses and issue codes.
 */
const enabled = process.env.PAYPAL_LIVE_TESTS === '1' && !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;
const hasCard = !!process.env.PAYPAL_SANDBOX_CARD_NUMBER;
const hasWebhook = !!process.env.PAYPAL_WEBHOOK_ID;

const adapter = () =>
  new PayPalSandboxAdapter({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
    baseUrl: process.env.PAYPAL_BASE_URL || undefined,
    merchantId: process.env.PAYPAL_MERCHANT_ID || undefined,
    webhookId: process.env.PAYPAL_WEBHOOK_ID || undefined,
    allowDirectCard: hasCard,
    card: hasCard ? { number: process.env.PAYPAL_SANDBOX_CARD_NUMBER!, expiry: process.env.PAYPAL_SANDBOX_CARD_EXPIRY || '2029-12', name: 'Test Buyer' } : undefined,
  });

const evidence: Record<string, unknown> = { sandbox_only: true, checks: {} };
const note = (name: string, v: unknown) => ((evidence.checks as Record<string, unknown>)[name] = v);

afterAll(() => {
  if (!enabled) return;
  evidence.environment = { base_url_host: new URL(process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').host, direct_card_path: hasCard, webhook_id_configured: hasWebhook };
  // eslint-disable-next-line no-console
  console.log(`PayPal Sandbox evidence written to ${writeEvidence('paypal-sandbox', evidence)}`);
});

describe.skipIf(!enabled)('PayPal Sandbox (live, opt-in)', () => {
  it('authenticates with OAuth', async () => {
    expect(await adapter().authenticate()).toBe(true);
    note('oauth', { ok: true });
  });

  it('creates an order with an idempotency key; the same PayPal-Request-Id returns the same order', async () => {
    const pp = adapter();
    const rid = `pt-live-${Date.now()}-create-order`;
    const a = await pp.createOrder({ requestId: rid, intent: 'CAPTURE', amount: { currency_code: 'USD', value: '1.00' }, referenceId: 'pt-live' });
    expect(a.ok).toBe(true);
    const b = await pp.createOrder({ requestId: rid, intent: 'CAPTURE', amount: { currency_code: 'USD', value: '1.00' }, referenceId: 'pt-live' });
    expect(b.ok && a.ok && b.data.id === a.data.id).toBe(true);
    note('create_order_idempotency', { request_id: rid, first_order_id: a.ok ? a.data.id : null, second_order_id: b.ok ? b.data.id : null, same_order: a.ok && b.ok && a.data.id === b.data.id, http_status: [a.status, b.status] });
  });

  it('rejects a bogus webhook signature (PayPal verify-webhook-signature answers FAILURE)', async () => {
    if (!hasWebhook) return note('webhook_signature_negative', { skipped: 'PAYPAL_WEBHOOK_ID not set' });
    const ok = await adapter().verifyWebhookSignature(
      { 'paypal-transmission-id': 'bogus', 'paypal-transmission-time': new Date().toISOString(), 'paypal-transmission-sig': 'bogus', 'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-bogus', 'paypal-auth-algo': 'SHA256withRSA' },
      { id: 'WH-bogus', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'x' } },
    );
    expect(ok).toBe(false);
    note('webhook_signature_negative', { verified: ok });
  });

  it.skipIf(!hasCard)('create → confirm → capture → refund; the same refund Request-Id never refunds twice; a refund beyond the balance is rejected', async () => {
    const pp = adapter();
    const k = `pt-live-${Date.now()}`;
    const money = (v: string) => ({ currency_code: 'USD', value: v });
    const o = await pp.createOrder({ requestId: `${k}-create`, intent: 'CAPTURE', amount: money('2.00'), referenceId: k });
    if (!o.ok) throw new Error(`create failed: HTTP ${o.status} ${o.error.issue ?? o.error.name}`);
    const conf = await pp.confirmPaymentSource(o.data.id, `${k}-confirm`);
    expect(conf.ok).toBe(true);
    const cap = await pp.captureOrder(o.data.id, `${k}-capture`);
    if (!cap.ok) throw new Error(`capture failed: HTTP ${cap.status} ${cap.error.issue ?? cap.error.name}`);

    const refund = (id: string) => pp.refundCapture(cap.data.id, { requestId: `${k}-${id}`, amount: money('1.00'), noteToPayer: 'PolicyTwin live test' });
    const r1 = await refund('refund-1');
    const r1again = await refund('refund-1'); // same PayPal-Request-Id → PayPal must replay, not refund again
    expect(r1.ok && r1again.ok && r1.data.id === r1again.data.id).toBe(true);
    const mid = await pp.getCapture(cap.data.id);
    expect(mid.ok && mid.data.status).toBe('PARTIALLY_REFUNDED'); // one refund of 1.00, not two

    const r2 = await refund('refund-2'); // a NEW request id is a new refund
    expect(r2.ok && r1.ok && r2.data.id !== r1.data.id).toBe(true);
    const r3 = await refund('refund-3'); // nothing left to refund
    expect(r3.ok).toBe(false);
    expect(!r3.ok && r3.error.issue).toBe('CAPTURE_FULLY_REFUNDED');
    const end = await pp.getCapture(cap.data.id);

    note('order_flow', {
      order_id: o.data.id,
      confirm_http_status: conf.status,
      capture_id: cap.data.id,
      capture_http_status: cap.status,
      refund_1: { request_id: `${k}-refund-1`, refund_id: r1.ok ? r1.data.id : null, http_status: r1.status },
      refund_1_repeated_same_request_id: { request_id: `${k}-refund-1`, refund_id: r1again.ok ? r1again.data.id : null, http_status: r1again.status, same_refund_id: r1.ok && r1again.ok && r1.data.id === r1again.data.id },
      capture_status_after_repeat: mid.ok ? mid.data.status : null,
      refund_2_new_request_id: { request_id: `${k}-refund-2`, refund_id: r2.ok ? r2.data.id : null, http_status: r2.status },
      refund_3_beyond_balance: { request_id: `${k}-refund-3`, http_status: r3.status, issue_code: !r3.ok ? r3.error.issue : null },
      capture_status_final: end.ok ? end.data.status : null,
    });
  }, 90_000);
});
