'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Play } from 'lucide-react';
import { cx } from '@/lib/client';
import { NAV } from './nav';
import { useDemo } from './DemoRunner';

export function Brand({ onNavy = true, compact = false }: { onNavy?: boolean; compact?: boolean }) {
  return (
    <Link href="/" className={cx('group flex min-w-0 items-center gap-2 rounded-lg sm:gap-2.5', onNavy ? 'text-white' : 'text-ink')}>
      <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-xl sm:h-9 sm:w-9 bg-gradient-to-br from-brand-electric to-twin shadow-ring" aria-hidden>
        <span className="absolute left-1.5 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-white/90" />
        <span className="absolute bottom-1.5 right-1.5 h-3.5 w-3.5 rounded-full border-2 border-white/90 bg-white/25" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate font-display text-[15px] font-bold tracking-tight sm:text-[17px]">PayPal PolicyTwin</span>
        <span className={cx('block text-[10px] font-semibold uppercase tracking-[0.14em]', compact && 'hidden truncate sm:block', onNavy ? 'text-white/70' : 'text-ink-mute')}>Financial intelligence control room</span>
        <span className="sr-only">— home</span>
      </span>
    </Link>
  );
}

export function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname() ?? '/';
  return (
    <nav aria-label="Primary" className="space-y-0.5">
      {NAV.map((n) => {
        const active = n.match(path);
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            data-testid={`nav-${n.href === '/' ? 'overview' : n.href.slice(1).replace(/\//g, '-')}`}
            className={cx('group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition', active ? 'bg-white/12 text-white ring-1 ring-white/20' : 'text-white/80 hover:bg-white/8 hover:text-white')}
          >
            <n.icon className={cx('h-[18px] w-[18px] shrink-0', active ? 'text-brand-electric' : 'text-white/60 group-hover:text-white/90')} aria-hidden />
            <span className="min-w-0">
              <span className="block truncate">{n.label}</span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

export function DemoButton({ onNavigate }: { onNavigate?: () => void }) {
  const demo = useDemo();
  return (
    <button
      type="button"
      data-testid="run-demo"
      className="btn w-full bg-gradient-to-r from-brand to-twin-ink text-white shadow-lift hover:brightness-110"
      onClick={() => {
        onNavigate?.();
        demo.open();
      }}
    >
      <Play className="h-4 w-4" aria-hidden />
      Run demo scenario
    </button>
  );
}

export default function Sidebar() {
  return (
    <aside className="on-navy sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-6 overflow-y-auto bg-navy px-4 py-5 lg:flex" aria-label="Sidebar">
      <Brand />
      <NavList />
      <div className="mt-auto space-y-3">
        <DemoButton />
        <p className="text-[11px] leading-snug text-white/65">Guided run: creates a fictional policy, tests it, and stops at the human decision.</p>
      </div>
    </aside>
  );
}
