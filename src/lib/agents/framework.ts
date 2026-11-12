import type { z } from 'zod';
import type { LlmClient } from './llm';
import type { Store } from '../store/types';
import { nowIso, shortId, sha256 } from '../util';

export interface AgentCtx {
  store: Store;
  llm: LlmClient;
  runId?: string | null;
  /** Daily AI budget gate. When it answers false the agent uses its deterministic fallback (no LLM call is made). */
  allowLlm?: () => Promise<boolean>;
}

export type AgentStatus = 'deterministic' | 'ok' | 'ok_with_corrections' | 'fallback_guard_rejected' | 'fallback_error' | 'fallback_quota';

export interface AgentDef<I, O> {
  name: string;
  schemaName: string;
  schema: z.ZodType<O>;
  system: string;
  user(input: I): string;
  /** Deterministic implementation: used with no API key, and whenever the LLM output is rejected. */
  fallback(input: I): O;
  /** Deterministic validation. May correct the output (problems listed) or reject it (→ fallback). */
  guard?(output: O, input: I): { output: O; problems: string[]; reject?: boolean };
}

export interface AgentResult<O> {
  output: O;
  status: AgentStatus;
  problems: string[];
}

/**
 * AI proposes → code validates. Every call is recorded in agent_runs with an input hash,
 * the model used and how the output was treated.
 */
export async function runAgent<I, O>(ctx: AgentCtx, def: AgentDef<I, O>, input: I): Promise<AgentResult<O>> {
  let output: O;
  let status: AgentStatus;
  let problems: string[] = [];

  if (ctx.llm.mode === 'deterministic') {
    output = def.fallback(input);
    status = 'deterministic';
  } else if (ctx.allowLlm && !(await ctx.allowLlm())) {
    output = def.fallback(input);
    status = 'fallback_quota';
    problems = ['daily AI call cap reached; used the deterministic fallback'];
  } else {
    try {
      const raw = await ctx.llm.structured({ agent: def.name, system: def.system, user: def.user(input), schema: def.schema, schemaName: def.schemaName });
      const parsed = def.schema.safeParse(raw);
      if (!parsed.success) throw new Error(`schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      const g = def.guard ? def.guard(parsed.data, input) : { output: parsed.data, problems: [] as string[], reject: false };
      if (g.reject) {
        output = def.fallback(input);
        status = 'fallback_guard_rejected';
        problems = g.problems;
      } else {
        output = g.output;
        problems = g.problems;
        status = problems.length ? 'ok_with_corrections' : 'ok';
      }
    } catch (e) {
      output = def.fallback(input);
      status = 'fallback_error';
      problems = [e instanceof Error ? e.message : String(e)];
    }
  }

  await ctx.store.insert('agent_runs', {
    id: shortId('agt'),
    test_run_id: ctx.runId ?? null,
    agent_name: def.name,
    input_hash: sha256(input as unknown),
    model: status === 'deterministic' || status.startsWith('fallback') ? `${ctx.llm.model}${status.startsWith('fallback') ? ' → deterministic fallback' : ''}` : ctx.llm.model,
    structured_output: output,
    status,
    notes_json: problems,
    created_at: nowIso(),
  });
  return { output, status, problems };
}
