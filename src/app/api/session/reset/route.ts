import { begin } from '@/lib/api';
import { respond } from '@/lib/http';
import { requireSession, resetSessionData } from '@/lib/security/guard';

export const dynamic = 'force-dynamic';

/** POST /api/session/reset — delete everything THIS session created (never the public example, never anyone else's data). */
export async function POST(req: Request) {
  return respond(async () => {
    const { ctx, session } = await begin(req, 'heavy');
    const s = requireSession(session);
    return { reset: true, deleted: await resetSessionData(ctx.store, s.sid) };
  });
}
