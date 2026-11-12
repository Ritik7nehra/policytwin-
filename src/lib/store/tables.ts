import type { TableName } from './types';

/**
 * Single source of truth for the PostgreSQL schema AND for the constraints the in-memory store
 * enforces (so tests on either backend see the same integrity rules).
 * db/schema.sql is generated from this (npm run db:schema); a test asserts the two stay identical.
 *
 * Column kinds: text | int | bool | json (JSONB) | ts (TIMESTAMPTZ; the app always sees ISO-8601 strings).
 * Exception: resource_states.as_of is PayPal's own timestamp string, compared lexicographically — kept as TEXT on purpose.
 */
export type ColKind = 'text' | 'int' | 'bool' | 'json' | 'ts';
export interface ColSpec {
  kind: ColKind;
  notNull: boolean;
}
export interface TableSpec {
  cols: Record<string, ColSpec>;
  /** UNIQUE (a, b, …) constraints. NULLs never conflict (Postgres semantics). */
  unique?: string[][];
  /** column → allowed values (CHECK (col IN (…))). NULL passes unless the column is NOT NULL. */
  checks?: Record<string, readonly string[]>;
  /** column → referenced table (FOREIGN KEY … REFERENCES table(id)). */
  fks?: Record<string, TableName>;
}

const c = (kind: ColKind, notNull = false): ColSpec => ({ kind, notNull });
const T = (notNull = true) => c('text', notNull);
const TS = (notNull = true) => c('ts', notNull);
const J = (notNull = false) => c('json', notNull);
const I = (notNull = true) => c('int', notNull);

export const TEST_RUN_STATUSES = ['created', 'twins_generated', 'evaluated', 'completed', 'failed'] as const;
/** The strict per-run state machine. *-ING states are held under a lease; the others are stable. */
export const RUN_STAGES = ['CREATED', 'GENERATING', 'TWINS_READY', 'EVALUATING', 'EVALUATED', 'EXECUTING', 'COMPLETED', 'DECIDED'] as const;
export const WEBHOOK_STATUSES = ['RECEIVED', 'VERIFIED', 'PROCESSING', 'PROCESSED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'] as const;
export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;
export const LANES = ['shadow', 'sandbox_proof'] as const;

