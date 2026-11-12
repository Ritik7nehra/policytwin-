import { describe, expect, it } from 'vitest';
import { INVARIANTS, checkInvariants } from '@/lib/analysis/invariants';
import type { ExecutionTrace, RefundRecord } from '@/lib/types';

const refund = (id: string, over: Partial<RefundRecord> = {}): RefundRecord => ({
  id,
  amount_cents: 2000,
  currency: 'USD',
  payee_merchant_id: 'M1',
  logical_request_id: 'run-scenario_01-refund',
  request_id: 'run-scenario_01-refund',
  ...over,
});

const trace = (over: Partial<ExecutionTrace> = {}): ExecutionTrace => ({
  scenario_id: 'scn_1',
  decision: 'AUTO_REFUND',
  capture: { id: 'CAP1', amount_cents: 4000, currency: 'USD', payee_merchant_id: 'M1', status: 'PARTIALLY_REFUNDED' },
  authorization: null,
  capture_attempts_after_void: [],
  refunds: [],
  refund_attempts: [],
  webhook_deliveries: [],
  state_history: [],
  canonical_capture_status: null,
  dispute_open: false,
  ...over,
});

const byCode = (t: ExecutionTrace) => Object.fromEntries(checkInvariants(t).map((r) => [r.code, r]));

