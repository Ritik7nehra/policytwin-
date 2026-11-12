import { begin, runFor } from '@/lib/api';
import { readJson, respond, type IdParams } from '@/lib/http';
import { approveRepairAndRerun } from '@/lib/pipeline';
import { RepairApprovalSchema } from '@/lib/validation/schemas';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** A human approves the proposed repair; every scenario is re-run against the corrected Version C. The approver is the signed-in session. */
export async function POST(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'heavy');
    await runFor(ctx, session, id, 'write');
    const b = await readJson(req, RepairApprovalSchema);
    const run = await approveRepairAndRerun(ctx, id, session!.actor, b.note);
    return { run_id: run.id, release_decision: run.release_decision };
  });
}
