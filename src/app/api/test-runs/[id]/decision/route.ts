import { begin, runFor } from '@/lib/api';
import { readJson, respond, type IdParams } from '@/lib/http';
import { recordHumanDecision } from '@/lib/pipeline';
import { HumanDecisionSchema } from '@/lib/validation/schemas';

export const dynamic = 'force-dynamic';

/** POST { decision: "approve" | "reject", note? } — the final release decision is always a human's; the actor is derived from the session. */
export async function POST(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'write');
    await runFor(ctx, session, id, 'write');
    const b = await readJson(req, HumanDecisionSchema);
    return recordHumanDecision(ctx, id, { decision: b.decision, actor: session!.actor, note: b.note });
  });
}
