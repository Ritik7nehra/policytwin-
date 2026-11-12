import type { RuntimeInfo } from './types';

export type Verdict = 'PASS' | 'REVIEW' | 'BLOCK';

export interface SessionInfo {
  authenticated: boolean;
  required: boolean;
  mode?: 'open' | 'passcode';
  actor?: string;
  expires_at?: string | null;
  limits?: { maxRunsPerSession: number; maxPoliciesPerSession: number; aiCallsPerDay: number };
  usage?: { runs: number; policies: number };
  public_example: { policy_id: string; run_ids: string[] };
}

export interface HealthInfo {
  ok: boolean;
  status: 'healthy' | 'degraded' | 'unavailable';
  runtime: RuntimeInfo;
  checks: { database: string; access_control: string };
  dependencies: { name: string; state: 'closed' | 'open' | 'half_open'; consecutive_failures: number; opened_at: string | null; last_error: string | null; last_success_at: string | null }[];
  queue: { queued: number; running: number; failed: number; done: number } | null;
  auth: { required: boolean; configured: boolean };
  disclosures: string[];
}

export interface OverviewRun {
  id: string;
  policy_id: string;
  policy_name: string;
  release_decision: Verdict | null;
  stage: string;
  status: string;
  started_at: string;
  parent_run_id: string | null;
  read_only: boolean;
  headline: string | null;
  counts: { pairs: number; passed: number; critical: number; high: number; medium: number; invariant_failures: number } | null;
  human_decision: { decision: 'approve' | 'reject'; at: string } | null;
}

export interface Overview {
  scope: string;
  totals: {
    policies: number;
    runs: number;
    completed_runs: number;
    decided_runs: number;
    pairs: number;
    passed_pairs: number;
    critical_pairs: number;
    invariant_failures: number;
    scenarios: number;
    verdicts: Record<Verdict, number>;
  };
  recent_policies: { id: string; name: string; description: string; created_at: string; read_only: boolean; runs: { id: string; release_decision: Verdict | null; parent_run_id: string | null; stage: string }[] }[];
  recent_runs: OverviewRun[];
  public_example: { policy_id: string; run_ids: string[] };
  runtime: RuntimeInfo;
}
