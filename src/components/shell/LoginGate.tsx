'use client';

import Link from 'next/link';
import { LockKeyhole, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { ApiError, errMsg } from '@/lib/client';
import { DISCLOSURES } from '@/lib/disclosures';
import { useSession } from './SessionProvider';
import { Brand } from './Sidebar';
import { ErrorRecovery } from '../ds/feedback';

export function LoginGate() {
  const { login, session, status, problem, refresh } = useSession();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ex = session?.public_example;
  const exampleRun = ex?.run_ids[ex.run_ids.length - 1];

  if (status === 'unavailable') {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16">
        <ErrorRecovery
          title="PayPal PolicyTwin cannot start"
          what={problem ?? 'The server did not answer.'}
          moneyMoved="No. Nothing was started."
          safeToRetry="Yes."
          next="If you run this server: set DEMO_PASSCODE and SESSION_SECRET (≥16 chars) and restart. If you are a visitor, the host has not finished configuring the demo."
          onRetry={() => void refresh()}
        />
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(pass);
      setPass('');
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 429 ? `${x.message}. Wait a few minutes and try again.` : errMsg(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid min-h-[70vh] max-w-5xl items-center gap-10 px-5 py-12 md:grid-cols-2" data-testid="login-gate">
      <div className="space-y-5">
        <div className="on-navy inline-block rounded-2xl bg-navy p-4">
          <Brand />
        </div>
        <h1 className="font-display text-3xl font-bold leading-tight sm:text-4xl">Test every money rule before it touches real money.</h1>
        <p className="text-ink-mute">A demo environment with fictional policies, synthetic data and simulated payments. Enter the demo passcode to get your own private workspace.</p>
        <ul className="space-y-1.5 text-sm text-ink-mute">
          {DISCLOSURES.slice(0, 4).map((d) => (
            <li key={d}>• {d}</li>
          ))}
        </ul>
      </div>
      <div className="card p-6">
        <form onSubmit={submit} className="space-y-4" data-testid="login-form">
          <div className="flex items-center gap-2 font-display text-xl font-bold">
            <LockKeyhole className="h-5 w-5 text-brand-ink" aria-hidden />
            Enter the demo passcode
          </div>
          <div>
            <label className="label" htmlFor="passcode">
              Passcode
            </label>
            <input id="passcode" name="passcode" type="password" autoComplete="off" required className="field" value={pass} onChange={(e) => setPass(e.target.value)} aria-describedby={err ? 'login-err' : undefined} aria-invalid={err ? true : undefined} data-testid="passcode" />
          </div>
          {err && (
            <p id="login-err" role="alert" className="rounded-lg border border-block/30 bg-block-bg px-3 py-2 text-sm text-block-ink">
              {err}
            </p>
          )}
          <button className="btn-primary w-full" disabled={busy || !pass} type="submit" data-testid="login-submit">
            {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
            Enter workspace
          </button>
          {exampleRun && (
            <p className="text-center text-sm text-ink-mute">
              No passcode? <Link className="font-semibold text-brand-ink underline-offset-2 hover:underline" href={`/runs/${exampleRun}`}>Open the read-only example report</Link>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
