import { begin, runFor } from '@/lib/api';
import { respond, type IdParams } from '@/lib/http';
import { generateTwins } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Idempotent: repeating the call returns the stored result; an illegal order answers 409. */
export async function POST(req: Request, { params }: IdParams) {
  return respond(async () => {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'heavy');
    await runFor(ctx, session, id, 'write');
    return { pairs: await generateTwins(ctx, id) };
  });
}
