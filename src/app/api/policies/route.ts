import { begin } from '@/lib/api';
import { readJson, respond } from '@/lib/http';
import { createPolicy } from '@/lib/pipeline';
import { assertPolicyQuota, requireSession } from '@/lib/security/guard';
import { PUBLIC_OWNER } from '@/lib/security/session';
import { PolicyIntakeSchema } from '@/lib/validation/schemas';
import type { PolicyIntake } from '@/lib/policy/demo';

export const dynamic = 'force-dynamic';

/** GET /api/policies — the caller's own policies plus the read-only public example. */
export async function GET(req: Request) {
  return respond(async () => {
    const { ctx, session } = await begin(req, 'read', true);
    const [policies, runs] = await Promise.all([ctx.store.list('policies'), ctx.store.list('test_runs')]);
    const visible = policies.filter((p) => p.owner_session === PUBLIC_OWNER || (session && p.owner_session === session.sid));
    return {
      policies: visible.reverse().map(({ owner_session, ...p }) => ({
        ...p,
        read_only: owner_session === PUBLIC_OWNER,
        runs: runs.filter((r) => r.policy_id === p.id).map((r) => ({ id: r.id, status: r.status, stage: r.stage, release_decision: r.release_decision, started_at: r.started_at, parent_run_id: r.parent_run_id })),
      })),
    };
  });
}

/** POST /api/policies — Step 1: create a policy change (current + proposed versions) in the caller's own workspace. */
export async function POST(req: Request) {
  return respond(async () => {
    const { ctx, session } = await begin(req, 'write');
    const s = requireSession(session);
    const intake = (await readJson(req, PolicyIntakeSchema)) as PolicyIntake & { created_by?: string };
    await assertPolicyQuota(ctx.store, s, ctx.limits);
    const { created_by: _ignored, ...clean } = intake; // a client-supplied author is never trusted: the server derives it
    return createPolicy(ctx, clean, s.actor, s.sid);
  }, 201);
}
