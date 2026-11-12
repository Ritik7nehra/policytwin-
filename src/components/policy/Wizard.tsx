'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, FilePlus2, LoaderCircle, RotateCcw, Save } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { DEMO_POLICY_INPUT } from '@/lib/policy/demo';
import { readPolicyOffline } from '@/lib/policy/reader';
import type { Policy } from '@/lib/policy/schema';
import { PRODUCT_PREFIX_ALLOWLIST, LIMITS, PolicyIntakeSchema } from '@/lib/validation/schemas';
import { api, cx, errMsg } from '@/lib/client';
import { useStoredState } from '@/lib/hooks';
import { AmbiguityCards, PolicyDiff } from '../ds/policy';
import { Card } from '../ds/Card';
import { CardSkeleton, ErrorRecovery, NO_MONEY_SHADOW } from '../ds/feedback';
import { useToast } from '../ds/Toast';
import { ProvenanceBadge } from '../ds/badges';

interface Form {
  name: string;
  business_reason: string;
  current_policy: string;
  proposed_policy: string;
  affected_products: string;
  target_markets: string;
  expected_outcome: string;
}
const DEMO: Form = { ...DEMO_POLICY_INPUT, affected_products: DEMO_POLICY_INPUT.affected_products.join(', '), target_markets: DEMO_POLICY_INPUT.target_markets.join(', ') };
const BLANK: Form = { name: '', business_reason: '', current_policy: '', proposed_policy: '', affected_products: '', target_markets: '', expected_outcome: '' };
const MARKET_CHIPS = ['US / USD', 'EU / EUR', 'UK / GBP'];
const STEPS = ['Describe the change', 'Write the policies', 'Review & create'] as const;

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function fieldErrors(f: Form): Record<string, string> {
  const r = PolicyIntakeSchema.safeParse({ ...f, affected_products: list(f.affected_products), target_markets: list(f.target_markets) });
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) {
    const key = String(i.path[0] ?? 'form');
    if (!out[key]) out[key] = i.path.length > 1 ? `Entry ${Number(i.path[1]) + 1}: ${i.message}` : i.message;
  }
  // Plain-language versions of the common ones.
  if (out.name && f.name.trim() === '') out.name = 'Give the change a short name.';
  if (out.current_policy && f.current_policy.trim() === '') out.current_policy = 'Describe how the policy works today.';
  if (out.proposed_policy && f.proposed_policy.trim() === '') out.proposed_policy = 'Describe the proposed change.';
  return out;
}
const STEP_FIELDS: string[][] = [['name', 'business_reason', 'affected_products', 'target_markets', 'expected_outcome'], ['current_policy', 'proposed_policy'], []];

function read(text: string, name: string, ctx: string): Policy | null {
  if (!text.trim()) return null;
  try {
    return readPolicyOffline(text, name || 'Policy', ctx);
  } catch {
    return null;
  }
}

function Field({ id, label, hint, error, children, count, max }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode; count?: number; max?: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label className="label" htmlFor={id}>{label}</label>
        {max !== undefined && count !== undefined && <span className={cx('text-[11px]', count > max ? 'font-bold text-block-ink' : 'text-ink-mute')}>{count}/{max}</span>}
      </div>
      {children}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs text-ink-mute">{hint}</p>}
      {error && <p id={`${id}-err`} role="alert" className="mt-1 text-xs font-semibold text-block-ink">{error}</p>}
    </div>
  );
}

