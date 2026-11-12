/**
 * CLI walkthrough of the full spec demo:
 *   submit policy → twins → compare A vs B → execute in the (simulated or real) Sandbox
 *   → deterministic checks → BLOCK → repair → human approves → re-run → PASS report.
 *
 *   npm run demo
 *
 * Uses whatever is configured in the environment (.env values are NOT auto-loaded;
 * export them or use `node --env-file=.env`). With nothing set it runs fully offline.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildContext } from '../src/lib/context';
import { DEMO_POLICY_INPUT } from '../src/lib/policy/demo';
import { analyzePolicy, approveRepairAndRerun, createPolicy, createTestRun, describeRuntime, getRunBundle, recordHumanDecision, runAllStages } from '../src/lib/pipeline';
import { renderReportHtml } from '../src/lib/report/html';
import { DISCLOSURES } from '../src/lib/disclosures';

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

async function show(ctx: Awaited<ReturnType<typeof buildContext>>, runId: string, title: string) {
  const b = await getRunBundle(ctx, runId);
  const r = b.report!;
  console.log(`\n━━ ${title} — ${runId} — ${r.release.decision} ━━`);
  for (const p of r.pair_results) {
    console.log(`${pad(p.pair_id, 8)}${pad(p.label, 52)}${pad(`${p.new_base}/${p.new_twin}`, 26)}${pad(p.outcome, 22)}${pad(p.severity, 9)}${p.failed_invariants.join(',')}`);
  }
  for (const x of r.release.reasons) console.log('  •', x);
  return b;
}

(async () => {
  const ctx = await buildContext(process.env);
  const rt = describeRuntime(ctx);
  console.log('PolicyTwin demo');
  console.log(`  PayPal: ${rt.paypal_label}\n  AI:     ${rt.ai_mode === 'openai' ? rt.ai_model : 'deterministic agents (no OPENAI_API_KEY)'}\n  DB:     ${rt.db_mode}`);
  DISCLOSURES.forEach((d) => console.log('  ·', d));

  const { policy, version_a, version_b } = await createPolicy(ctx, DEMO_POLICY_INPUT);
  await analyzePolicy(ctx, policy.id);
  const run1 = await createTestRun(ctx, { policy_id: policy.id, version_a_id: version_a.id, version_b_id: version_b.id });
  await runAllStages(ctx, run1.id);
  const b1 = await show(ctx, run1.id, 'Version A vs proposed Version B');

  console.log('\nProposed correction (Version C):\n ', b1.report!.repair?.source_text);
  await recordHumanDecision(ctx, run1.id, { decision: 'reject', actor: 'release.manager (demo)', note: 'Blocked: apply the repair and re-run.' });
  const run2 = await approveRepairAndRerun(ctx, run1.id, 'release.manager (demo)', 'Approve the proposed correction and re-run all scenarios.');
  const b2 = await show(ctx, run2.id, 'Version A vs corrected Version C (re-run)');

  mkdirSync('out', { recursive: true });
  for (const b of [b1, await getRunBundle(ctx, run1.id), b2]) void b;
  writeFileSync(`out/report-${run1.id}-BLOCK.html`, renderReportHtml(await getRunBundle(ctx, run1.id)));
  writeFileSync(`out/report-${run2.id}-${b2.report!.release.decision}.html`, renderReportHtml(b2));
  console.log(`\nReports written to ./out (open the .html files). Human approval of Version C's release is still pending — PolicyTwin only recommends.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
