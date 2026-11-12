import { beforeAll, describe, expect, it } from 'vitest';
import { applyFilter, csvCell, filterCounts, FILTERS, matrixRows, toCsv, type MatrixRow } from '@/lib/run-view';
import { ambiguityItems, AMBIGUITY_META, diffPolicies, ruleRows } from '@/lib/policy/view';
import { AMBIGUITY_CODES, manualReviewPolicy } from '@/lib/policy/schema';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { getRunBundle, runDemoFlow, type RunBundle } from '@/lib/pipeline';
import { offlineCtx, policyA, policyB, policyC } from '../helpers';

describe('csvCell — spreadsheet formula injection guard', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd'])('neutralises a leading formula character: %j', (v) => {
    const out = csvCell(v);
    expect(out.replace(/^"/, '').startsWith("'")).toBe(true);
  });
  it('quotes cells with commas, quotes and newlines, and doubles embedded quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });
  it('leaves ordinary text alone and renders null/undefined as empty', () => {
    expect(csvCell('physical')).toBe('physical');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });
});

describe('policy view helpers', () => {
  it('lists the rule rows of a modelled policy, and fewer for manual review', () => {
    const a = ruleRows(policyA());
    expect(a.map((r) => r.key)).toEqual(expect.arrayContaining(['trigger', 'action', 'threshold', 'condition', 'exceptions']));
    const manual = ruleRows(manualReviewPolicy('Manual'));
    expect(manual.find((r) => r.key === 'action')?.value).toBe('Manual review');
    expect(manual.some((r) => r.key === 'physical')).toBe(false);
  });

  it('flags what the proposed policy leaves silent, and the repaired policy does not', () => {
    expect(ruleRows(policyB()).some((r) => r.unspecified)).toBe(true);
    expect(ruleRows(policyC()).filter((r) => r.unspecified).map((r) => r.key)).toEqual([]);
  });

  it('diffs two policies field by field and marks gaps the change introduced', () => {
    const d = diffPolicies(policyA(), policyB());
    expect(d.find((r) => r.key === 'action')?.kind).toBe('changed');
    expect(d.some((r) => r.kind === 'newly_unspecified')).toBe(true);
    const repaired = diffPolicies(policyB(), policyC());
    expect(repaired.some((r) => r.kind === 'changed')).toBe(true);
    expect(repaired.every((r) => r.kind !== 'newly_unspecified')).toBe(true);
  });

  it('comparing a policy with itself changes nothing and introduces no gap', () => {
    const d = diffPolicies(policyB(), policyB());
    expect(d.every((r) => r.kind === 'same' || r.kind === 'still_unspecified')).toBe(true);
  });

  it('has metadata for every ambiguity code, and pairs stored text with it', () => {
    for (const c of AMBIGUITY_CODES) expect(AMBIGUITY_META[c].title.length).toBeGreaterThan(3);
    const b = policyB();
    const items = ambiguityItems(b);
    expect(items.length).toBe(b.ambiguities.length);
    expect(items.filter((i) => i.code).every((i) => i.meta !== null)).toBe(true);
    const custom = ambiguityItems({ ...b, ambiguities: [...b.ambiguities, 'Something only the model noticed'] });
    expect(custom.at(-1)).toMatchObject({ code: null, meta: null });
  });
});

describe('twin matrix view-model', () => {
  let bundle: RunBundle;
  let rows: MatrixRow[];
  beforeAll(async () => {
    const ctx = await offlineCtx();
    const { run } = await runDemoFlow(ctx, DEMO_POLICY_INPUT, { adversarial: true });
    bundle = await getRunBundle(ctx, run.id);
    rows = matrixRows(bundle);
  });

  it('builds one row per tested pair with the changed field values', () => {
    expect(rows.length).toBe(bundle.pairs.length);
    expect(rows.length).toBe(10);
    for (const r of rows) {
      expect(r.original).not.toBe(r.twin); // a twin pair differs in exactly the changed field
      expect(r.outcome).not.toMatch(/_/);
    }
  });

  it('filter counts are consistent with applyFilter', () => {
    const counts = filterCounts(rows);
    expect(counts.ALL).toBe(rows.length);
    for (const f of FILTERS) expect(applyFilter(rows, f.id, '').length).toBe(counts[f.id]);
    expect(counts.CRITICAL_REGRESSION).toBeGreaterThan(0);
  });

  it('search matches pair id, label, field and failed invariant, case-insensitively', () => {
    expect(applyFilter(rows, 'ALL', 'PAIR_01').map((r) => r.pair_id)).toContain('pair_01');
    expect(applyFilter(rows, 'ALL', 'no-such-term')).toEqual([]);
    const withInv = rows.find((r) => r.failed_invariants.length);
    expect(withInv).toBeTruthy();
    expect(applyFilter(rows, 'ALL', withInv!.failed_invariants[0].toLowerCase()).map((r) => r.pair_id)).toContain(withInv!.pair_id);
    // a tag filter and a query combine with AND
    const crit = applyFilter(rows, 'CRITICAL_REGRESSION', '');
    expect(applyFilter(rows, 'CRITICAL_REGRESSION', crit[0].pair_id).length).toBe(1);
  });

  it('exports CSV with a header, one line per row, CRLF endings and no raw formula cells', () => {
    const csv = toCsv(rows, 'B');
    const lines = csv.trimEnd().split('\r\n');
    expect(lines.length).toBe(rows.length + 1);
    expect(lines[0]).toContain('new_decision_B');
    expect(csv.endsWith('\r\n')).toBe(true);
    const hostile = toCsv([{ ...rows[0], label: '=HYPERLINK("http://x")' }], 'B');
    expect(hostile).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});
