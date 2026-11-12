import { NextResponse } from 'next/server';
import { getContext } from '@/lib/context';
import { describeRuntime } from '@/lib/pipeline';
import { DISCLOSURES, TAGLINE } from '@/lib/disclosures';
import { breakerStatus } from '@/lib/resilience';
import { queueStats } from '@/lib/jobs/queue';
import { authConfig } from '@/lib/security/session';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Unauthenticated liveness/readiness. Exposes modes, circuit-breaker state and queue depth — never secrets or data. */
export async function GET() {
  try {
    const ctx = await getContext();
    let database: 'ok' | 'error' = 'ok';
    try {
      await ctx.store.ping();
    } catch {
      database = 'error';
    }
    const cfg = authConfig();
    const dependencies = breakerStatus();
    const open = dependencies.filter((d) => d.state === 'open');
    const ok = database === 'ok' && !cfg.misconfigured;
    const queue = database === 'ok' ? await queueStats(ctx.store).catch(() => null) : null;
    return NextResponse.json(
      {
        ok,
        status: !ok ? 'unavailable' : open.length ? 'degraded' : 'healthy',
        runtime: describeRuntime(ctx),
        checks: { database, access_control: cfg.misconfigured ? 'misconfigured' : cfg.required ? 'passcode' : 'open (local development)' },
        dependencies, // circuit-breaker status for PayPal / OpenAI
        queue,
        auth: { required: cfg.required, configured: !cfg.misconfigured },
        disclosures: DISCLOSURES,
        tagline: TAGLINE,
      },
      { status: ok ? 200 : 503 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
