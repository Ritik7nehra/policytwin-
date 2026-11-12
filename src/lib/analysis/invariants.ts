import type { ExecutionTrace, InvariantResult } from '../types';
import { sumCents } from '../money';

/**
 * Deterministic financial invariants. These decide whether money behaviour is valid —
 * never an LLM. Each check reads only the ExecutionTrace.
 * The first seven come from the spec; the eighth covers "conflicting financial state"
 * (an automatic refund while a dispute is open).
 */
type Check = (t: ExecutionTrace) => Omit<InvariantResult, 'scenario_id' | 'code' | 'name' | 'severity'>;

const na = (detail: string) => ({ applicable: false, passed: true, detail, evidence: {} });

export const INVARIANTS: { code: string; name: string; check: Check }[] = [
  {
    code: 'REFUND_TOTAL_LTE_CAPTURE',
    name: 'Successful refund total ≤ captured amount',
    check: (t) => {
      if (!t.capture) return na('No capture on this path.');
      const total = sumCents(t.refunds.map((r) => r.amount_cents));
      return {
        applicable: true,
        passed: total <= t.capture.amount_cents,
        detail: `refunded ${total}¢ of ${t.capture.amount_cents}¢ captured`,
        evidence: { refunded_cents: total, captured_cents: t.capture.amount_cents, refund_ids: t.refunds.map((r) => r.id) },
      };
    },
  },
  {
    code: 'ONE_REFUND_PER_LOGICAL_REQUEST',
    name: 'One logical request → at most one successful refund',
    check: (t) => {
      const byLogical = new Map<string, string[]>();
      for (const r of t.refunds) byLogical.set(r.logical_request_id, [...(byLogical.get(r.logical_request_id) ?? []), r.id]);
      if (t.refund_attempts.length === 0) return na('No refund was attempted.');
      const offenders = [...byLogical.entries()].filter(([, ids]) => ids.length > 1);
      return {
        applicable: true,
        passed: offenders.length === 0,
        detail: offenders.length ? `logical request ${offenders[0][0]} produced ${offenders[0][1].length} successful refunds (${offenders[0][1].join(', ')})` : 'each logical request produced at most one refund',
        evidence: { attempts: t.refund_attempts.length, successful_refunds_by_logical_request: Object.fromEntries(byLogical) },
      };
    },
  },
  {
    code: 'REFUND_CURRENCY_MATCHES_CAPTURE',
    name: 'Refund currency = capture currency',
    check: (t) => {
      if (!t.capture || t.refunds.length === 0) return na('No refund to compare.');
      const bad = t.refunds.filter((r) => r.currency !== t.capture!.currency);
      return { applicable: true, passed: bad.length === 0, detail: bad.length ? `refund ${bad[0].id} is ${bad[0].currency}, capture is ${t.capture.currency}` : `all refunds in ${t.capture.currency}`, evidence: { capture_currency: t.capture.currency, refund_currencies: t.refunds.map((r) => r.currency) } };
    },
  },
  {
    code: 'REFUND_PAYEE_MATCHES_ORIGINAL',
    name: 'Refund payee = original payee',
    check: (t) => {
      if (!t.capture || t.refunds.length === 0) return na('No refund to compare.');
      const bad = t.refunds.filter((r) => r.payee_merchant_id !== t.capture!.payee_merchant_id);
      return { applicable: true, passed: bad.length === 0, detail: bad.length ? `refund ${bad[0].id} payee ${bad[0].payee_merchant_id} ≠ capture payee ${t.capture.payee_merchant_id}` : 'refund payee equals capture payee', evidence: { capture_payee: t.capture.payee_merchant_id, refund_payees: t.refunds.map((r) => r.payee_merchant_id) } };
    },
  },
  {
    code: 'VOIDED_AUTH_NOT_CAPTURED',
    name: 'A voided authorization cannot later be captured',
    check: (t) => {
      if (!t.authorization?.voided) return na('No voided authorization on this path.');
      const succeeded = t.capture_attempts_after_void.filter((a) => a.succeeded);
      return { applicable: true, passed: succeeded.length === 0, detail: succeeded.length ? `${succeeded.length} capture(s) succeeded after the authorization was voided` : `${t.capture_attempts_after_void.length} capture attempt(s) after void were rejected`, evidence: { attempts: t.capture_attempts_after_void } };
    },
  },
  {
    code: 'DUPLICATE_WEBHOOK_NO_DUPLICATE_OPERATION',
    name: 'A duplicate webhook cannot create a duplicate operation',
    check: (t) => {
      const ops = new Map<string, number>();
      const total = new Map<string, number>();
      for (const d of t.webhook_deliveries) {
        total.set(d.event_id, (total.get(d.event_id) ?? 0) + 1);
        if (d.triggers_operation && d.handler_invoked_operation) ops.set(d.event_id, (ops.get(d.event_id) ?? 0) + 1);
      }
      const dupes = [...total.entries()].filter(([, n]) => n > 1);
      if (dupes.length === 0) return na('No event was delivered more than once.');
      const offenders = [...ops.entries()].filter(([, n]) => n > 1);
      return { applicable: true, passed: offenders.length === 0, detail: offenders.length ? `event ${offenders[0][0]} triggered ${offenders[0][1]} operations across duplicate deliveries` : 'duplicate deliveries did not trigger additional operations', evidence: { deliveries_per_event: Object.fromEntries(total), operations_per_event: Object.fromEntries(ops) } };
    },
  },
  {
    code: 'OLDER_WEBHOOK_NO_STATE_REGRESSION',
    name: 'An older webhook cannot overwrite newer PayPal state',
    check: (t) => {
      if (t.state_history.length < 2) return na('Fewer than two state updates recorded.');
      let max = -1;
      const regressions: { event_id: string; from_rank: number; to_rank: number; to_state: string | null }[] = [];
      for (const h of t.state_history) {
        if (h.rank < max) regressions.push({ event_id: h.event_id, from_rank: max, to_rank: h.rank, to_state: h.state });
        max = Math.max(max, h.rank);
      }
      return { applicable: true, passed: regressions.length === 0, detail: regressions.length ? `local state moved backwards after event ${regressions[0].event_id} (to ${regressions[0].to_state})` : 'local state never moved backwards', evidence: { history: t.state_history.map((h) => `${h.event_id}→${h.state}`), regressions } };
    },
  },
  {
    code: 'NO_AUTO_REFUND_WITH_OPEN_DISPUTE',
    name: 'No automatic refund while a dispute is open',
    check: (t) => {
      if (!t.dispute_open) return na('No open dispute on this transaction.');
      return { applicable: true, passed: t.refunds.length === 0, detail: t.refunds.length ? `${t.refunds.length} automatic refund(s) issued while a dispute was open (double-recovery risk)` : 'no automatic refund while the dispute was open', evidence: { refund_ids: t.refunds.map((r) => r.id) } };
    },
  },
];

export function checkInvariants(trace: ExecutionTrace): InvariantResult[] {
  return INVARIANTS.map((inv) => ({ scenario_id: trace.scenario_id, code: inv.code, name: inv.name, severity: 'critical' as const, ...inv.check(trace) }));
}
