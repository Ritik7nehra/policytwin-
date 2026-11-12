import type { Policy } from '../policy/schema';
import type { CaptureState, ExecutionRecord, ExecutionTrace, PolicyDecision, TxInput } from '../types';
import type { PayPalAdapter, Res } from '../paypal/types';
import { InMemoryWebhookState, processWebhookEvent, rankOf, type WebhookEvent, type WebhookMode } from '../paypal/webhooks';
import { shortId } from '../util';
import { toCents } from '../money';
import { safeCallEvidence, safeResponseEvidence, sanitizeFinancialEvidence } from '../security/sanitize';

export interface ExecuteArgs {
  runId: string;
  scenarioId: string;
  /** e.g. "scenario_06" — used in PayPal-Request-Id so the same scenario always reuses the same id. */
  scenarioKey: string;
  policyLabel: string; // A | B | C
  policy: Policy;
  decision: PolicyDecision;
  tx: TxInput;
  adapter: PayPalAdapter;
  /** shadow = full deterministic run on the simulator (default); sandbox_proof = selected pair on the real PayPal Sandbox. */
  lane?: 'shadow' | 'sandbox_proof';
}

export interface ExecuteResult {
  records: ExecutionRecord[];
  trace: ExecutionTrace;
  errors: string[];
}

/**
 * Executes ONE scenario under ONE policy in the PayPal Sandbox (or the simulator).
 *
 * Infrastructure writes (create/confirm/capture/void) always use a stable PayPal-Request-Id:
 *   <policyRunId>-<scenarioKey>-<operationType>     e.g. run_ab12cd34-scenario_06-refund
 * The policy-driven refund follows the policy's own retry handling:
 *   - idempotent_stable_request_id → one stable id for every attempt of the same logical claim
 *   - unspecified → each attempt/delivery looks like a brand-new request (the literal,
 *     naive implementation of a policy that says nothing about retries)
 */
