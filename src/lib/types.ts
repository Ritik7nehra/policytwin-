import { z } from 'zod';
import { CURRENCIES, isMoney } from './money';

// ───────────────────────── Transaction inputs ─────────────────────────
export const PRODUCT_TYPES = ['physical', 'digital', 'service'] as const;
export const EVIDENCE_STATUSES = ['missing', 'confirms_non_delivery', 'confirms_delivery', 'conflicting'] as const;
export const PAYMENT_FLOWS = ['sale', 'authorize_then_void'] as const;

const money = z.string().refine(isMoney, 'must look like "40.00"');

export const TxInputSchema = z.object({
  amount: money,
  currency: z.enum(CURRENCIES),
  product_type: z.enum(PRODUCT_TYPES),
  tracking_available: z.boolean(),
  evidence_status: z.enum(EVIDENCE_STATUSES),
  dispute_state: z.enum(['none', 'open']),
  customer_history: z.enum(['existing', 'new']),
  /** null = the claim is for the full captured amount. */
  claimed_amount: money.nullable(),
  /** How many times the refund request is sent for the same claim (2 = network retry). */
  request_attempts: z.number().int().min(1).max(3),
  /** How many times the claim webhook is delivered (2 = duplicate delivery). */
  webhook_deliveries: z.number().int().min(1).max(3),
  payment_flow: z.enum(PAYMENT_FLOWS),
});
export type TxInput = z.infer<typeof TxInputSchema>;
export const TX_FIELDS = Object.keys(TxInputSchema.shape) as (keyof TxInput)[];

// ───────────────────────── Policy decisions ─────────────────────────
export type Decision = 'AUTO_REFUND' | 'REVIEW';

export interface PolicyDecision {
  decision: Decision;
  reason_codes: string[];
  /** Ambiguity flags raised because the policy left a behaviour unspecified. */
  flags: string[];
  conditions_triggered: string[];
  explanation: string;
  refund_amount: string | null;
}

// ───────────────────────── Twin pairs ─────────────────────────
/** Fields that a twin pair is allowed to vary. `claimed_amount` is derived and never varied. */
export const CAUSAL_FIELDS = [
  'product_type',
  'amount',
  'currency',
  'request_attempts',
  'dispute_state',
  'webhook_deliveries',
  'evidence_status',
  'customer_history',
  'payment_flow',
] as const;
export type CausalField = (typeof CAUSAL_FIELDS)[number];

export const TEST_CATEGORIES = [
  'amount_boundary',
  'product_type',
  'currency_variation',
  'duplicate_request',
  'dispute_state',
  'duplicate_webhook',
  'evidence_status',
  'customer_history',
  'void_authorization',
] as const;
export type TestCategory = (typeof TEST_CATEGORIES)[number];

export type Expectation = 'must_differ' | 'must_match';
export type Severity = 'none' | 'medium' | 'high' | 'critical';

export interface TwinPair {
  id: string; // pair_01 …
  label: string;
  origin: 'core' | 'adversarial';
  category: TestCategory;
  changed_field: CausalField;
  base: TxInput;
  twin: TxInput;
  expectation: Expectation;
  rationale: string;
  severity_if_violated: Severity;
}

// ───────────────────────── Execution trace & invariants ─────────────────────────
export type CaptureState = 'PENDING' | 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

export interface RefundRecord {
  id: string;
  amount_cents: number;
  currency: string;
  payee_merchant_id: string;
  logical_request_id: string;
  request_id: string;
}

export interface ExecutionTrace {
  scenario_id: string;
  decision: Decision;
  capture: { id: string; amount_cents: number; currency: string; payee_merchant_id: string; status: string } | null;
  authorization: { id: string; voided: boolean } | null;
  capture_attempts_after_void: { request_id: string; succeeded: boolean }[];
  /** Distinct successful refunds (replayed idempotent responses are not double counted). */
  refunds: RefundRecord[];
  refund_attempts: {
    logical_request_id: string;
    request_id: string;
    http_status: number;
    ok: boolean;
    replayed: boolean;
    refund_id: string | null;
    error_issue: string | null;
  }[];
  webhook_deliveries: {
    event_id: string;
    event_type: string;
    delivery_no: number;
    triggers_operation: boolean;
    handler_invoked_operation: boolean;
    ignored_as_duplicate: boolean;
  }[];
  state_history: { event_id: string; state: CaptureState | null; rank: number }[];
  canonical_capture_status: string | null;
  dispute_open: boolean;
}