describe('financial invariants (deterministic, trace-only)', () => {
  it('defines the seven spec invariants plus the open-dispute invariant', () => {
    expect(INVARIANTS.map((i) => i.code)).toEqual([
      'REFUND_TOTAL_LTE_CAPTURE',
      'ONE_REFUND_PER_LOGICAL_REQUEST',
      'REFUND_CURRENCY_MATCHES_CAPTURE',
      'REFUND_PAYEE_MATCHES_ORIGINAL',
      'VOIDED_AUTH_NOT_CAPTURED',
      'DUPLICATE_WEBHOOK_NO_DUPLICATE_OPERATION',
      'OLDER_WEBHOOK_NO_STATE_REGRESSION',
      'NO_AUTO_REFUND_WITH_OPEN_DISPUTE',
    ]);
  });

  it('a clean trace passes everything that applies', () => {
    const r = checkInvariants(trace({ refunds: [refund('R1')], refund_attempts: [{ logical_request_id: 'x', request_id: 'x', http_status: 201, ok: true, replayed: false, refund_id: 'R1', error_issue: null }] }));
    expect(r.filter((x) => x.applicable && !x.passed)).toEqual([]);
  });

  it('REFUND_TOTAL_LTE_CAPTURE fails when refunds exceed the capture', () => {
    const r = byCode(trace({ refunds: [refund('R1', { amount_cents: 3000, logical_request_id: 'a' }), refund('R2', { amount_cents: 3000, logical_request_id: 'b' })] }));
    expect(r.REFUND_TOTAL_LTE_CAPTURE.passed).toBe(false);
    expect(r.REFUND_TOTAL_LTE_CAPTURE.detail).toMatch(/6000/);
  });

  it('REFUND_TOTAL_LTE_CAPTURE passes at exactly the captured amount', () => {
    const r = byCode(trace({ refunds: [refund('R1', { amount_cents: 4000 })] }));
    expect(r.REFUND_TOTAL_LTE_CAPTURE.passed).toBe(true);
  });

  it('ONE_REFUND_PER_LOGICAL_REQUEST fails when one logical request yields two refunds', () => {
    const attempt = (n: number) => ({ logical_request_id: 'L', request_id: `L-${n}`, http_status: 201, ok: true, replayed: false, refund_id: `R${n}`, error_issue: null });
    const r = byCode(trace({ refunds: [refund('R1', { logical_request_id: 'L' }), refund('R2', { logical_request_id: 'L' })], refund_attempts: [attempt(1), attempt(2)] }));
    expect(r.ONE_REFUND_PER_LOGICAL_REQUEST.passed).toBe(false);
    expect(r.ONE_REFUND_PER_LOGICAL_REQUEST.detail).toMatch(/2 successful refunds/);
  });

  it('ONE_REFUND_PER_LOGICAL_REQUEST passes when the retry was replayed (same refund id)', () => {
    const r = byCode(trace({ refunds: [refund('R1', { logical_request_id: 'L' })], refund_attempts: [
      { logical_request_id: 'L', request_id: 'L', http_status: 201, ok: true, replayed: false, refund_id: 'R1', error_issue: null },
      { logical_request_id: 'L', request_id: 'L', http_status: 201, ok: true, replayed: true, refund_id: 'R1', error_issue: null },
    ] }));
    expect(r.ONE_REFUND_PER_LOGICAL_REQUEST.passed).toBe(true);
  });

  it('REFUND_CURRENCY_MATCHES_CAPTURE and REFUND_PAYEE_MATCHES_ORIGINAL catch mismatches', () => {
    const r = byCode(trace({ refunds: [refund('R1', { currency: 'EUR', payee_merchant_id: 'OTHER' })] }));
    expect(r.REFUND_CURRENCY_MATCHES_CAPTURE.passed).toBe(false);
    expect(r.REFUND_PAYEE_MATCHES_ORIGINAL.passed).toBe(false);
  });

  it('VOIDED_AUTH_NOT_CAPTURED fails only if a capture after the void succeeded', () => {
    const voided = { id: 'A1', voided: true };
    expect(byCode(trace({ authorization: voided, capture_attempts_after_void: [{ request_id: 'r', succeeded: false }] })).VOIDED_AUTH_NOT_CAPTURED.passed).toBe(true);
    expect(byCode(trace({ authorization: voided, capture_attempts_after_void: [{ request_id: 'r', succeeded: true }] })).VOIDED_AUTH_NOT_CAPTURED.passed).toBe(false);
    expect(byCode(trace()).VOIDED_AUTH_NOT_CAPTURED.applicable).toBe(false);
  });

  it('DUPLICATE_WEBHOOK_NO_DUPLICATE_OPERATION fails when a duplicate delivery triggered a second operation', () => {
    const d = (n: number, invoked: boolean) => ({ event_id: 'WH-1', event_type: 'X', delivery_no: n, triggers_operation: true, handler_invoked_operation: invoked, ignored_as_duplicate: !invoked });
    expect(byCode(trace({ webhook_deliveries: [d(1, true), d(2, true)] })).DUPLICATE_WEBHOOK_NO_DUPLICATE_OPERATION.passed).toBe(false);
    expect(byCode(trace({ webhook_deliveries: [d(1, true), d(2, false)] })).DUPLICATE_WEBHOOK_NO_DUPLICATE_OPERATION.passed).toBe(true);
    expect(byCode(trace({ webhook_deliveries: [d(1, true)] })).DUPLICATE_WEBHOOK_NO_DUPLICATE_OPERATION.applicable).toBe(false);
  });

  it('OLDER_WEBHOOK_NO_STATE_REGRESSION fails when local state moves backwards', () => {
    const h = (event_id: string, state: 'COMPLETED' | 'REFUNDED', rank: number) => ({ event_id, state, rank });
    expect(byCode(trace({ state_history: [h('e1', 'COMPLETED', 1), h('e2', 'REFUNDED', 3)] })).OLDER_WEBHOOK_NO_STATE_REGRESSION.passed).toBe(true);
    const bad = byCode(trace({ state_history: [h('e2', 'REFUNDED', 3), h('e1', 'COMPLETED', 1)] })).OLDER_WEBHOOK_NO_STATE_REGRESSION;
    expect(bad.passed).toBe(false);
    expect(bad.detail).toMatch(/moved backwards/);
  });

  it('NO_AUTO_REFUND_WITH_OPEN_DISPUTE fails when a refund was issued during a dispute', () => {
    expect(byCode(trace({ dispute_open: true, refunds: [refund('R1')] })).NO_AUTO_REFUND_WITH_OPEN_DISPUTE.passed).toBe(false);
    expect(byCode(trace({ dispute_open: true })).NO_AUTO_REFUND_WITH_OPEN_DISPUTE.passed).toBe(true);
    expect(byCode(trace()).NO_AUTO_REFUND_WITH_OPEN_DISPUTE.applicable).toBe(false);
  });

  it('every result is tagged critical and carries the scenario id', () => {
    for (const r of checkInvariants(trace())) {
      expect(r.severity).toBe('critical');
      expect(r.scenario_id).toBe('scn_1');
    }
  });
});
