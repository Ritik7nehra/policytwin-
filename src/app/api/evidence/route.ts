import { begin } from '@/lib/api';
import { respond } from '@/lib/http';
import { buildProofs, type RunReport } from '@/lib/pipeline';
import { PUBLIC_OWNER } from '@/lib/security/session';

export const dynamic = 'force-dynamic';

/**
 * GET /api/evidence — what was actually executed, per run, split by lane. Counts only; the full (sanitized) request and
 * response bodies live on the run's own evidence pages. Scoped to the caller's runs plus the shared example.
 */
export async function GET(req: Request) {
  return respond(async () => {
    const { ctx, session } = await begin(req, 'read', true);
    const runs = (await ctx.store.list('test_runs')).filter((r) => r.owner_session === PUBLIC_OWNER || (session !== null && r.owner_session === session.sid));
    const policies = new Map((await ctx.store.list('policies')).map((p) => [p.id, p.name]));
    const out = [];
    for (const r of runs.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 30)) {
      const [execs, invs, proofs] = await Promise.all([
        ctx.store.list('paypal_executions', { test_run_id: r.id }),
        ctx.store.list('invariant_results', { test_run_id: r.id }),
        buildProofs(ctx.store, r.id),
      ]);
      const shadow = execs.filter((e) => e.lane === 'shadow');
      const sp = execs.filter((e) => e.lane === 'sandbox_proof');
      const rep = (r.report_json as RunReport | null) ?? null;
      out.push({
        run_id: r.id,
        policy_id: r.policy_id,
        policy_name: policies.get(r.policy_id) ?? r.policy_id,
        stage: r.stage,
        release_decision: r.release_decision,
        started_at: r.started_at,
        read_only: r.owner_session === PUBLIC_OWNER,
        shadow: {
          mode: 'simulated' as const,
          operations: shadow.length,
          failed_operations: shadow.filter((e) => e.status === 'FAILED').length,
          invariant_checks: invs.filter((i) => i.lane === 'shadow' && i.evidence_json.applicable).length,
          invariant_failures: invs.filter((i) => i.lane === 'shadow' && i.evidence_json.applicable && !i.passed).length,
        },
        sandbox_proof: {
          pairs: proofs.map((p) => ({ pair_id: p.pair_id, mode: p.mode, agrees_with_shadow: p.agrees_with_shadow, recorded_at: p.recorded_at, errors: p.errors.length })),
          operations: sp.length,
        },
        pairs_total: rep?.release.counts.pairs ?? null,
      });
    }
    return { runs: out };
  });
}