export async function executeScenario(a: ExecuteArgs): Promise<ExecuteResult> {
  const { runId, scenarioId, scenarioKey, adapter, policy, tx, decision } = a;
  const records: ExecutionRecord[] = [];
  const errors: string[] = [];
  const rid = (op: string, suffix = '') => `${runId}-${scenarioKey}-${op}${suffix}`;
  const logical = `claim-${runId}-${scenarioKey}`;

  const trace: ExecutionTrace = {
    scenario_id: scenarioId,
    decision: decision.decision,
    capture: null,
    authorization: null,
    capture_attempts_after_void: [],
    refunds: [],
    refund_attempts: [],
    webhook_deliveries: [],
    state_history: [],
    canonical_capture_status: null,
    dispute_open: tx.dispute_state === 'open',
  };

  const push = (operation: string, res: Res<any> | null, extra: Partial<ExecutionRecord> = {}) => {
    const status: ExecutionRecord['status'] = res === null ? (extra.status ?? 'INFO') : res.replayed && res.ok ? 'REPLAYED' : res.ok ? 'SUCCESS' : 'FAILED';
    records.push({
      id: shortId('exe'),
      test_run_id: runId,
      scenario_id: scenarioId,
      policy_version: a.policyLabel,
      operation,
      request_id: res?.call.request_id ?? null,
      logical_request_id: null,
      paypal_order_id: null,
      paypal_capture_id: null,
      paypal_refund_id: null,
      status,
      http_status: res?.status ?? null,
      mode: adapter.mode,
      lane: a.lane ?? 'shadow',
      // SAFE EVIDENCE ONLY (method · endpoint · request id · amount · currency · resource id · HTTP status · issue code).
      request_json: res ? safeCallEvidence(res.call) : null,
      response_json: res ? safeResponseEvidence(res.status, res.raw) : null,
      note: null,
      ...extra,
    });
    const last = records[records.length - 1];
    last.request_json = sanitizeFinancialEvidence(last.request_json);
    last.response_json = sanitizeFinancialEvidence(last.response_json);
  };
  const fail = (what: string, res: Res<any>) => {
    errors.push(`${what} failed: HTTP ${res.status}${res.ok ? '' : ` ${res.error.issue ?? res.error.name}`}`);
  };

  const amount = { currency_code: tx.currency, value: tx.amount };
  const intent = tx.payment_flow === 'sale' ? 'CAPTURE' : 'AUTHORIZE';

  // ── Orders: create → confirm (sandbox test card) ──
  const order = await adapter.createOrder({ requestId: rid('create-order'), intent, amount, referenceId: `${runId}-${scenarioKey}` });
  push('create_order', order, { paypal_order_id: order.ok ? order.data.id : null });
  if (!order.ok) {
    fail('create_order', order);
    return { records, trace, errors };
  }
  const orderId = order.data.id;
  const confirm = await adapter.confirmPaymentSource(orderId, rid('confirm'));
  push('confirm_payment_source', confirm, { paypal_order_id: orderId });
  if (!confirm.ok) {
    fail('confirm_payment_source', confirm);
    return { records, trace, errors };
  }

  // ── Authorize → void → capture-attempt path (tests "voided authorization cannot be captured") ──
  if (tx.payment_flow === 'authorize_then_void') {
    const auth = await adapter.authorizeOrder(orderId, rid('authorize'));
    push('authorize_order', auth, { paypal_order_id: orderId });
    if (!auth.ok) {
      fail('authorize_order', auth);
      return { records, trace, errors };
    }
    trace.authorization = { id: auth.data.id, voided: false };
    const voided = await adapter.voidAuthorization(auth.data.id, rid('void'));
    push('void_authorization', voided, { paypal_order_id: orderId });
    trace.authorization.voided = voided.ok;
    if (!voided.ok) fail('void_authorization', voided);
    const attempt = await adapter.captureAuthorization(auth.data.id, rid('capture-after-void'), amount);
    push('capture_after_void_attempt', attempt, { paypal_order_id: orderId, note: 'Expected to FAIL: a voided authorization must not be capturable.' });
    trace.capture_attempts_after_void.push({ request_id: rid('capture-after-void'), succeeded: attempt.ok });
    push('no_refund_possible', null, { status: 'SKIPPED', note: 'Nothing was captured on this path, so there is nothing to refund.' });
    return { records, trace, errors };
  }

  // ── Capture ──
  const cap = await adapter.captureOrder(orderId, rid('capture'));
  push('capture_order', cap, { paypal_order_id: orderId, paypal_capture_id: cap.ok ? cap.data.id : null });
  if (!cap.ok) {
    fail('capture_order', cap);
    return { records, trace, errors };
  }
  const capId = cap.data.id;
  trace.capture = {
    id: capId,
    amount_cents: toCents(cap.data.amount.value),
    currency: cap.data.amount.currency_code,
    payee_merchant_id: cap.data.payee_merchant_id,
    status: cap.data.status,
  };

  push('dispute_state', null, {
    status: 'INFO',
    paypal_capture_id: capId,
    note:
      tx.dispute_state === 'open'
        ? 'SIMULATED overlay: this transaction is treated as having an open dispute. PolicyTwin does not create disputes in the PayPal Sandbox (Disputes API is an optional extension).'
        : 'No dispute on this transaction.',
  });
  if (decision.decision === 'REVIEW') {
    push('route_to_review', null, { status: 'SKIPPED', paypal_capture_id: capId, note: `Decision REVIEW (${decision.reason_codes.join(', ')}): no financial write executed.` });
  }

  // ── Claim intake via webhook stream (claim event + PayPal payment-state events) ──
  const dedupe = policy.duplicate_event_handling === 'dedupe_by_event_id';
  const stable = policy.retry_handling === 'idempotent_stable_request_id';
  const mode: WebhookMode = dedupe ? 'canonical_dedupe' : 'naive_last_write_wins';
  const state = new InMemoryWebhookState();
  const claimEventId = `WH-${runId}-${scenarioKey}-claim`;
  const seenClaims = new Set<string>();

  const completedEvt: WebhookEvent = {
    id: `WH-${runId}-${scenarioKey}-captured`,
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    create_time: cap.data.update_time,
    resource: { id: capId, status: 'COMPLETED', update_time: cap.data.update_time },
  };
  let refundedEvt: WebhookEvent | null = null;

  const recordStateAfter = async (eventId: string) => {
    const s = (await state.getResource(capId))?.status ?? null;
    trace.state_history.push({ event_id: eventId, state: s as CaptureState | null, rank: rankOf(s) });
  };

  const deliverStateEvent = async (evt: WebhookEvent, pass: number) => {
    const res = await processWebhookEvent({ state, adapter, mode }, evt);
    trace.webhook_deliveries.push({
      event_id: evt.id,
      event_type: evt.event_type,
      delivery_no: pass,
      triggers_operation: false,
      handler_invoked_operation: false,
      ignored_as_duplicate: res.ignored_duplicate,
    });
    push('webhook_delivery', null, {
      status: 'INFO',
      paypal_capture_id: capId,
      request_json: { event_id: evt.id, event_type: evt.event_type, delivery_no: pass, handler_mode: mode },
      response_json: res,
      note: `${evt.event_type} delivery #${pass}: ${res.reason}`,
    });
    await recordStateAfter(evt.id);
  };

  const deliverClaim = async (pass: number) => {
    if (dedupe && seenClaims.has(claimEventId)) {
      trace.webhook_deliveries.push({ event_id: claimEventId, event_type: 'POLICYTWIN.CLAIM.SUBMITTED', delivery_no: pass, triggers_operation: true, handler_invoked_operation: false, ignored_as_duplicate: true });
      push('webhook_delivery', null, { status: 'INFO', paypal_capture_id: capId, request_json: { event_id: claimEventId, delivery_no: pass }, note: `claim delivery #${pass}: event id already processed; ignored (dedupe_by_event_id).` });
      return;
    }
    seenClaims.add(claimEventId);
    let invoked = false;
    if (decision.decision === 'AUTO_REFUND') {
      invoked = true;
      for (let attempt = 1; attempt <= tx.request_attempts; attempt++) {
        const requestId = stable ? rid('refund') : rid('refund', `-d${pass}-a${attempt}`);
        const res = await adapter.refundCapture(capId, {
          requestId,
          amount: { currency_code: tx.currency, value: decision.refund_amount ?? tx.amount },
          noteToPayer: 'Missing-delivery claim (PolicyTwin test)',
        });
        push('refund_capture', res, {
          paypal_order_id: orderId,
          paypal_capture_id: capId,
          paypal_refund_id: res.ok ? res.data.id : null,
          logical_request_id: logical,
          note: `delivery #${pass}, attempt #${attempt}${res.ok && res.replayed ? ' (idempotent replay of the original refund)' : ''}`,
        });
        trace.refund_attempts.push({
          logical_request_id: logical,
          request_id: requestId,
          http_status: res.status,
          ok: res.ok,
          replayed: res.replayed,
          refund_id: res.ok ? res.data.id : null,
          error_issue: res.ok ? null : res.error.issue,
        });
        if (res.ok && !trace.refunds.some((r) => r.id === res.data.id)) {
          trace.refunds.push({
            id: res.data.id,
            amount_cents: toCents(res.data.amount.value),
            currency: res.data.amount.currency_code,
            payee_merchant_id: res.data.payee_merchant_id,
            logical_request_id: logical,
            request_id: requestId,
          });
        }
        if (res.ok && !refundedEvt) {
          const canon = await adapter.getCapture(capId);
          const t = canon.ok ? canon.data.update_time : cap.data.update_time;
          refundedEvt = {
            id: `WH-${runId}-${scenarioKey}-refunded`,
            event_type: 'PAYMENT.CAPTURE.REFUNDED',
            create_time: t,
            resource: { id: res.data.id, status: 'COMPLETED', update_time: t, links: [{ rel: 'up', href: `/v2/payments/captures/${capId}` }] },
          };
        }
        if (!res.ok) errors.push(`refund attempt ${attempt} (delivery ${pass}) returned HTTP ${res.status} ${res.error.issue ?? ''}`.trim());
      }
    }
    trace.webhook_deliveries.push({ event_id: claimEventId, event_type: 'POLICYTWIN.CLAIM.SUBMITTED', delivery_no: pass, triggers_operation: true, handler_invoked_operation: invoked, ignored_as_duplicate: false });
    push('webhook_delivery', null, {
      status: 'INFO',
      paypal_capture_id: capId,
      request_json: { event_id: claimEventId, event_type: 'POLICYTWIN.CLAIM.SUBMITTED', delivery_no: pass, handler_mode: mode },
      note: `claim delivery #${pass}: ${invoked ? 'handler issued refund request(s)' : 'routed to review; no money moved'}`,
    });
  };

  for (let pass = 1; pass <= tx.webhook_deliveries; pass++) {
    await deliverStateEvent(completedEvt, pass);
    await deliverClaim(pass);
    if (refundedEvt) await deliverStateEvent(refundedEvt, pass);
  }

  // ── Verify canonical PayPal state ──
  const canonical = await adapter.getCapture(capId);
  push('get_capture', canonical, { paypal_capture_id: capId, note: 'Canonical PayPal state used for verification.' });
  if (canonical.ok) trace.canonical_capture_status = canonical.data.status;
  // Expected refund failures (e.g. CAPTURE_FULLY_REFUNDED on a duplicate) are evidence, not infrastructure errors.
  return { records, trace, errors: errors.filter((e) => !e.startsWith('refund attempt')) };
}
