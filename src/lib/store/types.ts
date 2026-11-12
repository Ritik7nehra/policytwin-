import type { ExecutionRecord, TxInput, ReleaseVerdict } from '../types';
import type { RUN_STAGES } from './tables';
import type { Policy } from '../policy/schema';
import type { PolicyIntake } from '../policy/demo';

// Row shapes follow the spec's database model; a few extra columns (noted) keep queries simple.
export interface PolicyRow {
  id: string;
  name: string;
  description: string;
  created_by: string;
  /** Server-derived demo-session id that owns this policy ('public' = read-only example). */
  owner_session: string;
  created_at: string;
  intake_json: PolicyIntake; // extra: the full Step-1 intake form
}

export interface ImpactMap {
  affected_resources: string[];
  affected_states: string[];
  affected_paypal_products: string[];
  required_tests: string[];
  rationale: string;
}

export interface PolicyVersionRow {
  id: string;
  policy_id: string;
  version: number;
  label: 'A' | 'B' | 'C';
  source_text: string;
  structured_policy_json: Policy | null;
  analysis_json: ImpactMap | null; // extra: Policy Impact Mapper output
  status: 'current' | 'proposed' | 'repair_proposed' | 'repair_approved';
  created_at: string;
}

export interface TestRunRow {
  id: string;
  policy_id: string; // extra
  policy_version_a: string;
  policy_version_b: string;
  parent_run_id: string | null; // extra: set on a rerun of a repaired policy
  /** Legacy, UI-friendly status; always updated in the same write as `stage`. */
  status: 'created' | 'twins_generated' | 'evaluated' | 'completed' | 'failed';
  /** Strict state machine (see runner/stages.ts). */
  stage: RunStage;
  /** Optimistic-concurrency revision: every writer of report_json compare-and-sets on it (no lost updates). */
  rev: number;
  /** Lease for an in-progress (*-ING) stage; an expired lease may be taken over (safe resume). */
  locked_until: string | null;
  /** Set when the last stage attempt failed; cleared by the next success. */
  failed_stage: string | null;
  last_error: string | null;
  release_decision: ReleaseVerdict | null;
  started_at: string;
  completed_at: string | null;
  created_by: string; // extra
  owner_session: string; // extra
  options_json: { adversarial: boolean }; // extra
  report_json: unknown | null; // extra: RunReport (see pipeline.ts)
}

export type RunStage = (typeof RUN_STAGES)[number];

export interface RunStageRow {
  id: string; // `${run_id}:${stage_name}`
  run_id: string;
  stage_name: string; // GENERATE_TWINS | EVALUATE | EXECUTE | SANDBOX_PROOF:<pair_id>
  status: 'RUNNING' | 'DONE' | 'FAILED';
  attempts: number;
  started_at: string;
  finished_at: string | null;
  locked_until: string | null;
  last_error: string | null;
}

export interface ScenarioRow {
  id: string;
  test_run_id: string;
  pair_id: string;
  scenario_type: 'base' | 'twin';
  scenario_key: string; // extra: scenario_NN, used in PayPal-Request-Id
  input_json: TxInput;
  changed_field: string;
  expected_behavior: string; // must_differ | must_match
  meta_json: { label: string; origin: 'core' | 'adversarial'; category: string; rationale: string; severity_if_violated: string };
}

export interface DecisionRow {
  id: string;
  test_run_id: string; // extra
  scenario_id: string;
  policy_version: string; // A | B | C
  decision: string;
  reason_codes: string[];
  explanation: string;
  detail_json: { flags: string[]; conditions_triggered: string[]; refund_amount: string | null }; // extra
}

export type ExecutionRow = ExecutionRecord;

export interface InvariantRow {
  id: string;
  test_run_id: string; // extra
  scenario_id: string;
  policy_version: string; // extra
  invariant_code: string;
  /** Which execution lane produced this result (shadow = deterministic + simulated; sandbox_proof = real PayPal Sandbox). */
  lane: 'shadow' | 'sandbox_proof';
  passed: boolean;
  severity: string;
  evidence_json: { name: string; applicable: boolean; detail: string; evidence: Record<string, unknown> };
}

