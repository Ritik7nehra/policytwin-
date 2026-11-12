import { begin, runFor } from '@/lib/api';
import { respond, type IdParams } from '@/lib/http';
import { getRunBundle } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'read', true);
    await runFor(ctx, session, id, 'read');
    const b = await getRunBundle(ctx, id);
    const { owner_session: _o, ...run } = b.run;
    const { owner_session: _p, ...policy } = b.policy;
    return { ...b, run, policy };
  });
}
