import type { RunBundle } from './pipeline';
import type { PairTag, Severity } from './types';

/** Pure view-model for the Transaction Twin Matrix (unit-tested). */
export interface MatrixRow {
  pair_id: string;
  label: string;
  origin: 'core' | 'adversarial';
  category: string;
  changed_field: string;
  original: string;
  twin: string;
  old_base: string;
  old_twin: string;
  new_base: string;
  new_twin: string;
  severity: Severity;
  outcome: string;
  expectation: string;
  tags: PairTag[];
  failed_invariants: string[];
}

export type FilterId = 'ALL' | PairTag;
export const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'PASSED', label: 'Passed' },
  { id: 'UNEXPECTED_DIFFERENCE', label: 'Unexpected difference' },
  { id: 'INVARIANT_FAILURE', label: 'Invariant failure' },
  { id: 'HUMAN_REVIEW', label: 'Human review' },
  { id: 'CRITICAL_REGRESSION', label: 'Critical regression' },
];

export function matrixRows(bundle: RunBundle): MatrixRow[] {
  return bundle.pairs
    .filter((p) => p.result)
    .map((p) => {
      const r = p.result!;
      const f = r.changed_field as keyof typeof p.base.input;
      return {
        pair_id: p.pair_id,
        label: p.label,
        origin: p.origin,
        category: p.category,
        changed_field: r.changed_field,
        original: String(p.base.input[f]),
        twin: String(p.twin.input[f]),
        old_base: r.old_base,
        old_twin: r.old_twin,
        new_base: r.new_base,
        new_twin: r.new_twin,
        severity: r.severity,
        outcome: r.outcome.replace(/_/g, ' ').toLowerCase(),
        expectation: p.expectation,
        tags: r.tags,
        failed_invariants: r.failed_invariants,
      };
    });
}

export function filterCounts(rows: MatrixRow[]): Record<FilterId, number> {
  const c = { ALL: rows.length } as Record<FilterId, number>;
  for (const f of FILTERS.slice(1)) c[f.id] = rows.filter((r) => r.tags.includes(f.id as PairTag)).length;
  return c;
}

export function applyFilter(rows: MatrixRow[], tag: FilterId, q: string): MatrixRow[] {
  const t = q.trim().toLowerCase();
  return rows.filter((r) => (tag === 'ALL' || r.tags.includes(tag)) && (!t || `${r.pair_id} ${r.label} ${r.changed_field} ${r.category} ${r.outcome} ${r.severity} ${r.failed_invariants.join(' ')}`.toLowerCase().includes(t)));
}

const DEC: Record<string, string> = { AUTO_REFUND: 'REFUND', REVIEW: 'REVIEW' };
const arrow = (a: string, b: string) => `${DEC[a] ?? a} -> ${DEC[b] ?? b}`;

/** CSV-escape a cell and neutralise spreadsheet formula injection (cells that start with = + - @ or a control char). */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: MatrixRow[], candidate: string): string {
  const head = ['pair_id', 'label', 'origin', 'category', 'changed_field', 'original', 'twin', 'expectation', 'old_decision_A', `new_decision_${candidate}`, 'severity', 'outcome', 'failed_invariants'];
  const lines = rows.map((r) => [r.pair_id, r.label, r.origin, r.category, r.changed_field, r.original, r.twin, r.expectation, arrow(r.old_base, r.old_twin), arrow(r.new_base, r.new_twin), r.severity, r.outcome, r.failed_invariants.join(' ')].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
