'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useState, type ReactNode } from 'react';
import { useHotkey } from '@/lib/hooks';
import Sidebar from './Sidebar';
import TopBar, { HelpDialog } from './TopBar';
import CommandPalette from './CommandPalette';
import { LoginGate } from './LoginGate';
import { DisclosureStrip, Footer } from './Disclosure';
import { useSession } from './SessionProvider';
import { CardSkeleton } from '../ds/feedback';

/** Shared read-only example pages stay readable without a passcode (the API enforces this too). */
function isPublicPath(path: string, ex?: { policy_id: string; run_ids: string[] }): boolean {
  if (!ex) return false;
  if (path === `/policies/${ex.policy_id}`) return true;
  const m = /^\/runs\/([^/]+)$/.exec(path);
  return !!m && ex.run_ids.includes(m[1]);
}

export default function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? '/';
  const { status, session } = useSession();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const noModal = () => !document.querySelector('[role="dialog"]');

  useHotkey((e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k', (e) => { e.preventDefault(); setPalette((o) => !o); });
  useHotkey((e) => e.key === '/' && !e.ctrlKey && !e.metaKey, (e) => { if (noModal()) { e.preventDefault(); setPalette(true); } });
  useHotkey((e) => e.key === '?' && !e.ctrlKey && !e.metaKey, (e) => { if (noModal()) { e.preventDefault(); setHelp(true); } });
  const openHelp = useCallback(() => setHelp(true), []);

  const gated = (status === 'login' || status === 'unavailable') && !isPublicPath(path, session?.public_example);

  return (
    <div className="lg:flex">
      <a href="#main" className="sr-only z-[90] rounded-lg bg-navy px-4 py-2 font-semibold text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to main content
      </a>
      <Sidebar />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <TopBar onSearch={() => setPalette(true)} onHelp={openHelp} />
        <DisclosureStrip />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1500px] flex-1 break-words px-4 py-6 focus:outline-none sm:px-6 lg:py-8">
          {status === 'loading' ? <div className="space-y-4"><CardSkeleton /><CardSkeleton /></div> : gated ? <LoginGate /> : children}
        </main>
        <Footer />
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} onHelp={openHelp} />
      <HelpDialog open={help} onOpenChange={setHelp} />
    </div>
  );
}