export default function Wizard() {
  const router = useRouter();
  const { push } = useToast();
  const uid = useId();
  const [form, setForm, hydrated] = useStoredState<Form>('pt:policy-draft:v1', DEMO);
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | 'create' | 'read'>(null);
  const [error, setError] = useState<Error | null>(null);

  const errors = useMemo(() => fieldErrors(form), [form]);
  const shown = (k: string) => (touched.has(k) || touched.has('*') ? errors[k] : undefined);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const touch = (k: string) => () => setTouched((t) => new Set(t).add(k));
  const stepValid = (s: number) => STEP_FIELDS[s].every((k) => !errors[k]);

  const ctx = `${form.name} ${form.current_policy}`;
  const polA = useMemo(() => read(form.current_policy, 'Current', ctx), [form.current_policy, ctx]);
  const polB = useMemo(() => read(form.proposed_policy, 'Proposed', ctx), [form.proposed_policy, ctx]);

  const products = list(form.affected_products);
  const toggle = (key: 'affected_products' | 'target_markets', value: string) => {
    const cur = list(form[key]);
    const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
    setForm({ ...form, [key]: next.join(', ') });
  };

  const FIELD_ID: Record<string, string> = { business_reason: 'reason', current_policy: 'current', proposed_policy: 'proposed', affected_products: 'products', target_markets: 'markets', expected_outcome: 'outcome' };
  /** Move keyboard focus (and the viewport) to the first field that needs fixing, so the error is seen and announced. */
  function focusFirstInvalid(s: number) {
    const k = STEP_FIELDS[s].find((x) => errors[x]);
    if (k) window.setTimeout(() => document.getElementById(FIELD_ID[k] ?? k)?.focus(), 0);
  }

  function next() {
    setTouched((t) => new Set([...t, ...STEP_FIELDS[step]]));
    if (stepValid(step)) setStep((s) => Math.min(2, s + 1));
    else focusFirstInvalid(step);
  }

  async function submit() {
    setTouched(new Set(['*']));
    if (Object.keys(errors).length) {
      const s0 = STEP_FIELDS[0].some((k) => errors[k]) ? 0 : 1;
      setStep(s0);
      focusFirstInvalid(s0);
      return;
    }
    setBusy('create');
    setError(null);
    let id: string | null = null;
    try {
      const created = await api<{ policy: { id: string } }>('/api/policies', { json: { ...form, affected_products: products, target_markets: list(form.target_markets) } });
      id = created.policy.id;
      setBusy('read');
      await api(`/api/policies/${id}/analyze`, { method: 'POST', json: {} });
      push({ title: 'Policy change created', body: 'The policy was read and checked for gaps. Review it, then run the test.' });
      router.push(`/policies/${id}`);
    } catch (e) {
      // The policy may exist already (created, but not yet read). The workspace page reads it on open, so go there.
      if (id) {
        router.push(`/policies/${id}`);
        return;
      }
      setError(e as Error);
      setBusy(null);
    }
  }

  if (!hydrated) return <CardSkeleton />;

  const input = (k: keyof Form, extra: Record<string, unknown> = {}) => ({
    id: k === 'business_reason' ? 'reason' : k === 'current_policy' ? 'current' : k === 'proposed_policy' ? 'proposed' : k === 'affected_products' ? 'products' : k === 'target_markets' ? 'markets' : k === 'expected_outcome' ? 'outcome' : k,
    value: form[k],
    onChange: set(k),
    onBlur: touch(k),
    'aria-invalid': shown(k) ? true : undefined,
    'aria-describedby': shown(k) ? `${k === 'business_reason' ? 'reason' : k}-err` : undefined,
    className: 'field',
    ...extra,
  });

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.1em] text-ink-mute">New policy change</p>
        <h1 className="font-display text-3xl font-bold">Describe the policy you want to test</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-mute">Fictional policies only. Nothing here is connected to a real PayPal rule. The draft is saved on this device as you type.</p>
      </header>

      <ol aria-label="Wizard steps" className="grid gap-2 sm:grid-cols-3" data-testid="wizard-steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined}>
            <button type="button" onClick={() => (i <= step || stepValid(step) ? setStep(i) : next())} className={cx('flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm font-semibold transition', i === step ? 'border-brand bg-brand-bg' : i < step ? 'border-pass/40 bg-pass-bg/50' : 'border-line bg-surface hover:border-brand/40')}>
              <span className={cx('grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold', i < step ? 'bg-pass text-white' : i === step ? 'bg-brand text-white' : 'bg-surface-2 text-ink-mute')}>{i < step ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      <form
        data-testid="policy-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (step < 2) next();
          else void submit();
        }}
        className="grid gap-5 lg:grid-cols-[3fr_2fr]"
      >
        <div className="space-y-5">
          {step === 0 && (
            <Card title="1 · Describe the change" bodyClass="space-y-4">
              <Field id="name" label="Policy name" error={shown('name')} max={LIMITS.name} count={form.name.length}>
                <input {...input('name')} required autoComplete="off" />
              </Field>
              <Field id="reason" label="Business reason" error={shown('business_reason')} hint="Why is this change being considered?" max={LIMITS.reason} count={form.business_reason.length}>
                <input {...input('business_reason')} />
              </Field>
              <Field id="products" label="Affected PayPal products" error={shown('affected_products')} hint="Comma-separated. Must start with a supported product (use the suggestions).">
                <input {...input('affected_products')} />
                <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Suggested products">
                  {PRODUCT_PREFIX_ALLOWLIST.map((p) => {
                    const on = products.some((x) => x.toLowerCase().startsWith(p.toLowerCase()));
                    return (
                      <button key={p} type="button" aria-pressed={on} onClick={() => toggle('affected_products', p)} className={cx('rounded-full border px-2.5 py-1 text-xs font-semibold', on ? 'border-brand bg-brand-bg text-brand-ink' : 'border-line-strong bg-surface text-ink-mute hover:border-brand/50')}>
                        {on && <Check className="mr-1 inline h-3 w-3" aria-hidden />}
                        {p}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field id="markets" label="Target countries / currencies" error={shown('target_markets')} hint="Supported currencies: USD, EUR, GBP.">
                <input {...input('target_markets')} />
                <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Suggested markets">
                  {MARKET_CHIPS.map((m) => {
                    const on = list(form.target_markets).includes(m);
                    return (
                      <button key={m} type="button" aria-pressed={on} onClick={() => toggle('target_markets', m)} className={cx('rounded-full border px-2.5 py-1 text-xs font-semibold', on ? 'border-brand bg-brand-bg text-brand-ink' : 'border-line-strong bg-surface text-ink-mute hover:border-brand/50')}>
                        {on && <Check className="mr-1 inline h-3 w-3" aria-hidden />}
                        {m}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field id="outcome" label="Expected outcome" error={shown('expected_outcome')} max={LIMITS.reason} count={form.expected_outcome.length}>
                <input {...input('expected_outcome')} />
              </Field>
            </Card>
          )}

          {step === 1 && (
            <Card title="2 · Write the policies" bodyClass="space-y-4">
              <Field id="current" label="Current policy (Version A)" error={shown('current_policy')} max={LIMITS.policyText} count={form.current_policy.length}>
                <textarea {...input('current_policy')} required className="field min-h-28" />
              </Field>
              <Field id="proposed" label="Proposed policy (Version B)" error={shown('proposed_policy')} hint="Write it the way a policy owner would. Do not try to make it airtight — gaps are what PolicyTwin finds." max={LIMITS.policyText} count={form.proposed_policy.length}>
                <textarea {...input('proposed_policy')} required className="field min-h-36" />
              </Field>
            </Card>
          )}

          {step === 2 && (
            <Card title="3 · Review & create" bodyClass="space-y-4">
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                {[
                  ['Name', form.name],
                  ['Business reason', form.business_reason || '—'],
                  ['Products', products.join(', ') || '—'],
                  ['Markets', form.target_markets || '—'],
                  ['Expected outcome', form.expected_outcome || '—'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="label !mb-0.5">{k}</dt>
                    <dd className="break-words">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="grid gap-3 md:grid-cols-2">
                <blockquote className="rounded-lg border-l-4 border-ink/30 bg-surface-2 px-4 py-3 text-sm"><b className="mb-1 block text-xs uppercase tracking-wide text-ink-mute">Version A</b>{form.current_policy}</blockquote>
                <blockquote className="rounded-lg border-l-4 border-brand bg-brand-bg/50 px-4 py-3 text-sm"><b className="mb-1 block text-xs uppercase tracking-wide text-ink-mute">Version B</b>{form.proposed_policy}</blockquote>
              </div>
              <div className="rounded-xl bg-surface-2 p-4 text-sm">
                <p className="mb-1 font-display text-base font-bold">What happens when you create it</p>
                <ol className="list-decimal space-y-1 pl-5 text-ink-mute">
                  <li>Both versions are saved to your private workspace.</li>
                  <li>The Policy Reader proposes a structured reading; a schema validates it.</li>
                  <li>You land on the Policy Workspace. <b className="text-ink">No test runs yet</b> — you start it there.</li>
                </ol>
              </div>
              {error && (
                <ErrorRecovery
                  title="The policy change could not be created"
                  what={errMsg(error)}
                  moneyMoved={NO_MONEY_SHADOW}
                  safeToRetry="Yes. Nothing was saved, so retrying cannot create a duplicate."
                  onRetry={() => void submit()}
                />
              )}
            </Card>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost" onClick={() => { setForm(DEMO); setTouched(new Set()); setStep(0); }} disabled={!!busy} data-testid="reset-demo">
                <RotateCcw className="h-4 w-4" aria-hidden /> Reset to demo example
              </button>
              <button type="button" className="btn-quiet" onClick={() => { setForm(BLANK); setTouched(new Set()); setStep(0); }} disabled={!!busy}>
                <FilePlus2 className="h-4 w-4" aria-hidden /> Start blank
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden items-center gap-1 text-xs text-ink-mute sm:inline-flex"><Save className="h-3.5 w-3.5" aria-hidden /> Draft saved on this device</span>
              {step > 0 && (
                <button type="button" className="btn-ghost" onClick={() => setStep(step - 1)} disabled={!!busy} data-testid="wizard-back">
                  <ArrowLeft className="h-4 w-4" aria-hidden /> Back
                </button>
              )}
              {step < 2 ? (
                <button key="next" type="submit" className="btn-primary" data-testid="wizard-next">
                  Next <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
              ) : (
                <button key="create" type="submit" className="btn-primary" disabled={!!busy} data-testid="create-policy">
                  {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
                  {busy === 'read' ? 'Reading policy…' : busy === 'create' ? 'Creating…' : 'Create & analyze policy'}
                </button>
              )}
            </div>
          </div>
        </div>

        <aside aria-label="Live preview" className="space-y-4 lg:sticky lg:top-20 lg:self-start" data-testid="live-preview">
          <Card title="Live preview" right={<ProvenanceBadge kind="deterministic" compact />}>
            <p className="mb-3 text-xs text-ink-mute">
              Read in your browser by the deterministic reader as you type. The saved policy is read again on the server (by the AI Policy Reader if configured) and checked by the same schema.
            </p>
            {polA && polB ? (
              <div className="space-y-4">
                <PolicyDiff a={polA} b={polB} />
                <div>
                  <h3 className="label">Gaps this change leaves open ({polB.ambiguities.length})</h3>
                  {polB.ambiguities.length === 0 ? <p className="text-sm text-ink-mute">None detected.</p> : (
                    <ul className="list-disc space-y-1 pl-5 text-xs text-review-ink">
                      {polB.ambiguities.slice(0, 6).map((a) => <li key={a}>{a}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-line-strong p-4 text-sm text-ink-mute">Write both policies (step 2) to see the field-by-field comparison here.</p>
            )}
          </Card>
          {step === 2 && polB && (
            <Card title="Ambiguities to expect"><AmbiguityCards policy={polB} testId="preview-ambiguities" /></Card>
          )}
        </aside>
      </form>
    </div>
  );
}
