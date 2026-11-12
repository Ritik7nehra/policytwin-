import { begin, policyFor } from '@/lib/api';
import { readJson, respond } from '@/lib/http';
import { createTestRun, runAllStages } from '@/lib/pipeline';
import { assertRunQuota, requireSession } from '@/lib/security/guard';
import { PUBLIC_OWNER } from '@/lib/security/session';
import { RunCreateSchema } from '@/lib/validation/schemas';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/test-runs — create a run comparing two policy versions.
 * Body: { policy_id, version_a_id, version_b_id, adversarial?, run_all? }
 * With run_all=true the whole pipeline (twins → evaluate → execute) runs in this request.
 */
export async function POST(req: Request) {
  return respond(async () => {
    const { ctx, session } = await begin(req, 'heavy');
    const s = requireSession(session);
    const b = await readJson(req, RunCreateSchema);
    await policyFor(ctx, s, b.policy_id, 'write');
    await assertRunQuota(ctx.store, s, ctx.limits);
    const run = await createTestRun(ctx, { policy_id: b.policy_id, version_a_id: b.version_a_id, version_b_id: b.version_b_id, adversarial: b.adversarial, created_by: s.actor });
    if (b.run_all) await runAllStages(ctx, run.id);
    const { owner_session: _o, ...pub } = (await ctx.store.get('test_runs', run.id))!;
    return pub;
  }, 201);
}

export async function GET(req: Request) {
  return respond(async () => {
    const { ctx, session } = await begin(req, 'read', true);
    const runs = (await ctx.store.list('test_runs')).filter((r) => r.owner_session === PUBLIC_OWNER || (session && r.owner_session === session.sid));
    return { runs: runs.reverse().map(({ report_json: _r, owner_session: _o, ...r }) => r) };
  });
}
