'use client';

import * as Popover from '@radix-ui/react-popover';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Bell, CircleHelp, LogOut, Menu as MenuIcon, RotateCcw, Search, User } from 'lucide-react';
import { useState } from 'react';
import { api, cx, errMsg, relTime } from '@/lib/client';
import { Brand, DemoButton, NavList } from './Sidebar';
import { useSession } from './SessionProvider';
import { EnvironmentBadge, RuntimeBadge, VerifierBadge } from '../ds/badges';
import { ConfirmationDialog, Sheet, Tip } from '../ds/overlays';
import { useToast } from '../ds/Toast';

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { runtime } = useSession();
  const rows: [string, string][] = [
    ['Ctrl/⌘ K', 'Open the command palette'],
    ['/', 'Search (opens the command palette)'],
    ['?', 'Open this help'],
    ['Esc', 'Close a dialog, drawer or menu'],
    ['↑ ↓ Enter', 'Move through and open palette results'],
    ['← → on a tab', 'Switch run tabs (Matrix · Inspector · Release Gate)'],
  ];
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Help & shortcuts" description="How to read what you see" testId="help-dialog">
      <div className="space-y-6 text-sm">
        <section>
          <h3 className="mb-2 font-display text-base font-bold">What PayPal PolicyTwin does</h3>
          <p className="text-ink-mute">It tests a fictional financial-policy change on matched “transaction twins” before release. AI proposes; deterministic code verifies; a human decides.</p>
        </section>
        <section>
          <h3 className="mb-2 font-display text-base font-bold">Sandbox vs simulated</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-ink-mute">
            <li>
              The <b className="text-ink">full run</b> always uses the in-process <b className="text-ink">simulator</b>. It models PayPal’s documented behaviour; it is not PayPal.
            </li>
            <li>
              “Verify in PayPal Sandbox” re-runs <b className="text-ink">one pair</b> against the real PayPal Sandbox <i>only if</i> Sandbox credentials are configured. Right now:{' '}
              <b className="text-ink">{runtime?.lane2_mode === 'sandbox' ? 'Sandbox credentials are configured.' : 'no Sandbox credentials, so that button uses the simulator and says so.'}</b>
            </li>
            <li>Sandbox money is test money. No production PayPal system is ever contacted.</li>
          </ul>
        </section>
        <section>
          <h3 className="mb-2 font-display text-base font-bold">Keyboard</h3>
          <dl className="divide-y divide-line rounded-lg border border-line">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 px-3 py-2">
                <dt>
                  {k.split(' ').map((p) => (
                    <kbd key={p} className="kbd mr-1">
                      {p}
                    </kbd>
                  ))}
                </dt>
                <dd className="text-right text-ink-mute">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h3 className="mb-2 font-display text-base font-bold">What it does not claim</h3>
          <p className="text-ink-mute">No PayPal production data, no regulatory certification, no guarantee that a PASS is safe. A PASS means no blocking issue in the scenarios that were tested.</p>
        </section>
      </div>
    </Sheet>
  );
}

