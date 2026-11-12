import { begin, runFor } from '@/lib/api';
import { respond, type IdParams } from '@/lib/http';
import { executeRun } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** POST /api/test-runs/:id/execute — LANE 1: full shadow run (deterministic engine + simulated adapter), invariants, impact, release recommendation. Idempotent. */
export async function POST(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'heavy');
    await runFor(ctx, session, id, 'write');
    return { report: await executeRun(ctx, id) };
  });
}
