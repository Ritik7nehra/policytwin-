'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useRouter } from 'next/navigation';
import { CircleHelp, CornerDownLeft, FileText, FolderGit2, LogOut, Play, Search, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, cx } from '@/lib/client';
import type { Overview } from '@/lib/ui-types';
import { NAV } from './nav';
import { useSession } from './SessionProvider';
import { useDemo } from './DemoRunner';

interface Cmd {
  id: string;
  group: 'Go to' | 'Actions' | 'Recent policies' | 'Recent runs';
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  run: () => void;
}

export default function CommandPalette({ open, onOpenChange, onHelp }: { open: boolean; onOpenChange: (o: boolean) => void; onHelp: () => void }) {
  const router = useRouter();
  const demo = useDemo();
  const { session, authed, logout } = useSession();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [overview, setOverview] = useState<Overview | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    const ac = new AbortController();
    api<Overview>('/api/overview', { signal: ac.signal })
      .then(setOverview)
      .catch(() => setOverview(null));
    return () => ac.abort();
  }, [open, authed]);

  const go = (href: string) => () => {
    onOpenChange(false);
    router.push(href);
  };

  const cmds = useMemo<Cmd[]>(() => {
    const list: Cmd[] = NAV.map((n) => ({ id: `nav:${n.href}`, group: 'Go to', label: n.label, hint: n.hint, icon: n.icon, run: go(n.href) }));
    list.push(
      { id: 'act:demo', group: 'Actions', label: 'Run demo scenario', hint: 'Guided: creates the fictional policy and tests it', icon: Play, keywords: 'guided start example', run: () => { onOpenChange(false); demo.open(); } },
      { id: 'act:new', group: 'Actions', label: 'New policy change', hint: 'Open the three-step wizard', icon: FolderGit2, keywords: 'create wizard', run: go('/policies/new') },
    );
    const ex = session?.public_example;
    if (ex?.run_ids.length) list.push({ id: 'act:example', group: 'Actions', label: 'Open the read-only example report', hint: 'BLOCK → approved repair → PASS', icon: FileText, keywords: 'public sample', run: go(`/runs/${ex.run_ids[ex.run_ids.length - 1]}`) });
    list.push({ id: 'act:help', group: 'Actions', label: 'Help & shortcuts', hint: 'Sandbox vs simulated, keyboard', icon: CircleHelp, keywords: '? shortcuts', run: () => { onOpenChange(false); onHelp(); } });
    if (session?.required) list.push({ id: 'act:out', group: 'Actions', label: 'Sign out', icon: LogOut, run: () => { onOpenChange(false); void logout(); } });
    for (const p of overview?.recent_policies ?? []) list.push({ id: `pol:${p.id}`, group: 'Recent policies', label: p.name, hint: p.read_only ? 'read-only example' : p.id, icon: FolderGit2, keywords: p.id, run: go(`/policies/${p.id}`) });
    for (const r of overview?.recent_runs ?? []) list.push({ id: `run:${r.id}`, group: 'Recent runs', label: `${r.policy_name} — ${r.release_decision ?? r.stage}`, hint: r.id, icon: Play, keywords: `${r.id} ${r.release_decision ?? ''}`, run: go(`/runs/${r.id}`) });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, overview, demo, onHelp, logout]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return cmds.filter((c) => c.group === 'Go to' || c.group === 'Actions');
    const terms = t.split(/\s+/);
    return cmds.filter((c) => {
      const hay = `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''}`.toLowerCase();
      return terms.every((x) => hay.includes(x));
    });
  }, [cmds, q]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); shown[idx]?.run(); }
  };

  let lastGroup = '';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-navy/50 backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <Dialog.Content data-testid="command-palette" aria-describedby={undefined} className="fixed left-1/2 top-[12vh] z-[61] w-[min(94vw,38rem)] -translate-x-1/2 animate-rise-in overflow-hidden rounded-2xl border border-line bg-surface shadow-lift focus:outline-none">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-3 border-b-2 border-line px-4 focus-within:border-brand">
            <Search className="h-5 w-5 shrink-0 text-ink-mute" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={shown[idx] ? `pal-${shown[idx].id}` : undefined}
              aria-label="Search policies, runs and commands"
              placeholder="Type a policy, run id or command…"
              className="w-full bg-transparent py-4 text-base placeholder:text-ink-mute focus-visible:!outline-none"
              data-testid="palette-input"
            />
            <kbd className="kbd hidden sm:inline">Esc</kbd>
          </div>
          <ul id="palette-list" ref={listRef} role="listbox" className="max-h-[52vh] overflow-y-auto p-2">
            {shown.length === 0 && <li className="px-3 py-8 text-center text-sm text-ink-mute">No match for “{q}”. Try a policy name, a run id such as <span className="font-mono">run_</span>, or “demo”.</li>}
            {shown.map((c, i) => {
              const header = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              return (
                <li key={c.id} role="presentation">
                  {header && <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-mute">{header}</p>}
                  <div
                    id={`pal-${c.id}`}
                    role="option"
                    aria-selected={i === idx}
                    onMouseMove={() => setIdx(i)}
                    onClick={c.run}
                    className={cx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm', i === idx ? 'bg-brand-bg text-ink' : 'text-ink')}
                  >
                    <c.icon className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{c.label}</span>
                      {c.hint && <span className="block truncate text-xs text-ink-mute">{c.hint}</span>}
                    </span>
                    {i === idx && <CornerDownLeft className="h-3.5 w-3.5 text-ink-mute" aria-hidden />}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between border-t border-line bg-surface-2 px-4 py-2 text-[11px] text-ink-mute">
            <span>↑↓ to move · Enter to open</span>
            <span>Searches only your workspace and the shared example</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
