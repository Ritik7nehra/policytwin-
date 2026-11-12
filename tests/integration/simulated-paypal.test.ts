import { beforeEach, describe, expect, it } from 'vitest';
import { SimulatedPayPal } from '@/lib/paypal/simulated';

const usd = (value: string) => ({ currency_code: 'USD', value });

async function capture(pp: SimulatedPayPal, amount = '40.00', prefix = 'a') {
  const o = await pp.createOrder({ requestId: `${prefix}-order`, intent: 'CAPTURE', amount: usd(amount), referenceId: 'ref' });
  if (!o.ok) throw new Error('order failed');
  const c = await pp.confirmPaymentSource(o.data.id, `${prefix}-confirm`);
  if (!c.ok) throw new Error('confirm failed');
  const cap = await pp.captureOrder(o.data.id, `${prefix}-capture`);
  if (!cap.ok) throw new Error('capture failed');
  return { orderId: o.data.id, captureId: cap.data.id };
}

describe('SimulatedPayPal — order → capture → refund', () => {
  let pp: SimulatedPayPal;
  beforeEach(() => {
    pp = new SimulatedPayPal();
  });

  it('is clearly labelled as not PayPal', () => {
    expect(pp.mode).toBe('simulated');
    expect(pp.label).toMatch(/not PayPal/i);
  });

  it('creates, confirms and captures an order', async () => {
    const { captureId } = await capture(pp);
    const got = await pp.getCapture(captureId);
    expect(got.ok && got.data.status).toBe('COMPLETED');
  });

  it('refuses to capture an order that was never approved', async () => {
    const o = await pp.createOrder({ requestId: 'x', intent: 'CAPTURE', amount: usd('10.00'), referenceId: 'r' });
    if (!o.ok) throw new Error();
    const cap = await pp.captureOrder(o.data.id, 'y');
    expect(cap.ok).toBe(false);
  });

  it('partial then full refund moves the capture through PARTIALLY_REFUNDED → REFUNDED', async () => {
    const { captureId } = await capture(pp);
    const r1 = await pp.refundCapture(captureId, { requestId: 'r1', amount: usd('15.00'), noteToPayer: 'n' });
    expect(r1.ok).toBe(true);
    expect((await pp.getCapture(captureId)) as any).toMatchObject({ data: { status: 'PARTIALLY_REFUNDED' } });
    const r2 = await pp.refundCapture(captureId, { requestId: 'r2', amount: usd('25.00'), noteToPayer: 'n' });
    expect(r2.ok).toBe(true);
    expect((await pp.getCapture(captureId)) as any).toMatchObject({ data: { status: 'REFUNDED' } });
  });

  it('rejects a second full refund with CAPTURE_FULLY_REFUNDED', async () => {
    const { captureId } = await capture(pp);
    await pp.refundCapture(captureId, { requestId: 'r1', amount: usd('40.00'), noteToPayer: 'n' });
    const again = await pp.refundCapture(captureId, { requestId: 'r2', amount: usd('40.00'), noteToPayer: 'n' });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.status).toBe(422);
      expect(again.error.issue).toBe('CAPTURE_FULLY_REFUNDED');
    }
  });

  it('rejects a refund larger than what remains and a currency mismatch', async () => {
    const { captureId } = await capture(pp);
    const big = await pp.refundCapture(captureId, { requestId: 'r1', amount: usd('40.01'), noteToPayer: 'n' });
    expect(big.ok).toBe(false);
    const eur = await pp.refundCapture(captureId, { requestId: 'r2', amount: { currency_code: 'EUR', value: '5.00' }, noteToPayer: 'n' });
    expect(eur.ok).toBe(false);
    expect(pp.refundedCents(captureId)).toBe(0);
  });
});

describe('SimulatedPayPal — PayPal-Request-Id idempotency', () => {
  it('replays the original response for a repeated request id and refunds only once', async () => {
    const pp = new SimulatedPayPal();
    const { captureId } = await capture(pp);
    const first = await pp.refundCapture(captureId, { requestId: 'run_204-scenario_06-refund', amount: usd('20.00'), noteToPayer: 'n' });
    const retry = await pp.refundCapture(captureId, { requestId: 'run_204-scenario_06-refund', amount: usd('20.00'), noteToPayer: 'n' });
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.replayed).toBe(true);
      expect(first.replayed).toBe(false);
      expect(retry.data.id).toBe(first.data.id);
    }
    expect(pp.refundedCents(captureId)).toBe(2000);
  });

  it('different request ids are different operations: both refunds happen', async () => {
    const pp = new SimulatedPayPal();
    const { captureId } = await capture(pp);
    const a = await pp.refundCapture(captureId, { requestId: 'one', amount: usd('20.00'), noteToPayer: 'n' });
    const b = await pp.refundCapture(captureId, { requestId: 'two', amount: usd('20.00'), noteToPayer: 'n' });
    expect(a.ok && b.ok).toBe(true);
    expect(pp.refundedCents(captureId)).toBe(4000);
  });

  it('create-order with the same request id returns the same order', async () => {
    const pp = new SimulatedPayPal();
    const a = await pp.createOrder({ requestId: 'same', intent: 'CAPTURE', amount: usd('5.00'), referenceId: 'r' });
    const b = await pp.createOrder({ requestId: 'same', intent: 'CAPTURE', amount: usd('5.00'), referenceId: 'r' });
    expect(a.ok && b.ok && a.data.id === b.data.id).toBe(true);
  });
});

describe('SimulatedPayPal — authorization void', () => {
  it('a voided authorization cannot be captured', async () => {
    const pp = new SimulatedPayPal();
    const o = await pp.createOrder({ requestId: 'o', intent: 'AUTHORIZE', amount: usd('40.00'), referenceId: 'r' });
    if (!o.ok) throw new Error();
    await pp.confirmPaymentSource(o.data.id, 'c');
    const auth = await pp.authorizeOrder(o.data.id, 'a');
    if (!auth.ok) throw new Error('authorize failed');
    expect((await pp.voidAuthorization(auth.data.id, 'v')).ok).toBe(true);
    const cap = await pp.captureAuthorization(auth.data.id, 'cap', usd('40.00'));
    expect(cap.ok).toBe(false);
    if (!cap.ok) expect(cap.error.issue).toBe('AUTHORIZATION_VOIDED');
  });
});

describe('SimulatedPayPal — webhook verification', () => {
  it('only accepts the explicit simulation marker', async () => {
    const pp = new SimulatedPayPal();
    expect(await pp.verifyWebhookSignature({ 'x-policytwin-simulated': 'true' })).toBe(true);
    expect(await pp.verifyWebhookSignature({})).toBe(false);
    expect(await pp.verifyWebhookSignature({ 'paypal-transmission-sig': 'abc' })).toBe(false);
  });
});
