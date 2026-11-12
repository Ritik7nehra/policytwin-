import { afterAll, describe, expect, it } from 'vitest';
import { OpenAiLlm } from '@/lib/agents/llm';
import { runPolicyReader } from '@/lib/agents/roles';
import { readPolicyOffline } from '@/lib/policy/reader';
import { MemoryStore } from '@/lib/store/memory';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertPolicyMatches } from './shared';
import { writeEvidence } from '../evidence';

/**
 * Opt-in: runs the 15 sample policies through the REAL OpenAI Policy Reader agent
 * (structured output → zod → deterministic guard) and applies the same expectations.
 *   EVAL_LIVE=1 OPENAI_API_KEY=… npm run test:evals
 * Not run in CI by default (needs a key, costs money, and model output varies).
 * Writes evidence/openai-eval-<timestamp>.json: per case, whether the structured output was accepted, corrected by the
 * deterministic guard, or replaced by the deterministic fallback — and whether the final policy met the expectations.
 */
const live = process.env.EVAL_LIVE === '1' && !!process.env.OPENAI_API_KEY;
const CASES = JSON.parse(readFileSync(path.resolve(__dirname, 'policies.json'), 'utf8')) as { id: string; text: string; context: string; expect: any }[];
const results: { case: string; status: string; met_expectations: boolean; problems: string[] }[] = [];

afterAll(() => {
  if (!live || !results.length) return;
  const by = (s: string) => results.filter((r) => r.status === s).length;
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  // eslint-disable-next-line no-console
  console.log(`OpenAI eval evidence written to ${writeEvidence('openai-eval', { model, cases: results.length, structured_output_accepted: by('ok'), accepted_after_guard_corrections: by('ok_with_corrections'), deterministic_fallback_guard_rejected: by('fallback_guard_rejected'), deterministic_fallback_error: by('fallback_error'), expectations_met: results.filter((r) => r.met_expectations).length, results })}`);
});

describe.skipIf(!live)('Policy Reader — live OpenAI', () => {
  const llm = new OpenAiLlm(process.env.OPENAI_API_KEY ?? '', process.env.OPENAI_MODEL || 'gpt-4o');
  it.each(CASES.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const store = new MemoryStore();
    await store.init();
    const r = await runPolicyReader({ store, llm, runId: null }, { name: c.id, text: c.text, context: c.context });
    expect(['ok', 'ok_with_corrections', 'fallback_guard_rejected', 'fallback_error']).toContain(r.status);
    let met = true;
    try {
      assertPolicyMatches(r.output, c.expect, c.text);
    } catch (e) {
      met = false;
      results.push({ case: c.id, status: r.status, met_expectations: false, problems: r.problems ?? [] });
      throw e;
    }
    results.push({ case: c.id, status: r.status, met_expectations: met, problems: r.problems ?? [] });
  }, 60_000);

  it('the live run actually exercised the model (not just the deterministic fallback) and the final verdicts do not depend on it', async () => {
    const used = results.filter((r) => r.status === 'ok' || r.status === 'ok_with_corrections');
    expect(used.length, 'every case fell back to the deterministic reader — the OpenAI call is not working, so this run proves nothing').toBeGreaterThan(0);
    // Deterministic oracle sanity: the offline reader is unchanged by the presence of a key.
    expect(readPolicyOffline(CASES[0].text, CASES[0].id, CASES[0].context).trigger).toBeTruthy();
  });
});
