import { describe, expect, it } from 'vitest';
import { InMemoryWebhookState, STATE_RANK, captureIdFromEvent, impliedState, processWebhookEvent, rankOf, type WebhookEvent } from '@/lib/paypal/webhooks';
import { SimulatedPayPal } from '@/lib/paypal/simulated';

const ev = (id: string, type: string, resource: Partial<WebhookEvent['resource']> & { id: string }, t = '2026-01-01T00:00:00Z'): WebhookEvent => ({ id, event_type: type, create_time: t, resource });

async function capturedOrder(amount = '40.00') {
  const pp = new SimulatedPayPal();
  const o = await pp.createOrder({ requestId: 'o', intent: 'CAPTURE', amount: { currency_code: 'USD', value: amount }, referenceId: 'r' });
  if (!o.ok) throw new Error('order');
  await pp.confirmPaymentSource(o.data.id, 'c');
  const cap = await pp.captureOrder(o.data.id, 'cap');
  if (!cap.ok) throw new Error('capture');
  return { pp, captureId: cap.data.id };
}

describe('capture state ordering', () => {
  it('ranks states monotonically', () => {
    expect(STATE_RANK.PENDING).toBeLessThan(STATE_RANK.COMPLETED);
    expect(STATE_RANK.COMPLETED).toBeLessThan(STATE_RANK.PARTIALLY_REFUNDED);
    expect(STATE_RANK.PARTIALLY_REFUNDED).toBeLessThan(STATE_RANK.REFUNDED);
    expect(rankOf('nonsense')).toBe(-1);
    expect(rankOf(null)).toBe(-1);
  });

  it('extracts the capture id (REFUNDED events point at the capture via the "up" link)', () => {
    expect(captureIdFromEvent(ev('e', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP1' }))).toBe('CAP1');
    expect(captureIdFromEvent(ev('e', 'PAYMENT.CAPTURE.REFUNDED', { id: 'REF1', links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/CAP9' }] }))).toBe('CAP9');
    expect(captureIdFromEvent(ev('e', 'CHECKOUT.ORDER.APPROVED', { id: 'O1' }))).toBeNull();
    expect(impliedState(ev('e', 'PAYMENT.CAPTURE.REFUNDED', { id: 'x' }))).toBe('REFUNDED');
  });
});

describe('webhook processing — recommended flow (canonical_dedupe)', () => {
  it('stores an event once and ignores the duplicate delivery', async () => {
    const { pp, captureId } = await capturedOrder();
    const state = new InMemoryWebhookState();
    const e = ev('WH-1', 'PAYMENT.CAPTURE.COMPLETED', { id: captureId });
    const first = await processWebhookEvent({ state, adapter: pp, mode: 'canonical_dedupe' }, e);
    const second = await processWebhookEvent({ state, adapter: pp, mode: 'canonical_dedupe' }, e);
    expect(first.ignored_duplicate).toBe(false);
    expect(first.applied).toBe(true);
    expect(first.canonical_fetched).toBe(true);
    expect(second.ignored_duplicate).toBe(true);
    expect(second.applied).toBe(false);
  });

  it('fetches the canonical resource instead of trusting a stale payload', async () => {
    const { pp, captureId } = await capturedOrder();
    await pp.refundCapture(captureId, { requestId: 'rf', amount: { currency_code: 'USD', value: '40.00' }, noteToPayer: 'x' });
    const state = new InMemoryWebhookState();
    // A late-arriving COMPLETED event must not drag local state back from the canonical REFUNDED.
    const r = await processWebhookEvent({ state, adapter: pp, mode: 'canonical_dedupe' }, ev('WH-old', 'PAYMENT.CAPTURE.COMPLETED', { id: captureId }));
    expect(r.state_after).toBe('REFUNDED');
  });

  it('never moves local state backwards', async () => {
    const { pp, captureId } = await capturedOrder();
    const state = new InMemoryWebhookState();
    await state.setResource(captureId, { status: 'REFUNDED', as_of: '2999-01-01T00:00:00.000Z' });
    const r = await processWebhookEvent({ state, adapter: pp, mode: 'canonical_dedupe' }, ev('WH-x', 'PAYMENT.CAPTURE.COMPLETED', { id: captureId }));
    expect(r.applied).toBe(false);
    expect((await state.getResource(captureId))?.status).toBe('REFUNDED');
  });

  it('stores events that are not about a capture without touching state', async () => {
    const { pp } = await capturedOrder();
    const state = new InMemoryWebhookState();
    const r = await processWebhookEvent({ state, adapter: pp, mode: 'canonical_dedupe' }, ev('WH-o', 'CHECKOUT.ORDER.APPROVED', { id: 'ORD-1' }));
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/not about a capture/);
  });

  it('reports a failed canonical fetch and leaves local state alone', async () => {
    const { pp } = await capturedOrder();
    const state = new InMemoryWebhookState();
    const r = await processWebhookEvent({ state, adapter: pp, mode: 'canonical_dedupe' }, ev('WH-m', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-DOES-NOT-EXIST' }));
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/canonical fetch failed/);
  });
});

describe('webhook processing — naive handler (what an unspecified policy yields)', () => {
  it('overwrites newer state with an older event: the regression PolicyTwin must catch', async () => {
    const { pp, captureId } = await capturedOrder();
    const state = new InMemoryWebhookState();
    await processWebhookEvent({ state, adapter: pp, mode: 'naive_last_write_wins' }, ev('WH-2', 'PAYMENT.CAPTURE.REFUNDED', { id: 'R', links: [{ rel: 'up', href: `https://x/v2/payments/captures/${captureId}` }] }));
    expect((await state.getResource(captureId))?.status).toBe('REFUNDED');
    await processWebhookEvent({ state, adapter: pp, mode: 'naive_last_write_wins' }, ev('WH-1', 'PAYMENT.CAPTURE.COMPLETED', { id: captureId }));
    expect((await state.getResource(captureId))?.status).toBe('COMPLETED'); // moved backwards
  });
});
