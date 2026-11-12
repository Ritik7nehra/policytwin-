'use client';

import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { copyText, cx } from '@/lib/client';

export function Card({ title, icon, right, children, className, bodyClass, id }: { title?: ReactNode; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; id?: string }) {
  return (
    <section id={id} className={cx('card p-5', className)}>
      {(title || right) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && (
            <h2 className="flex items-center gap-2 font-display text-base font-bold sm:text-lg">
              {icon}
              {title}
            </h2>
          )}
          {right}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cx('btn-quiet !min-h-8 !px-2 !py-1 text-xs', className)}
      aria-label={`${label} to clipboard`}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-pass-ink" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span aria-live="polite">{done ? 'Copied' : label}</span>
    </button>
  );
}

/** JSON viewer: wraps (never overflows the page), optional highlighted key, copy action. Values shown are already sanitized by the API. */
export function JsonBlock({ value, highlightKey, className }: { value: unknown; highlightKey?: string; className?: string }) {
  const text = JSON.stringify(value, null, 2);
  const lines = text.split('\n');
  return (
    <div className={cx('relative', className)}>
      <div className="absolute right-1 top-1 z-10">
        <CopyButton text={text} />
      </div>
      <pre className="json pr-20">
        {lines.map((l, i) => {
          const hit = highlightKey && l.trimStart().startsWith(`"${highlightKey}":`);
          return (
            <div key={i} className={hit ? '-mx-3 bg-twin-bg px-3 font-bold text-twin-ink' : undefined}>
              {l}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'bad' | 'good' | 'warn' }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-mute">{label}</dt>
      <dd className={cx('mt-1 font-display text-3xl font-bold tabular-nums', tone === 'bad' && 'text-block-ink', tone === 'good' && 'text-pass-ink', tone === 'warn' && 'text-review-ink')}>{value}</dd>
      {sub && <p className="mt-0.5 text-xs text-ink-mute">{sub}</p>}
    </div>
  );
}
