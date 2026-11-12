import { begin, runFor } from '@/lib/api';
import { readJson, respond, type IdParams } from '@/lib/http';
import { verifyPairInSandbox } from '@/lib/pipeline';
import { SandboxProofSchema } from '@/lib/validation/schemas';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/test-runs/:id/sandbox-proof { pair_id } — LANE 2: re-execute ONE twin pair against the configured adapter
 * (the real PayPal Sandbox when credentials exist) and attach the PayPal resource ids to the same scenarios.
 */
export async function POST(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'heavy');
    await runFor(ctx, session, id, 'write');
    const { pair_id } = await readJson(req, SandboxProofSchema);
    return { proof: await verifyPairInSandbox(ctx, id, pair_id, session!.actor) };
  });
}
