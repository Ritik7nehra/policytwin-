import { api } from './client';
import type { PolicyIntake } from './policy/demo';

/**
 * The seven visible stages of a test run. The server-side stage machine is idempotent, so retrying a failed step
 * (or the whole flow with the same FlowState) resumes exactly where it stopped and never duplicates work.
 */
export const STEP_IDS = ['policy', 'read', 'run', 'twins', 'evaluate', 'execute', 'verdict'] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped';

export const STEP_INFO: Record<StepId, { label: string; detail: string; actor: 'code' | 'ai' | 'simulator' | 'human' }> = {
  policy: { label: 'Create policy change', detail: 'Save the current and proposed policy text as Version A and Version B.', actor: 'code' },
  read: { label: 'Read & structure the policy', detail: 'AI proposes a structured reading; a schema validates it. The text itself is never executed.', actor: 'ai' },
  run: { label: 'Open a test run', detail: 'Pin Version A and Version B so the comparison cannot drift.', actor: 'code' },
  twins: { label: 'Generate transaction twins', detail: 'Matched pairs that differ in exactly one field. Code rejects any pair that changes more.', actor: 'ai' },
  evaluate: { label: 'Evaluate Version A and B', detail: 'The deterministic engine decides every scenario under both policies.', actor: 'code' },
  execute: { label: 'Execute payment operations', detail: 'Create → capture → refund → webhooks on the simulator, then check financial invariants.', actor: 'simulator' },
  verdict: { label: 'Compile the release recommendation', detail: 'Deterministic gate: PASS, REVIEW or BLOCK. A human still decides.', actor: 'code' },
};

export interface FlowState {
  policyId?: string;
  versionA?: string;
  versionB?: string;
  runId?: string;
  done: StepId[];
  verdict?: 'PASS' | 'REVIEW' | 'BLOCK' | null;
}

export type FlowIntake = Omit<PolicyIntake, 'affected_products' | 'target_markets'> & { affected_products: string[]; target_markets: string[] };

export class FlowError extends Error {
  constructor(
    message: string,
    readonly step: StepId,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FlowError';
  }
}

interface PolicyBundle {
  policy: { id: string };
  versions: { id: string; label: 'A' | 'B' | 'C'; structured_policy_json: unknown }[];
}

/**
 * Run (or resume) the flow. `state.done` lists steps already completed; they are skipped. Progress is reported through `on`.
 */
export async function runFlow(
  opts: { intake?: FlowIntake; adversarial: boolean; state: FlowState },
  on: (step: StepId, status: StepStatus, state: FlowState) => void,
  signal?: AbortSignal,
): Promise<FlowState> {
  const st = opts.state;
  const mark = (s: StepId) => {
    if (!st.done.includes(s)) st.done.push(s);
    on(s, 'done', st);
  };
  const step = async (id: StepId, fn: () => Promise<void>) => {
    if (st.done.includes(id)) {
      on(id, 'done', st);
      return;
    }
    on(id, 'active', st);
    try {
      await fn();
    } catch (e) {
      on(id, 'error', st);
      throw new FlowError(e instanceof Error ? e.message : String(e), id, e);
    }
    mark(id);
  };

  // Existing policy → the first two stages were completed earlier.
  if (!opts.intake && st.policyId) {
    for (const s of ['policy', 'read'] as const) {
      if (!st.done.includes(s)) st.done.push(s);
      on(s, 'skipped', st);
    }
  }

  await step('policy', async () => {
    if (!opts.intake) throw new Error('No policy to create');
    const created = await api<{ policy: { id: string } }>('/api/policies', { json: opts.intake, signal });
    st.policyId = created.policy.id;
  });
  await step('read', async () => {
    await api(`/api/policies/${st.policyId}/analyze`, { method: 'POST', json: {}, signal });
    const b = await api<PolicyBundle>(`/api/policies/${st.policyId}`, { signal });
    st.versionA = b.versions.find((v) => v.label === 'A')?.id;
    st.versionB = b.versions.find((v) => v.label === 'B')?.id;
    if (!st.versionA || !st.versionB) throw new Error('The policy has no Version A / Version B');
  });
  if (!st.versionA || !st.versionB) {
    const b = await api<PolicyBundle>(`/api/policies/${st.policyId}`, { signal });
    st.versionA = b.versions.find((v) => v.label === 'A')?.id;
    st.versionB = b.versions.find((v) => v.label === 'B')?.id;
  }
  await step('run', async () => {
    const run = await api<{ id: string }>('/api/test-runs', { json: { policy_id: st.policyId, version_a_id: st.versionA, version_b_id: st.versionB, adversarial: opts.adversarial }, signal });
    st.runId = run.id;
  });
  await step('twins', async () => void (await api(`/api/test-runs/${st.runId}/generate-twins`, { method: 'POST', json: {}, signal })));
  await step('evaluate', async () => void (await api(`/api/test-runs/${st.runId}/evaluate`, { method: 'POST', json: {}, signal })));
  await step('execute', async () => void (await api(`/api/test-runs/${st.runId}/execute`, { method: 'POST', json: {}, signal })));
  await step('verdict', async () => {
    const run = await api<{ run: { release_decision: 'PASS' | 'REVIEW' | 'BLOCK' | null; stage: string } }>(`/api/test-runs/${st.runId}`, { signal });
    if (run.run.stage !== 'COMPLETED' && run.run.stage !== 'DECIDED') throw new Error(`The run stopped at stage ${run.run.stage}`);
    st.verdict = run.run.release_decision;
  });
  return st;
}

export const emptyFlow = (policyId?: string): FlowState => ({ done: [], policyId });
