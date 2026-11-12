import { DEMO_POLICY_INPUT } from './policy/demo';
import { OfflineLlm } from './agents/llm';
import { approveRepairAndRerun, runDemoFlow, type Ctx } from './pipeline';
import { PUBLIC_OWNER } from './security/session';
import { isUniqueViolation } from './store/errors';
import { log } from './security/log';

export const PUBLIC_EXAMPLE_POLICY_ID = 'pol_public_example';
const BY = 'PolicyTwin (read-only example)';

/**
 * Seeds one shared, READ-ONLY example (BLOCK → approved repair → PASS) using the deterministic engine and the
 * simulator only (no AI credits, no Sandbox calls). Anyone can open its report; nobody can modify it.
 */
export async function ensurePublicExamples(ctx: Ctx): Promise<void> {
  if (await ctx.store.get('policies', PUBLIC_EXAMPLE_POLICY_ID)) return;
  const offline: Ctx = { ...ctx, llm: new OfflineLlm(), limits: undefined };
  try {
    const { run } = await runDemoFlow(offline, DEMO_POLICY_INPUT, { ownerSession: PUBLIC_OWNER, actor: BY, policyId: PUBLIC_EXAMPLE_POLICY_ID });
    await approveRepairAndRerun(offline, run.id, BY, 'Example: the proposed repair was approved and re-run.');
  } catch (e) {
    if (isUniqueViolation(e)) return; // another instance seeded it first
    throw e;
  }
  log('info', 'public example seeded', { policy_id: PUBLIC_EXAMPLE_POLICY_ID });
}

export async function publicExampleRunIds(ctx: Ctx): Promise<string[]> {
  const runs = await ctx.store.list('test_runs', { policy_id: PUBLIC_EXAMPLE_POLICY_ID });
  return runs.map((r) => r.id);
}