// Declaration order = creation order = foreign-key dependency order.
export const TABLE_SPECS: Record<TableName, TableSpec> = {
  policies: {
    cols: { id: T(), name: T(), description: T(), created_by: T(), owner_session: T(), created_at: TS(), intake_json: J(true) },
  },
  policy_versions: {
    cols: { id: T(), policy_id: T(), version: I(), label: T(), source_text: T(), structured_policy_json: J(), analysis_json: J(), status: T(), created_at: TS() },
    unique: [['policy_id', 'version']],
    checks: { label: ['A', 'B', 'C'], status: ['current', 'proposed', 'repair_proposed', 'repair_approved'] },
    fks: { policy_id: 'policies' },
  },
  test_runs: {
    cols: {
      id: T(),
      policy_id: T(),
      policy_version_a: T(),
      policy_version_b: T(),
      parent_run_id: T(false),
      status: T(),
      stage: T(),
      rev: I(), // optimistic-concurrency revision for report_json writers
      locked_until: TS(false),
      failed_stage: T(false),
      last_error: T(false),
      release_decision: T(false),
      started_at: TS(),
      completed_at: TS(false),
      created_by: T(),
      owner_session: T(),
      options_json: J(true),
      report_json: J(),
    },
    unique: [['parent_run_id']], // one re-run per approved repair
    checks: { status: TEST_RUN_STATUSES, stage: RUN_STAGES, release_decision: ['PASS', 'REVIEW', 'BLOCK'] },
    fks: { policy_id: 'policies', policy_version_a: 'policy_versions', policy_version_b: 'policy_versions', parent_run_id: 'test_runs' },
  },
  run_stages: {
    // id = `${run_id}:${stage_name}` — the unique stage key.
    cols: { id: T(), run_id: T(), stage_name: T(), status: T(), attempts: I(), started_at: TS(), finished_at: TS(false), locked_until: TS(false), last_error: T(false) },
    unique: [['run_id', 'stage_name']],
    checks: { status: ['RUNNING', 'DONE', 'FAILED'] },
    fks: { run_id: 'test_runs' },
  },
  scenarios: {
    cols: { id: T(), test_run_id: T(), pair_id: T(), scenario_type: T(), scenario_key: T(), input_json: J(true), changed_field: T(), expected_behavior: T(), meta_json: J(true) },
    unique: [['test_run_id', 'scenario_key']],
    checks: { scenario_type: ['base', 'twin'], expected_behavior: ['must_differ', 'must_match'] },
    fks: { test_run_id: 'test_runs' },
  },
  policy_decisions: {
    cols: { id: T(), test_run_id: T(), scenario_id: T(), policy_version: T(), decision: T(), reason_codes: J(true), explanation: T(), detail_json: J(true) },
    unique: [['scenario_id', 'policy_version']],
    checks: { policy_version: ['A', 'B', 'C'], decision: ['AUTO_REFUND', 'REVIEW'] },
    fks: { test_run_id: 'test_runs', scenario_id: 'scenarios' },
  },
  paypal_executions: {
    cols: {
      id: T(),
      test_run_id: T(),
      scenario_id: T(),
      policy_version: T(),
      operation: T(),
      request_id: T(false),
      logical_request_id: T(false),
      paypal_order_id: T(false),
      paypal_capture_id: T(false),
      paypal_refund_id: T(false),
      status: T(),
      http_status: I(false),
      mode: T(),
      lane: T(),
      request_json: J(),
      response_json: J(),
      note: T(false),
    },
    checks: { policy_version: ['A', 'B', 'C'], status: ['SUCCESS', 'FAILED', 'REPLAYED', 'SKIPPED', 'INFO'], mode: ['simulated', 'sandbox'], lane: LANES },
    fks: { test_run_id: 'test_runs', scenario_id: 'scenarios' },
  },
  invariant_results: {
    cols: { id: T(), test_run_id: T(), scenario_id: T(), policy_version: T(), invariant_code: T(), lane: T(), passed: c('bool', true), severity: T(), evidence_json: J(true) },
    unique: [['scenario_id', 'policy_version', 'invariant_code', 'lane']],
    checks: { policy_version: ['A', 'B', 'C'], severity: ['critical'], lane: LANES },
    fks: { test_run_id: 'test_runs', scenario_id: 'scenarios' },
  },
  agent_runs: {
    cols: { id: T(), test_run_id: T(false), agent_name: T(), input_hash: T(), model: T(), structured_output: J(), status: T(), notes_json: J(true), created_at: TS() },
    fks: { test_run_id: 'test_runs' },
  },
  audit_events: {
    cols: { id: T(), test_run_id: T(false), event_type: T(), actor: T(), payload_hash: T(), payload_json: J(), created_at: TS() },
    fks: { test_run_id: 'test_runs' },
  },
  webhook_events: {
    // Lifecycle: RECEIVED → VERIFIED → PROCESSING → PROCESSED; failures: FAILED_RETRYABLE / FAILED_PERMANENT.
    // A duplicate delivery is ignored ONLY when status = PROCESSED.
    cols: {
      id: T(), // PayPal event id
      event_type: T(),
      resource_id: T(false),
      status: T(),
      attempts: I(),
      last_error: T(false),
      next_attempt_at: TS(false),
      locked_until: TS(false),
      received_at: TS(),
      verified_at: TS(false),
      processed_at: TS(false),
      payload_json: J(),
    },
    checks: { status: WEBHOOK_STATUSES },
  },
  resource_states: {
    cols: { id: T(), status: T(), as_of: T() }, // as_of: PayPal's timestamp string (lexicographic comparison)
  },
  jobs: {
    // Small PostgreSQL-backed durable queue (webhook processing). Claimed with optimistic CAS + lease.
    cols: {
      id: T(),
      kind: T(),
      dedupe_key: T(),
      payload_json: J(true),
      status: T(),
      attempts: I(),
      max_attempts: I(),
      run_at: TS(),
      locked_until: TS(false),
      last_error: T(false),
      created_at: TS(),
      updated_at: TS(),
    },
    unique: [['dedupe_key']],
    checks: { status: JOB_STATUSES },
  },
};

