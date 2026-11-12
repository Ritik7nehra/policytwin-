'use client';

import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { RunBundle } from '@/lib/pipeline';
import { useMediaQuery } from '@/lib/hooks';
import { Sheet } from '../ds/overlays';
import ScenarioEvidence from './ScenarioEvidence';

/**
 * Scenario evidence drawer. Desktop: a docked, NON-modal panel — the matrix behind it stays usable, so you can step
 * through rows. Phone/tablet: a full-screen modal sheet. Esc closes either one and focus returns to where it came from.
 */
export default function ScenarioDrawer({ bundle, pairId, open, onClose, onPairChange, onChanged, onOpenInspector }: { bundle: RunBundle; pairId: string | null; open: boolean; onClose: () => void; onPairChange: (id: string) => void; onChanged: () => void; onOpenInspector: () => void }) {
  const desktop = useMediaQuery('(min-width: 1024px)');
  const head = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (open && desktop) {
      opener.current = document.activeElement;
      head.current?.focus();
    } else if (!open && opener.current instanceof HTMLElement) {
      opener.current.focus?.();
      opener.current = null;
    }
  }, [open, desktop]);

  const pair = bundle.pairs.find((p) => p.pair_id === pairId);
  const body = <ScenarioEvidence bundle={bundle} pairId={pairId} onPairChange={onPairChange} onChanged={onChanged} testId="drawer-inspector" />;

  if (!desktop) {
    return (
      <Sheet open={open} onOpenChange={(o) => !o && onClose()} full title={pair ? `${pair.pair_id} · ${pair.label}` : 'Scenario evidence'} description="Evidence for one twin pair" testId="scenario-drawer" footer={<button className="btn-ghost w-full" onClick={onOpenInspector}><ExternalLink className="h-4 w-4" aria-hidden /> Open in Inspector</button>}>
        {body}
      </Sheet>
    );
  }
  if (!open) return null;
  return (
    <aside
      role="complementary"
      aria-labelledby="drawer-title"
      data-testid="scenario-drawer"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      style={{ top: 'var(--run-header-bottom)' }}
      className="fixed bottom-0 right-0 z-30 flex w-[min(36rem,46vw)] animate-drawer-in flex-col border-l border-line bg-surface shadow-drawer"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 id="drawer-title" ref={head} tabIndex={-1} className="min-w-0 truncate font-display text-base font-bold focus:outline-none">
          Scenario evidence <span className="font-mono text-xs font-medium text-ink-mute">{pair?.pair_id}</span>
        </h2>
        <div className="flex items-center gap-1">
          <button type="button" className="btn-ghost !min-h-8 !px-2.5 text-xs" onClick={onOpenInspector} data-testid="open-inspector"><ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open in Inspector</button>
          <button type="button" className="btn-quiet !p-2" onClick={onClose} aria-label="Close evidence drawer" data-testid="close-drawer"><X className="h-5 w-5" aria-hidden /></button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{body}</div>
    </aside>
  );
}
