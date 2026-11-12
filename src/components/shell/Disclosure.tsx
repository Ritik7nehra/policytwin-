import { ShieldCheck } from 'lucide-react';
import { DISCLOSURES, PIPELINE_MOTTO, TAGLINE } from '@/lib/disclosures';

/** Always visible, on every screen. Short, plain, and the same wording everywhere. */
export function DisclosureStrip() {
  return (
    <div role="note" aria-label="Safety disclosures" data-testid="disclosure-strip" className="border-b border-review/30 bg-review-bg text-review-ink">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-3 py-1.5 text-[11px] font-semibold leading-snug sm:px-5">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Sandbox and synthetic data only
        </span>
        <span>Not an official PayPal internal system</span>
        <span className="hidden md:inline">AI proposes; deterministic code verifies; a human decides</span>
      </p>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="mt-12 border-t border-line bg-surface" data-testid="footer">
      <div className="px-4 py-6 text-xs text-ink-mute sm:px-6">
        <p className="mb-2 font-display text-sm font-bold text-ink">{PIPELINE_MOTTO}</p>
        <ul className="mb-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {DISCLOSURES.map((d) => (
            <li key={d}>• {d}</li>
          ))}
        </ul>
        <p>{TAGLINE}</p>
        <p className="mt-2">“PayPal” is a trademark of PayPal, Inc. PayPal PolicyTwin is an independent prototype and is not affiliated with, endorsed by, or an official system of PayPal.</p>
      </div>
    </footer>
  );
}
