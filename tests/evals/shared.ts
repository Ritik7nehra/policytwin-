import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PolicySchema, type Policy } from '@/lib/policy/schema';

/**
 * Policy Reader evals. The expectations in policies.json are written from what each sentence MEANS,
 * not from what the reader happens to output. Offline (deterministic) by default;
 * with EVAL_LIVE=1 and OPENAI_API_KEY the same cases run through the real OpenAI Policy Reader agent.
 */
export interface Expect {
  trigger?: string; action?: string; maximum_amount?: number | null; currency?: string | null; threshold_inclusive?: boolean; condition?: string;
  product_scope?: Partial<Policy['product_scope']>;
  currency_handling?: string; dispute_handling?: string; retry_handling?: string; duplicate_event_handling?: string;
  exceptions?: string[]; exceptions_mention?: string[];
  ambiguities_include?: string[]; ambiguities_exclude?: string[];
}
export interface Case { id: string; text: string; context: string; expect: Expect }
export const CASES: Case[] = JSON.parse(readFileSync(path.resolve(__dirname, 'policies.json'), 'utf8'));

export function assertPolicyMatches(p: Policy, e: Expect, c_text?: string) {
  expect(PolicySchema.safeParse(p).success, 'output must validate against the policy schema').toBe(true);
  for (const k of ['trigger', 'action', 'maximum_amount', 'currency', 'threshold_inclusive', 'condition', 'currency_handling', 'dispute_handling', 'retry_handling', 'duplicate_event_handling'] as const) {
    if (k in e) expect(p[k], k).toEqual((e as Record<string, unknown>)[k]);
  }
  if (e.product_scope) for (const [k, v] of Object.entries(e.product_scope)) expect(p.product_scope[k as keyof Policy['product_scope']], `product_scope.${k}`).toBe(v);
  if (e.exceptions) expect(p.exceptions, 'exceptions must be exactly those stated — none invented').toEqual(e.exceptions);
  for (const m of e.exceptions_mention ?? []) expect(p.exceptions.join(' ').toLowerCase(), 'stated exception kept').toContain(m);
  for (const c of e.ambiguities_include ?? []) expect(p.ambiguity_codes, `should flag ${c}`).toContain(c);
  for (const c of e.ambiguities_exclude ?? []) expect(p.ambiguity_codes, `should NOT flag ${c}`).not.toContain(c);
  // Never invent an exception: every recorded exception must be a sentence that exists in the source text.
  const source = (c_text ?? '').replace(/\s+/g, ' ');
  if (c_text !== undefined) for (const ex of p.exceptions) expect(source, `exception "${ex}" must be quoted from the policy text`).toContain(ex);
  // The human-readable list and the code list stay in step.
  expect(p.ambiguities.length).toBeGreaterThanOrEqual(p.ambiguity_codes.length);
}

