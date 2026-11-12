import { begin, runFor } from '@/lib/api';
import { respond, type IdParams } from '@/lib/http';
import { runAllStages } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** POST /api/test-runs/:id/resume — continue a partial or failed run from its last completed stage (safe to repeat). */
export async function POST(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'heavy');
    await runFor(ctx, session, id, 'write');
    const report = await runAllStages(ctx, id);
    return { resumed: true, release_decision: report.release.decision };
  });
}
