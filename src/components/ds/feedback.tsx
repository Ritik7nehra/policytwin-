'use client';

import { CircleAlert, Inbox, LoaderCircle, RotateCcw, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/client';

export const Spinner = ({ className }: { className?: string }) => <LoaderCircle className={cx('h-4 w-4 animate-spin', className)} aria-hidden />;

/** Skeleton placeholder: announces itself as busy, reserves space (no layout shift). */
export function LoadingSkeleton({ lines = 3, className, label = 'Loading' }: { lines?: number; className?: string; label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={cx('space-y-3', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cx('card p-5', className)} role="status" aria-busy="true" aria-label="Loading">
      <div className="skeleton mb-4 h-5 w-1/3" />
      <LoadingSkeleton lines={4} />
    </div>
  );
}

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center', className)}>
      <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-brand-bg text-brand-ink">{icon ?? <Inbox className="h-5 w-5" aria-hidden />}</div>
      <h3 className="font-display text-lg font-bold">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-ink-mute">{children}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * Every error answers four questions: what failed · did money move in the Sandbox · is it safe to retry · what next.
 */
export function ErrorRecovery({
  title,
  what,
  moneyMoved,
  safeToRetry,
  next,
  onRetry,
  retryLabel = 'Try again',
  extra,
  reference,
  className,
}: {
  title: string;
  what: ReactNode;
  moneyMoved: ReactNode;
  safeToRetry: ReactNode;
  next?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  extra?: ReactNode;
  reference?: string;
  className?: string;
}) {
  return (
    <div role="alert" data-testid="error-recovery" className={cx('rounded-xl border border-block/30 bg-block-bg/60 p-5', className)}>
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-block-ink" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-base font-bold text-block-ink">{title}</h3>
          <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[11rem_1fr]">
            <dt className="font-semibold text-ink">What failed</dt>
            <dd className="break-words text-ink">{what}</dd>
            <dt className="font-semibold text-ink">Did money move?</dt>
            <dd className="text-ink">{moneyMoved}</dd>
            <dt className="font-semibold text-ink">Safe to retry?</dt>
            <dd className="text-ink">{safeToRetry}</dd>
            {next && (
              <>
                <dt className="font-semibold text-ink">What you can do</dt>
                <dd className="text-ink">{next}</dd>
              </>
            )}
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {onRetry && (
              <button type="button" className="btn-primary" onClick={onRetry}>
                <RotateCcw className="h-4 w-4" aria-hidden />
                {retryLabel}
              </button>
            )}
            {extra}
            {reference && <span className="font-mono text-[11px] text-ink-mute">ref {reference}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The standard "no Sandbox money moved" statements, so every screen words them identically and truthfully. */
export const NO_MONEY_SHADOW = (
  <span className="inline-flex items-start gap-1.5">
    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-pass-ink" aria-hidden />
    <span>No. The full run executes on the simulator, so no PayPal Sandbox money moves. The Sandbox is only touched when you press “Verify in PayPal Sandbox”.</span>
  </span>
);
