'use client';

import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import { LoaderCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/client';

/** Accessible tooltip (keyboard-focusable triggers, 250 ms delay, optional shortcut hint). */
export function Tip({ label, shortcut, children, side = 'bottom' }: { label: ReactNode; shortcut?: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={6} collisionPadding={12} className="z-[70] max-w-[280px] animate-fade-in rounded-lg bg-navy px-3 py-2 text-xs leading-snug text-white shadow-lift">
          {label}
          {shortcut && (
            <span className="ml-2 inline-flex gap-1 align-middle">
              {shortcut.split(' ').map((k) => (
                <kbd key={k} className="rounded border border-white/30 bg-white/10 px-1 font-mono text-[10px]">
                  {k}
                </kbd>
              ))}
            </span>
          )}
          <Tooltip.Arrow className="fill-navy" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <Tooltip.Provider delayDuration={250} skipDelayDuration={300}>
    {children}
  </Tooltip.Provider>
);

const overlayCls = 'fixed inset-0 z-[60] bg-navy/50 backdrop-blur-[2px] data-[state=open]:animate-fade-in';

/** Modal confirmation with focus trap, Esc to cancel and an explicit description of the consequence. */
export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger' | 'pass';
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayCls} />
        <Dialog.Content data-testid="confirm-dialog" className="fixed left-1/2 top-1/2 z-[61] w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 animate-rise-in rounded-2xl border border-line bg-surface p-6 shadow-lift focus:outline-none">
          <Dialog.Title className="font-display text-xl font-bold">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 space-y-2 text-sm text-ink-mute">{description}</div>
          </Dialog.Description>
          {children && <div className="mt-4">{children}</div>}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy} data-testid="confirm-dialog-cancel">
              {cancelLabel}
            </button>
            <button type="button" className={tone === 'danger' ? 'btn-danger' : tone === 'pass' ? 'btn-pass' : 'btn-primary'} onClick={onConfirm} disabled={busy} data-testid="confirm-dialog-confirm">
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Modal side sheet (right drawer on desktop, full-screen on phones). */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  side = 'right',
  full = false,
  testId,
  footer,
  hideTitle = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  side?: 'right' | 'left';
  full?: boolean;
  testId?: string;
  footer?: ReactNode;
  hideTitle?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayCls} />
        <Dialog.Content
          data-testid={testId}
          className={cx(
            'fixed z-[61] flex flex-col bg-surface shadow-drawer focus:outline-none',
            full ? 'inset-0 animate-sheet-in' : cx('inset-y-0 w-[min(94vw,32rem)]', side === 'right' ? 'right-0 animate-drawer-in border-l border-line' : 'left-0 animate-drawer-in border-r border-line'),
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className={hideTitle ? 'sr-only' : undefined}>
              <Dialog.Title className="font-display text-lg font-bold">{title}</Dialog.Title>
              {description && <Dialog.Description className="mt-0.5 text-sm text-ink-mute">{description}</Dialog.Description>}
            </div>
            <Dialog.Close className="btn-quiet !p-2" aria-label="Close">
              <X className="h-5 w-5" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" tabIndex={0} role="region" aria-label={`${title} content`}>{children}</div>
          {footer && <div className="border-t border-line bg-surface-2 px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { Dialog };
