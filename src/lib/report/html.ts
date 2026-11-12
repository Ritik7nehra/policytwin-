import type { RunBundle } from '../pipeline';
import { DISCLOSURES, PIPELINE_MOTTO, TAGLINE } from '../disclosures';
import { scrubString } from '../security/sanitize';

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Evidence values (ids, request ids) go through the same scrubber as everything else that leaves the server. */
const ev = (v: unknown): string => esc(scrubString(String(v ?? '')));

const COLORS = { PASS: ['#0f7b55', '#e3f4ec'], REVIEW: ['#a86400', '#fdf1d8'], BLOCK: ['#b42318', '#fde8e6'] } as const;
const SEV_COLOR: Record<string, string> = { none: '#0f7b55', medium: '#a86400', high: '#c2410c', critical: '#b42318' };

/** Standalone, print-friendly HTML release report. No external assets. */
export function renderReportHtml(b: RunBundle): string {
  const r = b.report;
  if (!r) return `<!doctype html><meta charset="utf-8"><title>PolicyTwin report</title><p>Run ${esc(b.run.id)} has not completed yet.</p>`;
  const verdict = r.release.decision;
  const [fg, bg] = COLORS[verdict];

  const matrix = r.pair_results
    .map((p) => {
      const pv = b.pairs.find((x) => x.pair_id === p.pair_id)!;
      const f = p.changed_field as keyof typeof pv.base.input;
      return `<tr>
        <td>${esc(p.pair_id)}<div class="mut">${esc(p.origin)}</div></td>
        <td><b>${esc(p.label)}</b><div class="mut">changes <code>${esc(p.changed_field)}</code>: ${esc(pv.base.input[f])} → ${esc(pv.twin.input[f])}</div></td>
        <td>${esc(p.old_base)} → ${esc(p.old_twin)}</td>
        <td>${esc(p.new_base)} → ${esc(p.new_twin)}</td>
        <td>${esc(p.outcome.replace(/_/g, ' '))}</td>
        <td style="color:${SEV_COLOR[p.severity]};font-weight:700">${esc(p.severity)}</td>
      </tr>`;
    })
    .join('');

  const findings = r.pair_results
    .filter((p) => p.severity !== 'none')
    .map((p) => {
      const text = r.narrative.finding_explanations.find((e) => e.pair_id === p.pair_id)?.text ?? p.explanation;
      return `<li><b>${esc(p.pair_id)} — ${esc(p.label)}</b> <span class="pill" style="background:${SEV_COLOR[p.severity]}">${esc(p.severity)}</span><br>${esc(text)}</li>`;
    })
    .join('');

  const invByCode = new Map<string, { name: string; pass: number; fail: number; na: number }>();
  for (const p of b.pairs)
    for (const s of [p.base, p.twin])
      for (const i of s.invariants.filter((x) => x.lane === 'shadow')) {
        const e = invByCode.get(i.invariant_code) ?? { name: i.evidence_json.name, pass: 0, fail: 0, na: 0 };
        if (!i.evidence_json.applicable) e.na++;
        else if (i.passed) e.pass++;
        else e.fail++;
        invByCode.set(i.invariant_code, e);
      }
  const invRows = [...invByCode.entries()]
    .map(([code, e]) => `<tr><td><code>${esc(code)}</code><div class="mut">${esc(e.name)}</div></td><td>${e.pass}</td><td style="color:${e.fail ? '#b42318' : 'inherit'};font-weight:${e.fail ? 700 : 400}">${e.fail}</td><td>${e.na}</td></tr>`)
    .join('');

  const impactRows = r.impact.rows
    .map((x) => `<tr><td>${esc(x.pair_id)} ${esc(x.label)}</td><td>${esc(x.kind === 'incorrect_refunds' ? 'potentially incorrect refunds' : 'exposure (ambiguous)')}</td><td>${x.count.toLocaleString('en-US')}</td><td>$${x.usd.toLocaleString('en-US')}</td></tr>`)
    .join('');

  const repair = r.repair
    ? `<h2>Recommended policy correction</h2>
       <p class="mut">Proposed by the Policy Repair agent (${esc(r.repair.generated_by)}). A human must approve it; it is then re-tested against every scenario.</p>
       <div class="grid2"><div><h3>Proposed (Version ${esc(b.version_b.label)})</h3><pre>${esc(b.version_b.source_text)}</pre></div>
       <div><h3>Corrected (Version C)</h3><pre>${esc(r.repair.source_text)}</pre></div></div>
       <table><thead><tr><th>Field</th><th>From</th><th>To</th><th>Why</th></tr></thead><tbody>
       ${r.repair.changes.map((c) => `<tr><td><code>${esc(c.field)}</code></td><td>${esc(c.from)}</td><td>${esc(c.to)}</td><td>${esc(c.reason)}</td></tr>`).join('')}
       </tbody></table>
       <p>${esc(r.repair.rationale)}</p>
       <p class="mut">Status: ${esc(r.repair.status)}${r.superseded_by ? ` — re-run as ${esc(r.superseded_by)}` : ''}</p>`
    : '';

  const human = r.human_decision
    ? `<p><b>${esc(r.human_decision.decision.toUpperCase())}</b> by ${esc(r.human_decision.actor)} at ${esc(r.human_decision.at)} (recommendation was ${esc(r.human_decision.release_at_decision)}).${r.human_decision.note ? ` Note: ${esc(r.human_decision.note)}` : ''}</p>`
    : '<p>No human release decision has been recorded yet. The recommendation above is not an approval.</p>';


  const proofs = b.sandbox_proofs ?? [];
  const lanesHtml = `<h2>Execution lanes &amp; provenance</h2>
<p><span class="pill" style="background:#475569">DETERMINISTIC</span> <span class="pill" style="background:#475569">SIMULATED</span> <b>Lane 1 — full shadow run.</b> All ${b.pairs.length * 2} scenarios were evaluated by the deterministic policy engine and executed against an <b>in-process payment simulator (not PayPal)</b>; every invariant was checked. This lane produced the release recommendation.</p>
${
  proofs.length
    ? `<p><b>Lane 2 — targeted PayPal Sandbox proof</b> for ${proofs.length} pair${proofs.length === 1 ? '' : 's'}. Resource ids below were returned by ${proofs.some((x) => x.mode === 'sandbox') ? 'the PayPal Sandbox (test money)' : 'the simulator — no Sandbox credentials were configured'}.</p>
<table><thead><tr><th>Pair / scenario</th><th>Provenance</th><th>Order</th><th>Capture</th><th>Refund(s)</th><th>Request ids</th><th>Agrees with Lane 1</th></tr></thead><tbody>${proofs
        .flatMap((pf) =>
          pf.scenarios.map(
            (sc) => `<tr><td>${ev(pf.pair_id)} · ${ev(sc.scenario_key)}</td><td><span class="pill" style="background:${sc.mode === 'sandbox' ? '#0b5cad' : '#475569'}">${sc.mode === 'sandbox' ? 'PAYPAL SANDBOX' : 'SIMULATED'}</span></td><td><code>${ev(sc.order_id ?? '—')}</code></td><td><code>${ev(sc.capture_id ?? '—')}</code></td><td><code>${ev(sc.refund_ids.join(', ') || '—')}</code></td><td class="mut">${sc.request_ids.map((x) => ev(x)).join('<br>') || '—'}</td><td>${sc.agrees_with_shadow ? 'yes' : `<b style="color:#b42318">NO — failed in this lane: ${ev(sc.failed_invariants.join(', ') || 'none')}</b>`}</td></tr>`,
          ),
        )
        .join('')}</tbody></table>${proofs.some((x) => x.errors.length) ? `<p class="mut">Errors: ${proofs.flatMap((x) => x.errors).map((x) => ev(x)).join('; ')}</p>` : ''}`
    : '<p class="mut">No pair has been verified in the PayPal Sandbox yet (Lane 2 is optional and targeted). Nothing in this report claims Sandbox verification.</p>'
}
<p class="mut">Card numbers, expiry dates, payer names, e-mail addresses and shipping details are never stored or shown; only method, endpoint, request id, amount, currency, resource id, HTTP status and issue code are kept as evidence.</p>`;

  const audit = b.audit.map((a) => `<tr><td>${esc(a.created_at)}</td><td>${esc(a.event_type)}</td><td>${esc(a.actor)}</td><td><code>${esc(a.payload_hash.slice(0, 12))}</code></td></tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PolicyTwin release report — ${esc(b.policy.name)} — ${esc(b.run.id)}</title>
<style>
 :root{--ink:#0b1b33;--mut:#64748b;--line:#e2ddd2;--paper:#f6f4ef}
 *{box-sizing:border-box} body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
 main{max-width:1040px;margin:0 auto;padding:32px 20px 64px} h1{font:700 28px/1.2 Georgia,serif;margin:0 0 4px} h2{font:700 20px Georgia,serif;margin:36px 0 8px} h3{font-size:14px;margin:12px 0 6px}
 .mut{color:var(--mut);font-size:13px} code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px} pre{white-space:pre-wrap;background:#fff;border:1px solid var(--line);padding:12px;border-radius:8px}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:13.5px} th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top} th{background:#faf8f3;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
 .banner{border-radius:12px;padding:18px 22px;margin:20px 0;border:1px solid ${fg};background:${bg};color:${fg}} .banner .v{font:800 34px/1 Georgia,serif;letter-spacing:.02em}
 .disc{border:1px dashed #a86400;background:#fffaf0;border-radius:10px;padding:12px 16px;font-size:13px} .disc ul{margin:6px 0 0;padding-left:18px}
 .badges span{display:inline-block;border:1px solid var(--line);background:#fff;border-radius:999px;padding:2px 10px;font-size:12px;margin-right:6px}
 .pill{color:#fff;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700} .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px} li{margin:10px 0}
 .kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:14px 0} .kpi{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 12px} .kpi b{display:block;font:700 22px Georgia,serif}
 @media print{body{background:#fff}main{padding:0}} @media(max-width:720px){.grid2,.kpis{grid-template-columns:1fr 1fr}}
</style></head><body><main>
<p class="mut">PayPal PolicyTwin · counterfactual testing for safer financial-policy releases</p>
<h1>${esc(b.policy.name)}</h1>
<div class="badges"><span>Run ${esc(b.run.id)}</span><span>Candidate: Version ${esc(r.candidate_label)}</span>
<span>Lane 1: SIMULATED · DETERMINISTIC</span><span>Lane 2 proofs: ${proofs.length ? `${proofs.length} pair${proofs.length === 1 ? '' : 's'} (${proofs.some((x) => x.mode === 'sandbox') ? 'PAYPAL SANDBOX' : 'SIMULATED'})` : 'none'}</span><span>AI: ${esc(r.ai.mode === 'openai' ? r.ai.model : 'deterministic agents (no model)')}</span>${r.rerun_of ? `<span>Re-run of ${esc(r.rerun_of)}</span>` : ''}<span>${esc(r.generated_at)}</span></div>
<div class="disc"><b>Read this first.</b><ul>${DISCLOSURES.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>
<div class="banner"><div class="mut" style="color:inherit">Release recommendation (not an approval)</div><div class="v">${verdict}</div>
<ul>${r.release.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
<div class="kpis"><div class="kpi"><b>${r.release.counts.pairs}</b>twin pairs</div><div class="kpi"><b>${r.release.counts.passed}</b>as expected</div><div class="kpi"><b>${r.release.counts.critical}</b>critical</div><div class="kpi"><b>${r.release.counts.invariant_failures}</b>invariant failures</div><div class="kpi"><b>${Math.round(r.release.coverage.ratio * 100)}%</b>required coverage</div></div>
<h2>Twin matrix</h2>
<table><thead><tr><th>Pair</th><th>Changed variable</th><th>Old (A) base → twin</th><th>New (${esc(r.candidate_label)}) base → twin</th><th>Result</th><th>Severity</th></tr></thead><tbody>${matrix}</tbody></table>
${findings ? `<h2>Findings</h2><ul>${findings}</ul>` : ''}
<h2>Estimated impact <span class="pill" style="background:#a86400">SYNTHETIC</span></h2>
<p><b>${esc(r.narrative.headline)}.</b> ${esc(r.narrative.narrative)}</p>
${impactRows ? `<table><thead><tr><th>Finding</th><th>Kind</th><th>Synthetic transactions</th><th>Synthetic value</th></tr></thead><tbody>${impactRows}</tbody></table>` : ''}
<h3>Facts (observed in this run)</h3><ul>${r.impact.facts.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>No failed scenarios.</li>'}</ul>
<h3>Assumptions (synthetic model — not PayPal data)</h3><ul>${r.impact.assumptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
${r.narrative.affected_customer_types.length ? `<p class="mut">Affected customer types: ${esc(r.narrative.affected_customer_types.join('; '))}</p>` : ''}
<h2>Test coverage</h2>
<p>Required categories: ${r.release.coverage.required.map((c) => `<code>${esc(c)}</code>`).join(' ') || 'none'}<br>Covered: ${r.release.coverage.covered.map((c) => `<code>${esc(c)}</code>`).join(' ')}<br>${r.release.coverage.missing.length ? `<b>Missing: ${esc(r.release.coverage.missing.join(', '))}</b>` : 'All required categories were covered.'}</p>
${lanesHtml}
<h2>Deterministic invariants (Lane 1)</h2>
<table><thead><tr><th>Invariant</th><th>Passed</th><th>Failed</th><th>N/A</th></tr></thead><tbody>${invRows}</tbody></table>
${repair}
<h2>Human decision</h2>${human}
<h2>Audit trail</h2><table><thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Payload hash</th></tr></thead><tbody>${audit}</tbody></table>
<h2>Pipeline</h2><p>${esc(PIPELINE_MOTTO)}</p>
<p class="mut">${esc(TAGLINE)}</p>
</main></body></html>`;
}
