import { NextResponse } from 'next/server';
import { begin, runFor } from '@/lib/api';
import { errorResponse, type IdParams } from '@/lib/http';
import { getRunBundle } from '@/lib/pipeline';
import { renderReportHtml } from '@/lib/report/html';

export const dynamic = 'force-dynamic';

/** GET /api/test-runs/:id/report[?format=json][&download=1] — HTML release report (PDF is optional / out of scope). */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const { ctx, session } = await begin(req, 'read', true);
    await runFor(ctx, session, id, 'read');
    const url = new URL(req.url);
    const bundle = await getRunBundle(ctx, id);
    if (url.searchParams.get('format') === 'json') {
      const { owner_session: _o, ...run } = bundle.run;
      const { owner_session: _p, ...policy } = bundle.policy;
      return NextResponse.json({ ...bundle, run, policy });
    }
    const verdict = bundle.report?.release.decision ?? 'INCOMPLETE';
    const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };
    if (url.searchParams.get('download')) headers['Content-Disposition'] = `attachment; filename="policytwin-report-${id}-${verdict}.html"`;
    return new NextResponse(renderReportHtml(bundle), { headers });
  } catch (e) {
    return errorResponse(e);
  }
}
