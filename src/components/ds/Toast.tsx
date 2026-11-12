'use client';

import { Bell, CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cx } from '@/lib/client';

export type ToastTone = 'success' | 'error' | 'info';
export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  at: number;
}
interface Ctx {
  push: (t: { tone?: ToastTone; title: string; body?: string }) => void;
  history: ToastItem[];
}
const ToastCtx = createContext<Ctx>({ push: () => undefined, history: [] });
export const useToast = () => useContext(ToastCtx);

const ICON = { success: CircleCheck, error: CircleAlert, info: Info } as const;
const TONE = { success: 'border-pass/40 text-pass-ink', error: 'border-block/40 text-block-ink', info: 'border-brand/40 text-brand-ink' } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<ToastItem[]>([]);
  const [history, setHistory] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setLive((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback<Ctx['push']>(
    (t) => {
      const item: ToastItem = { id: Date.now() + Math.random(), tone: t.tone ?? 'success', title: t.title, body: t.body, at: Date.now() };
      setLive((l) => [...l.slice(-3), item]);
      setHistory((h) => [item, ...h].slice(0, 20));
      setTimeout(() => dismiss(item.id), item.tone === 'error' ? 9000 : 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push, history }), [push, history]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6" role="region" aria-label="Notifications" aria-live="polite">
        {live.map((t) => {
          const I = ICON[t.tone];
          return (
            <div key={t.id} data-testid="toast" role={t.tone === 'error' ? 'alert' : 'status'} className={cx('pointer-events-auto flex w-full max-w-sm animate-rise-in items-start gap-3 rounded-xl border bg-surface p-3.5 shadow-lift', TONE[t.tone])}>
              <I className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{t.title}</p>
                {t.body && <p className="mt-0.5 break-words text-xs text-ink-mute">{t.body}</p>}
              </div>
              <button type="button" className="btn-quiet !min-h-7 !p-1" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export const NotificationIcon = Bell;