export interface InvariantResult {
  scenario_id: string;
  code: string;
  name: string;
  applicable: boolean;
  passed: boolean;
  severity: 'critical';
  detail: string;
  evidence: Record<string, unknown>;
}

// ───────────────────────── Pair-level results ─────────────────────────
export type PairOutcome =
  | 'AS_EXPECTED'
  | 'UNINTENDED_EXPANSION'
  | 'UNEXPECTED_EQUALITY'
  | 'UNEXPECTED_DIFFERENCE'
  | 'AMBIGUOUS'
  | 'INVARIANT_FAILURE';

export type PairTag = 'PASSED' | 'UNEXPECTED_DIFFERENCE' | 'INVARIANT_FAILURE' | 'HUMAN_REVIEW' | 'CRITICAL_REGRESSION';

export interface PairResult {
  pair_id: string;
  label: string;
  origin: 'core' | 'adversarial';
  category: TestCategory;
  changed_field: CausalField;
  base_scenario_id: string;
  twin_scenario_id: string;
  expectation: Expectation;
  old_base: Decision;
  old_twin: Decision;
  new_base: Decision;
  new_twin: Decision;
  new_flags: string[];
  outcome: PairOutcome;
  severity: Severity;
  tags: PairTag[];
  failed_invariants: string[];
  headline: string;
  explanation: string;
}

export interface Coverage {
  required: TestCategory[];
  covered: TestCategory[];
  missing: TestCategory[];
  ratio: number;
}

export type ReleaseVerdict = 'PASS' | 'REVIEW' | 'BLOCK';

export interface ReleaseDecision {
  decision: ReleaseVerdict;
  reasons: string[];
  critical_findings: string[];
  invariant_failures: string[];
  counts: { pairs: number; passed: number; critical: number; high: number; medium: number; invariant_failures: number };
  coverage: Coverage;
  execution_errors: string[];
  /** Policy terms PolicyTwin could not execute or test (e.g. an unmodelled exception). Any entry rules out PASS. */
  unverified_terms: string[];
}

export interface RuntimeInfo {
  paypal_mode: 'simulated' | 'sandbox';
  paypal_label: string;
  ai_mode: 'deterministic' | 'openai';
  ai_model: string;
  db_mode: 'memory' | 'postgres';
  /** Lane 1 (every scenario) always runs on the deterministic engine + simulated payment adapter. */
  lane1_mode: 'simulated';
  /** Lane 2 (selected pair) uses the configured adapter: the real PayPal Sandbox when credentials exist. */
  lane2_mode: 'simulated' | 'sandbox';
  lane2_label: string;
}

// ───────────────────────── Execution records (one row per Sandbox/webhook operation) ─────────────────────────
export interface ExecutionRecord {
  id: string;
  test_run_id: string;
  scenario_id: string;
  policy_version: string; // A | B | C
  operation: string;
  request_id: string | null;
  logical_request_id: string | null;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  paypal_refund_id: string | null;
  status: 'SUCCESS' | 'FAILED' | 'REPLAYED' | 'SKIPPED' | 'INFO';
  http_status: number | null;
  mode: 'simulated' | 'sandbox';
  /** shadow = full deterministic run on the simulator; sandbox_proof = the selected pair re-executed in the real PayPal Sandbox. */
  lane: 'shadow' | 'sandbox_proof';
  /** SAFE EVIDENCE ONLY: method, endpoint, request id, amount, currency (see security/sanitize.ts). */
  request_json: unknown;
  /** SAFE EVIDENCE ONLY: http status, resource id/status, amount, currency, normalised issue code. */
  response_json: unknown;
  note: string | null;
}
