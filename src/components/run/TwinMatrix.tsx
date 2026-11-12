'use client';

import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type CellKeyDownEvent, type ColDef, type ICellRendererParams } from 'ag-grid-community';
import { Bookmark, Download, Eye, Rows3, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunBundle } from '@/lib/pipeline';
import { FILTERS, applyFilter, filterCounts, matrixRows, toCsv, type FilterId, type MatrixRow } from '@/lib/run-view';
import { cx } from '@/lib/client';
import { useMediaQuery, useStoredState } from '@/lib/hooks';
import { Card } from '../ds/Card';
import { Chip, DecisionTransition, SeverityBadge } from '../ds/badges';
import { EmptyState } from '../ds/feedback';
import { useToast } from '../ds/Toast';

ModuleRegistry.registerModules([AllCommunityModule]);

const base = {
  accentColor: '#1769E0',
  backgroundColor: '#FFFFFF',
  foregroundColor: '#0B1F38',
  headerBackgroundColor: '#EEF3F9',
  headerTextColor: '#55677E',
  headerFontWeight: 700,
  borderColor: '#DCE5EF',
  rowHoverColor: '#EAF3FF',
  selectedRowBackgroundColor: '#E6F7FB',
  fontFamily: '"Inter Variable", system-ui, sans-serif',
  fontSize: 13,
  wrapperBorderRadius: 12,
} as const;
const comfy = themeQuartz.withParams({ ...base, spacing: 9 });
const dense = themeQuartz.withParams({ ...base, spacing: 5 });

interface Saved {
  id: string;
  name: string;
  tag: FilterId;
  q: string;
}

