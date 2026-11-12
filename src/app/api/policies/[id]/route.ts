import { begin, policyFor } from '@/lib/api';
import { respond, type IdParams } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'read', true);
    const policy = await policyFor(ctx, session, id, 'read');
    const [versions, runs] = await Promise.all([ctx.store.list('policy_versions', { policy_id: policy.id }), ctx.store.list('test_runs', { policy_id: policy.id })]);
    const { owner_session, ...pub } = policy;
    return { policy: { ...pub, read_only: owner_session === 'public' }, versions, runs: runs.map(({ report_json: _r, owner_session: _o, ...r }) => r) };
  });
}
