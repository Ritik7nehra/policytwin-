import { begin, policyFor } from '@/lib/api';
import { readJson, respond, type IdParams } from '@/lib/http';
import { addVersion } from '@/lib/pipeline';
import { VersionCreateSchema } from '@/lib/validation/schemas';

export const dynamic = 'force-dynamic';

/** POST /api/policies/:id/versions — add another version of the policy text (e.g. a corrected Version C). */
export async function POST(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'write');
    await policyFor(ctx, session, id, 'write');
    const body = await readJson(req, VersionCreateSchema);
    return addVersion(ctx, id, { source_text: body.source_text, label: body.label }, session!.actor);
  }, 201);
}