export interface AgentRunRow {
  id: string;
  test_run_id: string | null; // extra
  agent_name: string;
  input_hash: string;
  model: string;
  structured_output: unknown;
  status: string;
  notes_json: string[]; // extra: guard corrections / fallback reasons
  created_at: string;
}

export interface AuditRow {
  id: string;
  test_run_id: string | null;
  event_type: string;
  actor: string;
  payload_hash: string;
  payload_json: unknown; // extra
  created_at: string;
}

export type WebhookStatus = 'RECEIVED' | 'VERIFIED' | 'PROCESSING' | 'PROCESSED' | 'FAILED_RETRYABLE' | 'FAILED_PERMANENT';

export interface WebhookEventRow {
  id: string; // PayPal event id
  event_type: string;
  resource_id: string | null;
  status: WebhookStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  locked_until: string | null;
  received_at: string;
  verified_at: string | null;
  processed_at: string | null;
  payload_json: unknown; // sanitized
}

export interface JobRow {
  id: string;
  kind: string;
  dedupe_key: string;
  payload_json: unknown;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceStateRow {
  id: string; // PayPal resource id (capture id)
  status: string;
  as_of: string;
}

export interface TableRows {
  policies: PolicyRow;
  policy_versions: PolicyVersionRow;
  test_runs: TestRunRow;
  run_stages: RunStageRow;
  scenarios: ScenarioRow;
  policy_decisions: DecisionRow;
  paypal_executions: ExecutionRow;
  invariant_results: InvariantRow;
  agent_runs: AgentRunRow;
  audit_events: AuditRow;
  webhook_events: WebhookEventRow;
  resource_states: ResourceStateRow;
  jobs: JobRow;
}
export type TableName = keyof TableRows;

/** A where-condition: exact match, IS NULL, or a half-open range for scalar columns. */
export type Cond<V> = V | null | { gte?: V; lt?: V };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface Store {
  readonly mode: 'memory' | 'postgres';
  init(): Promise<void>;
  /** Throws ConstraintError (unique / foreign key / check / not-null) on integrity violations. */
  insert<T extends TableName>(t: T, row: TableRows[T]): Promise<TableRows[T]>;
  /** All-or-nothing: either every row is inserted or none is. */
  insertMany<T extends TableName>(t: T, rows: TableRows[T][]): Promise<void>;
  get<T extends TableName>(t: T, id: string): Promise<TableRows[T] | null>;
  list<T extends TableName>(t: T, where?: Where<TableRows[T]>): Promise<TableRows[T][]>;
  count<T extends TableName>(t: T, where?: Where<TableRows[T]>): Promise<number>;
  update<T extends TableName>(t: T, id: string, patch: Partial<TableRows[T]>): Promise<TableRows[T]>;
  upsert<T extends TableName>(t: T, row: TableRows[T]): Promise<TableRows[T]>;
  /**
   * Atomic compare-and-set: applies `patch` only if the row's current values equal `expected`
   * (nulls allowed). Returns the updated row, or null if the expectation did not hold (someone else won).
   */
  compareAndSet<T extends TableName>(t: T, id: string, expected: Partial<TableRows[T]>, patch: Partial<TableRows[T]>): Promise<TableRows[T] | null>;
  /** Delete rows matching `where` (restrict semantics: referenced rows must be deleted first). Returns the count. */
  deleteWhere<T extends TableName>(t: T, where: Where<TableRows[T]>): Promise<number>;
  /** Run `fn` atomically. Everything done through `tx` commits together or not at all. Nested calls join the outer transaction. */
  transaction<R>(fn: (tx: Store) => Promise<R>): Promise<R>;
  /** Cheap liveness probe for /api/health. */
  ping(): Promise<void>;
  close?(): Promise<void>;
}