function Notifications() {
  const { history } = useToast();
  return (
    <Popover.Root>
      <Tip label="Session activity">
        <Popover.Trigger asChild>
          <button type="button" className="btn-quiet relative !p-2" aria-label={`Session activity${history.length ? `, ${history.length} items` : ''}`} data-testid="notifications">
            <Bell className="h-[18px] w-[18px]" aria-hidden />
            {history.length > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-brand" aria-hidden />}
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={12} className="z-[70] w-[min(92vw,22rem)] animate-fade-in rounded-xl border border-line bg-surface p-3 shadow-lift">
          <h2 className="mb-2 px-1 font-display text-sm font-bold">Session activity</h2>
          {history.length === 0 ? (
            <p className="px-1 py-3 text-sm text-ink-mute">Nothing yet. Results of runs, decisions and errors from this browser session appear here.</p>
          ) : (
            <ul className="max-h-80 space-y-2 overflow-y-auto">
              {history.map((h) => (
                <li key={h.id} className="rounded-lg bg-surface-2 px-3 py-2">
                  <p className={cx('text-sm font-semibold', h.tone === 'error' ? 'text-block-ink' : 'text-ink')}>{h.title}</p>
                  {h.body && <p className="mt-0.5 break-words text-xs text-ink-mute">{h.body}</p>}
                  <p className="mt-1 text-[11px] text-ink-mute">{relTime(new Date(h.at).toISOString())}</p>
                </li>
              ))}
            </ul>
          )}
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AvatarMenu() {
  const { session, logout, refresh } = useSession();
  const { push } = useToast();
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const actor = session?.actor ?? 'Not signed in';
  const initials = session?.actor ? (session.actor.match(/[a-z]/gi) ?? ['?']).slice(0, 2).join('').toUpperCase() : '?';
  const u = session?.usage;
  const lim = session?.limits;

  async function reset() {
    setBusy(true);
    try {
      const r = await api<{ deleted: Record<string, number> | number }>('/api/session/reset', { method: 'POST', json: {} });
      push({ title: 'Workspace reset', body: 'Everything you created in this session was deleted. The shared example is untouched.' });
      setConfirmReset(false);
      await refresh();
      void r;
      window.location.assign('/');
    } catch (e) {
      push({ tone: 'error', title: 'Could not reset the workspace', body: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button type="button" className="flex items-center gap-2 rounded-full border border-line-strong bg-surface py-1 pl-1 pr-1 text-sm font-semibold hover:bg-surface-2 md:pr-2.5" data-testid="avatar-menu">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-navy text-[11px] font-bold text-white" aria-hidden>
              {initials}
            </span>
            <span className="hidden max-w-[9rem] truncate md:inline">{actor}</span>
            <span className="sr-only md:hidden">{actor}</span>
            <span className="sr-only">, account menu</span>
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="end" sideOffset={8} collisionPadding={12} className="z-[70] w-[min(92vw,18rem)] animate-fade-in rounded-xl border border-line bg-surface p-1.5 shadow-lift">
            <div className="px-3 py-2">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <User className="h-4 w-4" aria-hidden />
                <span className="truncate">{actor}</span>
              </p>
              <p className="mt-1 text-xs text-ink-mute">{session?.mode === 'open' ? 'Open local mode (no passcode)' : 'Demo passcode session'}. Your decisions are recorded under this server-derived name.</p>
              {u && lim && (
                <p className="mt-2 text-xs text-ink-mute">
                  Quota: {u.runs}/{lim.maxRunsPerSession} runs · {u.policies}/{lim.maxPoliciesPerSession} policies
                </p>
              )}
            </div>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item onSelect={() => setConfirmReset(true)} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2" data-testid="reset-workspace">
              <RotateCcw className="h-4 w-4" aria-hidden />
              Reset my workspace
            </Menu.Item>
            {session?.required && (
              <Menu.Item onSelect={() => void logout()} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2" data-testid="sign-out">
                <LogOut className="h-4 w-4" aria-hidden />
                Sign out
              </Menu.Item>
            )}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <ConfirmationDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset your workspace?"
        description={
          <>
            <p>This permanently deletes every policy, test run, report and decision you created in this session.</p>
            <p>The shared read-only example and other people’s data are not touched.</p>
          </>
        }
        confirmLabel="Delete my data"
        tone="danger"
        busy={busy}
        onConfirm={reset}
      />
    </>
  );
}

export default function TopBar({ onSearch, onHelp }: { onSearch: () => void; onHelp: () => void }) {
  const { runtime } = useSession();
  const [nav, setNav] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur" data-testid="topbar">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-5">
        <button type="button" className="btn-quiet !p-2 lg:hidden" aria-label="Open navigation" onClick={() => setNav(true)} data-testid="open-nav">
          <MenuIcon className="h-5 w-5" aria-hidden />
        </button>
        <div className="min-w-0 lg:hidden">
          <Brand onNavy={false} compact />
        </div>
        <button
          type="button"
          onClick={onSearch}
          data-testid="open-palette"
          className="ml-1 hidden min-w-0 flex-1 items-center gap-2 rounded-lg border border-line-strong bg-canvas px-3 py-2 text-left text-sm text-ink-mute hover:border-brand/50 sm:flex md:max-w-md"
        >
          <Search className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">Search policies, runs, commands…</span>
          <span className="ml-auto hidden gap-1 md:inline-flex">
            <kbd className="kbd">Ctrl</kbd>
            <kbd className="kbd">K</kbd>
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
                    <div className="hidden items-center gap-2 lg:flex">
            <VerifierBadge />
            <RuntimeBadge runtime={runtime} />
          </div>
          <EnvironmentBadge runtime={runtime} />
          <div className="hidden items-center gap-1.5 sm:flex sm:gap-2">
            <Notifications />
            <Tip label="Help & shortcuts" shortcut="?">
              <button type="button" className="btn-quiet !p-2" aria-label="Help and shortcuts" onClick={onHelp} data-testid="open-help">
                <CircleHelp className="h-[18px] w-[18px]" aria-hidden />
              </button>
            </Tip>
          </div>
          <AvatarMenu />
        </div>
      </div>
      <Sheet open={nav} onOpenChange={setNav} side="left" title="Navigation" hideTitle testId="mobile-nav">
        <div className="on-navy -mx-5 -my-4 flex min-h-full flex-col gap-6 bg-navy px-4 py-5">
          <Brand />
          <div className="grid grid-cols-2 gap-2 sm:hidden">
            <button type="button" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/25 px-3 text-sm font-semibold text-white hover:bg-white/10" onClick={() => { setNav(false); onSearch(); }} data-testid="mobile-search">
              <Search className="h-4 w-4" aria-hidden /> Search
            </button>
            <button type="button" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/25 px-3 text-sm font-semibold text-white hover:bg-white/10" onClick={() => { setNav(false); onHelp(); }} data-testid="mobile-help">
              <CircleHelp className="h-4 w-4" aria-hidden /> Help
            </button>
          </div>
          <NavList onNavigate={() => setNav(false)} />
          <div className="mt-auto">
            <DemoButton onNavigate={() => setNav(false)} />
          </div>
        </div>
      </Sheet>
    </header>
  );
}
