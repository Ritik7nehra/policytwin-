import { begin } from '@/lib/api';
import { respond } from '@/lib/http';
import { describeRuntime, type RunReport } from '@/lib/pipeline';
import { PUBLIC_OWNER } from '@/lib/security/session';
import { PUBLIC_EXAMPLE_POLICY_ID, publicExampleRunIds } from '@/lib/examples';

export const dynamic = 'force-dynamic';

/**
 * GET /api/overview — real aggregates over what THIS caller can see: their own workspace plus the read-only example.
 * Nothing here is invented: every number is a count taken from stored runs and their reports.
 */
export async function GET(req: Request) {
  return respond(async () => {
    const { ctx, session } = await begin(req, 'read', true);
    const mine = (owner: string) => owner === PUBLIC_OWNER || (session !== null && owner === session.sid);
    const [allPolicies, allRuns] = await Promise.all([ctx.store.list('policies'), ctx.store.list('test_runs')]);
    const policies = allPolicies.filter((p) => mine(p.owner_session));
    const runs = allRuns.filter((r) => mine(r.owner_session));
    const nameOf = new Map(policies.map((p) => [p.id, p.name]));
    const publicIds = new Set(policies.filter((p) => p.owner_session === PUBLIC_OWNER).map((p) => p.id));

    const verdicts = { PASS: 0, REVIEW: 0, BLOCK: 0 };
    const totals = { pairs: 0, passed_pairs: 0, critical_pairs: 0, invariant_failures: 0, scenarios: 0 };
    const recent_runs = [...runs]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .map((r) => {
        const rep = (r.report_json as RunReport | null) ?? null;
        const counts = rep?.release.counts ?? null;
        if (r.release_decision) verdicts[r.release_decision]++;
        if (counts) {
          totals.pairs += counts.pairs;
          totals.passed_pairs += counts.passed;
          totals.critical_pairs += counts.critical;
          totals.invariant_failures += counts.invariant_failures;
          totals.scenarios += counts.pairs * 2;
        }
        return {
          id: r.id,
          policy_id: r.policy_id,
          policy_name: nameOf.get(r.policy_id) ?? r.policy_id,
          release_decision: r.release_decision,
          stage: r.stage,
          status: r.status,
          started_at: r.started_at,
          parent_run_id: r.parent_run_id,
          read_only: publicIds.has(r.policy_id),
          headline: rep?.narrative.headline ?? null,
          counts,
          human_decision: rep?.human_decision ? { decision: rep.human_decision.decision, at: rep.human_decision.at } : null,
        };
      });

    const recent_policies = [...policies]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 8)
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        created_at: p.created_at,
        read_only: p.owner_session === PUBLIC_OWNER,
        runs: runs.filter((r) => r.policy_id === p.id).map((r) => ({ id: r.id, release_decision: r.release_decision, parent_run_id: r.parent_run_id, stage: r.stage })),
      }));

    return {
      scope: 'your workspace + the read-only example',
      totals: {
        policies: policies.length,
        runs: runs.length,
        completed_runs: runs.filter((r) => r.stage === 'COMPLETED' || r.stage === 'DECIDED').length,
        decided_runs: runs.filter((r) => r.stage === 'DECIDED').length,
        ...totals,
        verdicts,
      },
      recent_policies,
      recent_runs: recent_runs.slice(0, 12),
      public_example: { policy_id: PUBLIC_EXAMPLE_POLICY_ID, run_ids: await publicExampleRunIds(ctx).catch(() => []) },
      runtime: describeRuntime(ctx),
    };
  });
}
