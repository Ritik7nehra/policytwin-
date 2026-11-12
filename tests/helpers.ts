import { readPolicyOffline } from '@/lib/policy/reader';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { repairPolicyDeterministic } from '@/lib/analysis/repair';
import type { Policy } from '@/lib/policy/schema';
import { baseTx } from '@/lib/twins/generator';
import type { TxInput } from '@/lib/types';
import { MemoryStore } from '@/lib/store/memory';
import { SimulatedPayPal } from '@/lib/paypal/simulated';
import { OfflineLlm } from '@/lib/agents/llm';
import type { Ctx } from '@/lib/pipeline';

const CONTEXT = `${DEMO_POLICY_INPUT.name}. ${DEMO_POLICY_INPUT.current_policy}`;

export const policyA = (): Policy => readPolicyOffline(DEMO_POLICY_INPUT.current_policy, 'Version A', CONTEXT);
export const policyB = (): Policy => readPolicyOffline(DEMO_POLICY_INPUT.proposed_policy, 'Version B', CONTEXT);
export const policyC = (): Policy => repairPolicyDeterministic(policyB(), []).policy;

export const tx = (policy: Policy, o: Partial<TxInput> = {}): TxInput => baseTx(policy, o);

export async function offlineCtx(): Promise<Ctx> {
  const store = new MemoryStore();
  await store.init();
  return { store, adapter: new SimulatedPayPal(), llm: new OfflineLlm() };
}