export default function TwinMatrix({ bundle, selected, onSelect }: { bundle: RunBundle; selected: string | null; onSelect: (pairId: string) => void }) {
  const { push } = useToast();
  const grid = useRef<AgGridReact<MatrixRow>>(null);
  const wide = useMediaQuery('(min-width: 768px)');
  const [tag, setTag] = useState<FilterId>('ALL');
  const [q, setQ] = useState('');
  const [density, setDensity] = useStoredState<'comfortable' | 'compact'>('pt:matrix-density', 'comfortable');
  const [saved, setSaved, hydrated] = useStoredState<Saved[]>('pt:matrix-filters:v1', []);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const rows = useMemo(() => matrixRows(bundle), [bundle]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const shown = useMemo(() => applyFilter(rows, tag, q), [rows, tag, q]);
  const cand = bundle.version_b.label;
  const dirty = tag !== 'ALL' || q.trim() !== '';

  useEffect(() => {
    grid.current?.api?.redrawRows();
  }, [selected]);

  const cols = useMemo<ColDef<MatrixRow>[]>(
    () => [
      {
        headerName: 'Pair',
        field: 'label',
        flex: 2.4,
        minWidth: 190,
        cellRenderer: (p: ICellRendererParams<MatrixRow>) => (
          <div className="py-1 leading-tight">
            <div className="truncate font-semibold">{p.data?.label}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-mute">
              <span className="font-mono">{p.data?.pair_id}</span>
              <Chip tone={p.data?.origin === 'adversarial' ? 'warn' : 'plain'} className="!px-1.5 !py-0 !text-[10px]">{p.data?.origin}</Chip>
            </div>
          </div>
        ),
        tooltipField: 'label',
      },
      { headerName: 'Changed field', field: 'changed_field', flex: 1.1, minWidth: 122, cellClass: 'font-mono text-xs', tooltipField: 'changed_field' },
      { headerName: 'Original', field: 'original', flex: 0.7, minWidth: 70, cellClass: 'font-mono text-xs', tooltipField: 'original' },
      { headerName: 'Twin', field: 'twin', flex: 0.7, minWidth: 70, cellClass: 'font-mono text-xs', tooltipField: 'twin' },
      { headerName: 'Old decision (A)', flex: 1.1, minWidth: 116, sortable: false, filter: false, cellRenderer: (p: ICellRendererParams<MatrixRow>) => (p.data ? <DecisionTransition compact from={p.data.old_base} to={p.data.old_twin} label="Current policy, original to twin" /> : null) },
      { headerName: `New decision (${cand})`, flex: 1.4, minWidth: 168, sortable: false, filter: false, cellRenderer: (p: ICellRendererParams<MatrixRow>) => (p.data ? <DecisionTransition compact from={p.data.new_base} to={p.data.new_twin} label="Proposed policy, original to twin" /> : null) },
      { headerName: 'Severity', field: 'severity', flex: 0.7, minWidth: 94, cellRenderer: (p: ICellRendererParams<MatrixRow>) => (p.data ? <SeverityBadge s={p.data.severity} /> : null) },
      { headerName: 'Result', field: 'outcome', flex: 1.1, minWidth: 152, cellClass: 'capitalize', tooltipField: 'outcome' },
      {
        headerName: '',
        colId: 'open',
        width: 104,
        pinned: 'right',
        sortable: false,
        filter: false,
        resizable: false,
        cellRenderer: (p: ICellRendererParams<MatrixRow>) =>
          p.data ? (
            <button type="button" className="btn-ghost !min-h-8 !px-2.5 !py-1 text-xs" aria-label={`Inspect ${p.data.pair_id}: ${p.data.label}`} onClick={() => onSelect(p.data!.pair_id)}>
              <Eye className="h-3.5 w-3.5" aria-hidden /> Inspect
            </button>
          ) : null,
      },
    ],
    [cand, onSelect],
  );

  const onKey = (e: CellKeyDownEvent<MatrixRow>) => {
    const k = (e.event as KeyboardEvent | null)?.key;
    if ((k === 'Enter' || k === ' ') && e.data && (e.event?.target as HTMLElement)?.tagName !== 'BUTTON') {
      e.event?.preventDefault();
      onSelect(e.data.pair_id);
    }
  };

  function exportCsv() {
    const blob = new Blob([toCsv(shown, cand)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `policytwin-${bundle.run.id}-matrix.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    push({ title: 'Matrix exported', body: `${shown.length} row${shown.length === 1 ? '' : 's'} saved as CSV. Synthetic data only.` });
  }

  function saveFilter() {
    const n = name.trim();
    if (!n) return;
    setSaved([...saved.filter((s) => s.name !== n), { id: `${Date.now()}`, name: n.slice(0, 40), tag, q }].slice(-6));
    setName('');
    setNaming(false);
  }

  return (
    <Card title="Transaction twin matrix" right={<span className="text-xs text-ink-mute">Each pair differs in exactly one field. Select a row to open its evidence.</span>} bodyClass="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <label htmlFor="matrix-search" className="sr-only">Search pairs</label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" aria-hidden />
          <input id="matrix-search" data-testid="matrix-search" className="field !pl-9" placeholder="Search pair, field, invariant…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div role="group" aria-label="Row density" className="inline-flex overflow-hidden rounded-lg border border-line-strong">
          {(['comfortable', 'compact'] as const).map((d) => (
            <button key={d} type="button" aria-pressed={density === d} onClick={() => setDensity(d)} className={cx('inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold', density === d ? 'bg-navy text-white' : 'bg-surface text-ink hover:bg-surface-2')}>
              <Rows3 className="h-3.5 w-3.5" aria-hidden /> {d === 'comfortable' ? 'Comfortable' : 'Compact'}
            </button>
          ))}
        </div>
        <button type="button" className="btn-ghost" onClick={exportCsv} disabled={shown.length === 0} data-testid="export-csv">
          <Download className="h-4 w-4" aria-hidden /> Export CSV
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter pairs">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" data-testid={`filter-${f.id}`} aria-pressed={tag === f.id} onClick={() => setTag(f.id)} className={cx('rounded-full border px-3 py-1 text-xs font-semibold', tag === f.id ? 'border-navy bg-navy text-white' : 'border-line-strong bg-surface text-ink hover:bg-surface-2')}>
            {f.label} <span className="opacity-80">({counts[f.id]})</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-mute" aria-live="polite" data-testid="matrix-count">Showing {shown.length} of {rows.length} pairs</span>
        {hydrated && saved.map((s) => (
          <span key={s.id} className="inline-flex items-center overflow-hidden rounded-full border border-twin/40 bg-twin-bg text-twin-ink">
            <button type="button" className="px-2.5 py-1 font-semibold" onClick={() => { setTag(s.tag); setQ(s.q); }}>{s.name}</button>
            <button type="button" className="px-1.5 py-1 hover:bg-twin/20" aria-label={`Delete saved filter ${s.name}`} onClick={() => setSaved(saved.filter((x) => x.id !== s.id))}><X className="h-3 w-3" aria-hidden /></button>
          </span>
        ))}
        {dirty && !naming && (
          <>
            <button type="button" className="btn-quiet !min-h-7 !px-2 !py-0.5 text-xs" onClick={() => setNaming(true)}><Bookmark className="h-3.5 w-3.5" aria-hidden /> Save filter</button>
            <button type="button" className="btn-quiet !min-h-7 !px-2 !py-0.5 text-xs" onClick={() => { setTag('ALL'); setQ(''); }}>Clear</button>
          </>
        )}
        {naming && (
          <form className="inline-flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); saveFilter(); }}>
            <label htmlFor="filter-name" className="sr-only">Name for this filter</label>
            <input id="filter-name" autoFocus className="field !min-h-8 !w-40 !py-1 text-xs" placeholder="Name this filter" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            <button className="btn-primary !min-h-8 !px-2.5 !py-1 text-xs" type="submit" disabled={!name.trim()}>Save</button>
            <button className="btn-quiet !min-h-8 !px-2 !py-1 text-xs" type="button" onClick={() => setNaming(false)}>Cancel</button>
          </form>
        )}
      </div>

      <div data-testid="twin-grid">
        {shown.length === 0 ? (
          <EmptyState title="No pairs match" action={<button className="btn-ghost" onClick={() => { setTag('ALL'); setQ(''); }}>Clear filters</button>}>
            {rows.length === 0 ? 'This run has no evaluated pairs yet.' : 'Try another filter or search word.'}
          </EmptyState>
        ) : wide ? (
          <AgGridReact<MatrixRow>
            ref={grid}
            theme={density === 'compact' ? dense : comfy}
            className="pt-grid"
            rowData={shown}
            columnDefs={cols}
            defaultColDef={{ sortable: true, resizable: true, filter: true }}
            domLayout="autoHeight"
            rowHeight={density === 'compact' ? 40 : 56}
            getRowId={(p) => p.data.pair_id}
            getRowClass={(p) => cx(`sev-${p.data?.severity ?? 'none'}`, p.data?.pair_id === selected && 'ag-row-selected')}
            onRowClicked={(e) => e.data && onSelect(e.data.pair_id)}
            onCellKeyDown={onKey}
            tooltipShowDelay={400}
          />
        ) : (
          <ul className="space-y-2" aria-label="Twin pairs">
            {shown.map((r) => (
              <li key={r.pair_id}>
                <button type="button" onClick={() => onSelect(r.pair_id)} className={cx('w-full rounded-xl border bg-surface p-3 text-left', r.pair_id === selected ? 'border-twin ring-1 ring-twin/50' : 'border-line')}>
                  <span className="sr-only">Inspect </span>
                  <span className="flex items-start justify-between gap-2">
                    <span className="min-w-0"><span className="block font-semibold">{r.label}</span><span className="block font-mono text-[11px] text-ink-mute">{r.pair_id} · changes {r.changed_field}</span></span>
                    <SeverityBadge s={r.severity} />
                  </span>
                  <span className="mt-2 flex flex-col gap-1 text-xs">
                    <span className="flex items-center gap-2"><span className="w-14 text-ink-mute">Old (A)</span><DecisionTransition from={r.old_base} to={r.old_twin} /></span>
                    <span className="flex items-center gap-2"><span className="w-14 text-ink-mute">New ({cand})</span><DecisionTransition from={r.new_base} to={r.new_twin} /></span>
                    <span className="capitalize text-ink-mute">{r.outcome}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
