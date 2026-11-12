import { begin, policyFor } from '@/lib/api';
import { respond, type IdParams } from '@/lib/http';
import { analyzePolicy } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';

/** POST /api/policies/:id/analyze — Policy Reader + Impact Mapper agents (Step 2). */
export async function POST(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'heavy');
    await policyFor(ctx, session, id, 'write');
    return { versions: await analyzePolicy(ctx, id) };
  });
}
