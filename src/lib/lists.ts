import { api } from './client';
import type { Verdict } from './ui-types';

export interface RunListItem {
  id: string;
  policy_id: string;
  policy_name: string;
  stage: string;
  status: string;
  release_decision: Verdict | null;
  started_at: string;
  completed_at: string | null;
  parent_run_id: string | null;
  read_only: boolean;
}

/** Runs joined with their policy names (two small reads; the server already scopes both to the caller + the shared example). */
export async function loadRunList(signal?: AbortSignal): Promise<RunListItem[]> {
  const [r, p] = await Promise.all([
    api<{ runs: Omit<RunListItem, 'policy_name' | 'read_only'>[] }>('/api/test-runs', { signal }),
    api<{ policies: { id: string; name: string; read_only: boolean }[] }>('/api/policies', { signal }),
  ]);
  const byId = new Map(p.policies.map((x) => [x.id, x]));
  return r.runs.map((x) => ({ ...x, policy_name: byId.get(x.policy_id)?.name ?? x.policy_id, read_only: byId.get(x.policy_id)?.read_only ?? false }));
}
