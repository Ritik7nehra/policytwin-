'use client';

import Link from 'next/link';
import { ChevronRight, FlaskConical, Network, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PolicyRow, PolicyVersionRow, TestRunRow } from '@/lib/store/types';
import { PRODUCT_PREFIX_ALLOWLIST } from '@/lib/validation/schemas';
import { CATEGORY_LABEL } from '@/lib/policy/view';
import { buildAllPairs } from '@/lib/twins/generator';
import type { TestCategory } from '@/lib/types';
import { api, cx, fmtDateTime } from '@/lib/client';
import { useAsync } from '@/lib/hooks';
import { Card } from '../ds/Card';
import { Chip, VerdictBadge } from '../ds/badges';
import { AmbiguityCards, PolicyDiff, PolicyVersionPanel } from '../ds/policy';
import { CardSkeleton, ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import RunConfigDrawer from './RunConfigDrawer';

type RunLite = Omit<TestRunRow, 'report_json' | 'owner_session'>;
type Loaded = { policy: Omit<PolicyRow, 'owner_session'> & { read_only: boolean }; versions: PolicyVersionRow[]; runs: RunLite[] };

/** The payment path the policy touches, as nodes. Affected nodes are filled and labelled in words. */
function ServiceNodes({ affected }: { affected: string[] }) {
  const hit = (n: string) => affected.some((a) => a.toLowerCase().startsWith(n.toLowerCase()));
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="PayPal products on the payment path" data-testid="service-nodes">
      {PRODUCT_PREFIX_ALLOWLIST.map((n, i) => (
        <li key={n} className="flex items-center gap-2">
          <span data-affected={hit(n)} className={cx('rounded-lg border px-3 py-1.5 text-sm font-semibold', hit(n) ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface text-ink-mute')}>
            {n}
            <span className="sr-only">{hit(n) ? ' — affected' : ' — not affected'}</span>
            {hit(n) && <span className="ml-1.5 rounded bg-white px-1 text-[10px] font-bold uppercase tracking-wide text-brand-ink" aria-hidden>affected</span>}
          </span>
          {i < PRODUCT_PREFIX_ALLOWLIST.length - 1 && <ChevronRight className="h-4 w-4 text-ink-mute" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

export default function PolicyWorkspace({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync(async (signal) => {
    let d = await api<Loaded>(`/api/policies/${id}`, { signal });
    if (!d.policy.read_only && d.versions.some((v) => !v.structured_policy_json)) {
      await api(`/api/policies/${id}/analyze`, { method: 'POST', json: {}, signal });
      d = await api<Loaded>(`/api/policies/${id}`, { signal });
    }
    return d;
  }, [id]);
  const [drawer, setDrawer] = useState(false);
  const [showSame, setShowSame] = useState(false);

  const A = data?.versions.find((v) => v.label === 'A');
  const B = data?.versions.find((v) => v.label === 'B');
  const polA = A?.structured_policy_json ?? null;
  const polB = B?.structured_policy_json ?? null;
  const pairCount = useMemo(() => (polB ? buildAllPairs(polB, { adversarial: true }).length : 0), [polB]);

  if (error && !data) {
    const nf = (error as { status?: number }).status === 404;
    return (
      <ErrorRecovery
        title={nf ? 'That policy change does not exist' : 'Could not open this policy change'}
        what={error.message}
        moneyMoved={NO_MONEY_SHADOW}
        safeToRetry="Yes. This only reads data."
        onRetry={reload}
        extra={<Link href="/policies" className="btn-ghost">All policy changes</Link>}
      />
    );
  }
  if (loading || !data) return <div className="space-y-4"><CardSkeleton /><div className="grid gap-4 lg:grid-cols-2"><CardSkeleton /><CardSkeleton /></div></div>;

  const { policy, runs } = data;
  const intake = policy.intake_json;
  const affected = B?.analysis_json?.affected_paypal_products?.length ? B.analysis_json.affected_paypal_products : intake.affected_products;
  const required = (B?.analysis_json?.required_tests ?? []) as TestCategory[];
  const ordered = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="text-xs text-ink-mute"><Link href="/policies" className="hover:underline">Policy changes</Link> <span aria-hidden>/</span> <span className="font-mono">{policy.id}</span></nav>
          <h1 className="mt-1 font-display text-3xl font-bold">{policy.name}</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-mute">{policy.description}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {policy.read_only && <Chip tone="warn">Shared read-only example</Chip>}
            <Chip>Created {fmtDateTime(policy.created_at)}</Chip>
            <Chip tone="info">{pairCount} twin pairs ready</Chip>
          </div>
        </div>
        <button type="button" className="btn-primary !px-5 !py-2.5" onClick={() => setDrawer(true)} disabled={!polB} data-testid="open-run-config">
          <Play className="h-4 w-4" aria-hidden /> Configure & run test
        </button>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-2">
            <PolicyVersionPanel label="A" tone="current" title="Current policy" text={A?.source_text ?? ''} policy={polA} testIdRules="conditions-a" />
            <PolicyVersionPanel label="B" tone="proposed" title="Proposed policy" text={B?.source_text ?? ''} policy={polB} testIdText="proposed-text" testIdRules="conditions" />
          </div>

          <Card title="Ambiguities found" icon={<FlaskConical className="h-5 w-5 text-review-ink" aria-hidden />} right={<Chip tone="warn">{polB?.ambiguities.length ?? 0}</Chip>}>
            {polB ? <AmbiguityCards policy={polB} /> : <p className="text-sm text-ink-mute">Not read yet.</p>}
            <p className="mt-3 text-xs text-ink-mute">The Policy Reader converts text into a schema the application validates; it never executes the text. A gap the code can see cannot be hidden by the model.</p>
          </Card>

          <Card title="Affected PayPal products" icon={<Network className="h-5 w-5 text-brand-ink" aria-hidden />}>
            <ServiceNodes affected={affected} />
            {B?.analysis_json?.rationale && <p className="mt-3 text-sm text-ink-mute">{B.analysis_json.rationale}</p>}
            <h3 className="label mt-4">Required test categories</h3>
            <div className="flex flex-wrap gap-2">{required.length ? required.map((t) => <Chip key={t} tone="info">{CATEGORY_LABEL[t] ?? t}</Chip>) : <span className="text-sm text-ink-mute">None required.</span>}</div>
            <p className="mt-3 text-xs text-ink-mute">Target: {intake.target_markets.join(', ') || '—'} · Expected outcome: {intake.expected_outcome || '—'}</p>
          </Card>

          <Card title="Run history">
            {ordered.length === 0 ? (
              <p className="text-sm text-ink-mute">No test runs yet. Use “Configure & run test”.</p>
            ) : (
              <ul className="space-y-2" data-testid="run-history">
                {ordered.map((r) => (
                  <li key={r.id}>
                    <Link href={`/runs/${r.id}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3 hover:bg-brand-bg/40">
                      <VerdictBadge v={r.release_decision} />
                      <span className="font-mono text-xs">{r.id}</span>
                      <span className="text-sm text-ink-mute">{r.parent_run_id ? 'Re-run of the corrected policy' : 'Initial run'} · {r.stage.toLowerCase()} · {fmtDateTime(r.started_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="order-first space-y-4 lg:order-none lg:sticky lg:top-20 lg:self-start" aria-label="Decision diff">
          <Card title="Decision diff" right={<label className="flex items-center gap-1.5 text-xs font-semibold text-ink-mute"><input type="checkbox" className="accent-[#1769E0]" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} /> show unchanged</label>}>
            {polA && polB ? <PolicyDiff a={polA} b={polB} showSame={showSame} /> : <p className="text-sm text-ink-mute">Waiting for the policy reading.</p>}
            <p className="mt-3 text-xs text-ink-mute">Version A → Version B, field by field. “Gap” means the proposed policy is silent: PolicyTwin will probe it with a twin.</p>
          </Card>
        </aside>
      </div>

      <RunConfigDrawer open={drawer} onOpenChange={setDrawer} policyId={policy.id} policyB={polB} readOnly={policy.read_only} />
    </div>
  );
}