/** Kind-only view used by the stores for (de)serialisation. */
export type ColKindMap = Record<string, ColKind>;
export const TABLE_DEFS: Record<TableName, ColKindMap> = Object.fromEntries(
  Object.entries(TABLE_SPECS).map(([t, s]) => [t, Object.fromEntries(Object.entries(s.cols).map(([k, v]) => [k, v.kind]))]),
) as Record<TableName, ColKindMap>;

const SQL_TYPE: Record<ColKind, string> = { text: 'TEXT', int: 'INTEGER', bool: 'BOOLEAN', json: 'JSONB', ts: 'TIMESTAMPTZ' };

export function buildSchemaStatements(): string[] {
  const out: string[] = [];
  for (const [table, spec] of Object.entries(TABLE_SPECS)) {
    const lines = ['  seq SERIAL'];
    for (const [col, s] of Object.entries(spec.cols)) {
      lines.push(`  ${col} ${SQL_TYPE[s.kind]}${col === 'id' ? ' PRIMARY KEY' : s.notNull ? ' NOT NULL' : ''}`);
    }
    for (const [col, values] of Object.entries(spec.checks ?? {})) {
      const nullable = !spec.cols[col].notNull;
      // `col IS NULL OR …` keeps nullable columns valid on every engine (real PostgreSQL already treats NULL as passing).
      lines.push(`  CONSTRAINT ${table}_${col}_check CHECK (${nullable ? `${col} IS NULL OR ` : ''}${col} IN (${values.map((v) => `'${v}'`).join(', ')}))`);
    }
    for (const cols of spec.unique ?? []) lines.push(`  CONSTRAINT ${table}_${cols.join('_')}_key UNIQUE (${cols.join(', ')})`);
    for (const [col, ref] of Object.entries(spec.fks ?? {})) lines.push(`  CONSTRAINT ${table}_${col}_fkey FOREIGN KEY (${col}) REFERENCES ${ref} (id)`);
    out.push(`CREATE TABLE IF NOT EXISTS ${table} (\n${lines.join(',\n')}\n)`);
  }
  out.push('CREATE INDEX IF NOT EXISTS idx_policies_owner ON policies (owner_session)');
  out.push('CREATE INDEX IF NOT EXISTS idx_runs_owner ON test_runs (owner_session)');
  out.push('CREATE INDEX IF NOT EXISTS idx_runs_policy ON test_runs (policy_id)');
  out.push('CREATE INDEX IF NOT EXISTS idx_versions_policy ON policy_versions (policy_id)');
  out.push('CREATE INDEX IF NOT EXISTS idx_scenarios_run ON scenarios (test_run_id)');
  out.push('CREATE INDEX IF NOT EXISTS idx_decisions_run ON policy_decisions (test_run_id)');
  out.push('CREATE INDEX IF NOT EXISTS idx_exec_run ON paypal_executions (test_run_id)');
  out.push('CREATE INDEX IF NOT EXISTS idx_inv_run ON invariant_results (test_run_id)');
  out.push('CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events (test_run_id)');
  out.push('CREATE INDEX IF NOT EXISTS idx_agent_created ON agent_runs (created_at)');
  out.push('CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, run_at)');
  out.push('CREATE INDEX IF NOT EXISTS idx_webhooks_status ON webhook_events (status)');
  return out;
}

export function buildSchemaSql(): string {
  return `-- PolicyTwin schema v2 (generated by \`npm run db:schema\` from src/lib/store/tables.ts — do not edit by hand)\n${buildSchemaStatements().map((s) => `${s};`).join('\n\n')}\n`;
}
