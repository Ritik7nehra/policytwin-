import { NextResponse } from 'next/server';
import { getContext } from '@/lib/context';
import { BadRequestError, RateLimitedError } from '@/lib/errors';
import { errorResponse, readBodyText } from '@/lib/http';
import { normalizeEvent, processWebhookEvent, type WebhookEvent } from '@/lib/paypal/webhooks';
import { storeWebhookState } from '@/lib/paypal/webhook-store';
import { limiter } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/session';
import { LIMITS, WebhookEnvelopeSchema } from '@/lib/validation/schemas';
import { drainWebhookJobs } from '@/lib/jobs/worker';
import { log } from '@/lib/security/log';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/paypal
 *   1. receive (size-capped)  2. validate envelope  3. verify the PayPal signature (nothing is stored before this)
 *   4. store once with a lifecycle status + durable job  5. fetch the canonical PayPal resource
 *   6. update local state only if it is newer  7. acknowledge with 2xx.
 * A duplicate is ignored only when the stored event is PROCESSED; a failed canonical fetch leaves the event
 * FAILED_RETRYABLE (exponential backoff via the jobs table, or on PayPal's redelivery).
 */
export async function POST(req: Request) {
  try {
    const rl = limiter().hit('webhook', `ip:${clientIp(req)}`);
    if (!rl.ok) throw new RateLimitedError(rl.retryAfterSec);
    const raw = await readBodyText(req, LIMITS.webhookBody);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'body is not valid JSON', code: 'BAD_REQUEST' }, { status: 400 });
    }
    const env = WebhookEnvelopeSchema.safeParse(parsed);
    if (!env.success) throw new BadRequestError('not a PayPal webhook event (id, event_type and resource.id are required)');
    const event = env.data as unknown as WebhookEvent;
    const ctx = await getContext();
    const headers = Object.fromEntries(req.headers.entries());
    // May throw DependencyError (PayPal unreachable) → 503, so PayPal redelivers instead of the event being lost.
    if (!(await ctx.adapter.verifyWebhookSignature(headers, parsed))) {
      log('warn', 'webhook signature verification failed', { event_id: event.id, ip: clientIp(req) });
      return NextResponse.json({ error: 'webhook signature verification failed', code: 'UNAUTHENTICATED' }, { status: 401 });
    }
    const result = await processWebhookEvent({ state: storeWebhookState(ctx.store), adapter: ctx.adapter, mode: 'canonical_dedupe' }, normalizeEvent(event));
    // Opportunistically retry any other due events (the in-process poller and PayPal redeliveries do the same).
    void drainWebhookJobs(ctx, { limit: 3 }).catch(() => undefined);
    return NextResponse.json({ received: true, result }, { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
