# PayPal PolicyTwin

> **PolicyTwin helps teams discover policy ambiguity and financial regressions before release.**

[![Live on Render](https://img.shields.io/badge/Render-Live%20Demo-46E3B7?logo=render&logoColor=white)](https://policytwin.onrender.com)
🔗 **Live Website**: [https://policytwin.onrender.com](https://policytwin.onrender.com)

Counterfactual testing for financial-policy changes. Give it the current policy and a proposed one; it generates
*transaction twins* — pairs of transactions that differ in exactly one fact — runs both policy versions on each,
replays the payment operations (on an in-process simulator for the full run; optionally in the real PayPal Sandbox for a selected pair) and reports where the
new policy behaves in ways nobody wrote down. The interface is the **Financial Intelligence Control Room**.

```
AI proposes  →  Code validates  →  Sandbox executes  →  Code verifies  →  Human decides
```

## Read this first (disclosures)

- The policies are **fictional examples**.
- The impact data is **synthetic**. Every impact figure is labelled "Synthetic impact estimate — not PayPal data".
- The Sandbox uses **test money** (or an in-process simulator, clearly labelled "Simulated · not PayPal", when no Sandbox credentials are set).
- PolicyTwin does **not represent PayPal's current internal systems** and is **not an official PayPal system**. "PayPal" is a trademark of PayPal, Inc.
- It is **not legal or compliance advice**, and it makes no claim of regulatory certification or of guaranteed safety.
- The AI recommends; **deterministic rules verify**.
- **A human makes the final release decision.** PASS is a recommendation, never an approval.

These appear in the UI (a strip under the top bar, the footer and the help dialog), in every report, and in `GET /api/health`.

## Quick start (works offline, no keys)

```bash
npm install
npm run dev            # http://localhost:3000   (local mode: open access, shared "local" workspace)
npm run demo           # the same flow in the terminal; writes HTML reports to ./out
```

With no environment variables the app uses the deterministic agents, the simulated PayPal and an in-memory store.
Click **Run demo scenario** (sidebar or hero) for the guided run, or **New policy change** (a 3-step wizard pre-filled with the demo) → **Run twin tests**.

> **Production mode needs a passcode.** `NODE_ENV=production` (e.g. `next start`) without `DEMO_PASSCODE` **and** `SESSION_SECRET` makes every protected
> endpoint answer 503 `AUTH_NOT_CONFIGURED` — the app fails closed instead of running open on the internet.

**The demo story**

| Step | What happens |
|---|---|
| Version A | "All missing-delivery claims require manual review." |
| Version B (proposed) | "Automatically refund transactions of $50 or less when tracking information is unavailable." |
| Run | 6 core twin pairs + 4 adversarial pairs (20 scenarios) on the deterministic engine and the payment simulator, 8 invariants checked on each |
| Result | **BLOCK** — digital goods and open disputes are auto-refunded; a retried request refunds twice; a duplicate webhook repeats the refund and regresses local state; EUR vs USD is ambiguous |
| Repair | The Policy Repair agent proposes **Version C** (plain English + a change list). A human approves it |
| Re-run | Every scenario re-runs against C → **PASS** (the original objective — auto-refund physical goods ≤ $50 — is preserved) |
| Decision | A human approves or rejects the release. A BLOCK cannot be approved; a REVIEW needs a written justification. The guided demo **stops at the Release Gate** and never approves anything for you |

## The interface

| Screen | Route | What it is |
|---|---|---|
| Overview | `/` | Hero with an **interactive twin lab** (change one field, see both policies decide, using the real engine in the browser), the six-stage pipeline, and metrics that are real counts from stored runs (scope stated, nothing invented) |
| Policy changes | `/policies` | List with the verdicts of each run |
| New policy change | `/policies/new` | 3-step wizard with per-field validation, a draft saved on this device, and a live field-by-field diff + the gaps the change leaves open |
| Policy workspace | `/policies/:id` | Version A vs B panels, extracted conditions, ambiguities explained, PayPal products on the payment path, run history; the **run-configuration drawer** starts a run and shows 7 stages of progress |
| Test run | `/runs/:id?tab=matrix\|inspector\|gate` | Sticky header (the recommendation is labelled "not an approval") and URL-synced tabs: **Transaction twin matrix** (themed AG Grid, filters, search, CSV export; a card list on phones), **Scenario inspector** (twins with the changed field marked, decision path, every payment operation with SIMULATED/SANDBOX labelling, invariants, **Lane 2**), **Release gate** |
| Evidence · Reports · Status | `/evidence` `/reports` `/status` | What actually ran and where (Lane 1 vs Lane 2), shareable reports, modes / dependency breakers / webhook queue |
| Everywhere | | Command palette (`Ctrl/⌘+K` or `/`), help (`?`), skip link, toasts, loading / empty / error states, a docked non-modal evidence drawer on desktop and a full-screen sheet on phones |

Design tokens, the contrast measurements behind them, the component inventory and the accessibility status are in [`docs/DESIGN_TOKENS.md`](docs/DESIGN_TOKENS.md).

## How it works

### Six agent roles (OpenAI Structured Outputs when `OPENAI_API_KEY` is set)

| Agent | Proposes | Code then… |
|---|---|---|
| Policy Reader | policy → structured JSON | validates with zod; re-derives threshold/currency/action/trigger and corrects the model; deletes invented exceptions, restores hidden ones; ambiguities can be added by the model but not hidden |
| Policy Impact Mapper | affected resources, states, products, required tests | schema-validated (test categories are an enum); any required category the code can derive is added if the model omitted it |
| Twin Generator | the 6 core pairs | every pair must change **exactly one** declared causal field, or it is dropped; missing causal variables are filled from the deterministic generator; rationales that don't cite the changed values are replaced; the expectation (must differ / must match) always comes from the catalog, never the model |
| Adversarial Scenario Agent | extra edge cases (exact boundary, evidence status, customer history, void-then-capture) | same guard as above |
| Impact Analyst | plain-language explanation | a narrative containing any figure outside the synthetic model is rejected; each per-finding explanation must cite the changed values or is replaced; it never touches a verdict |
| Policy Repair | corrected structured policy + change list | rejected if it alters the business objective (action, cap, currency, boundary, condition, trigger); the English text is regenerated from the structure, so what a human approves is what the engine runs; the re-run then shows whether it really passes |

With no key, each agent runs a deterministic implementation. If model output fails validation or a guard, the agent falls back to it.
Every call is recorded in `agent_runs` (input hash, model, status, corrections). The UI never shows model reasoning, only validated output.
The wizard's *live preview* uses the deterministic reader in the browser; the saved policy is read again on the server (by the AI Policy Reader if configured) and checked by the same schema.

### The oracle is code, not a model

- `src/lib/policy/engine.ts` — deterministic policy engine. Where a policy is silent it is applied **literally** and a flag is raised
  (e.g. a tracking rule is applied to digital goods → `PRODUCT_SCOPE_UNDEFINED`). A policy that says nothing about retries gets a new
  `PayPal-Request-Id` per attempt; one that says nothing about duplicate webhooks gets a last-write-wins handler. That *literal-implementation*
  model is what lets PolicyTwin show the consequence of an unwritten rule.
- `src/lib/twins/catalog.ts` — for each causal field: must the decision differ or match, in which category, how severe if violated.
- `src/lib/analysis/invariants.ts` — eight financial invariants (the spec's seven plus *no automatic refund while a dispute is open*).
- `src/lib/analysis/release.ts` — **BLOCK** on any invariant failure or critical finding · **REVIEW** on high/medium findings, missing required
  coverage, execution errors, or any policy term PolicyTwin could not execute/test · **PASS** otherwise.

### Two lanes — never blurred

| | Lane 1 · full run | Lane 2 · sandbox proof |
|---|---|---|
| Scope | every scenario of the run (10 pairs / 20 scenarios) | one pair, chosen by the person (`Verify in PayPal Sandbox`) |
| Executes on | **always** the deterministic engine + `SimulatedPayPal` (`lane='shadow'`) | the configured adapter: the real PayPal Sandbox when credentials exist, otherwise the simulator **and labelled SIMULATED** (`lane='sandbox_proof'`) |
| Effect on the verdict | decides it | **none** — it attaches evidence; the Lane-1 verdict is never changed |
| Idempotent | resumable per stage | yes — repeating a pair returns the stored proof |

Endpoint: `POST /api/test-runs/:id/sandbox-proof {pair_id}`. The UI states plainly which lane and mode produced any piece of evidence.

### PayPal

| | Simulated (default) | Sandbox (`PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET`) |
|---|---|---|
| Adapter | `SimulatedPayPal` (in-process) | `PayPalSandboxAdapter` (REST v2: OAuth, create/confirm/capture order, authorize/void, refund, get, verify-webhook-signature) |
| Idempotency | `PayPal-Request-Id` replay by method+path+id | PayPal's own; retries reuse the **same** request id |
| Safety | labelled "not PayPal" | hard guard: any host other than `api-m.sandbox.paypal.com` / `api.sandbox.paypal.com` throws at construction |
| Resilience | | timeouts, bounded retries with back-off, a circuit breaker per dependency (visible on `/status`) |

Request ids are `<run>-<scenario>-<operation>`, e.g. `run_204-scenario_06-refund`.

**Webhook flow** (`POST /api/webhooks/paypal`): receive → verify signature → record the event with a lifecycle
(`RECEIVED → VERIFIED → PROCESSING → PROCESSED`, or `FAILED_RETRYABLE` / `FAILED_PERMANENT`) → enqueue a durable job (PostgreSQL `jobs` table, claimed by
compare-and-set + lease, so several instances are safe) → the worker fetches the canonical PayPal resource and updates local state only if it is newer.
A duplicate delivery is ignored **only once the event is `PROCESSED`**, so a crash mid-processing is retried rather than lost. The receiver returns 200 for duplicates so PayPal stops retrying.

### Run state machine

`CREATED → GENERATING → TWINS_READY → EVALUATING → EVALUATED → EXECUTING → COMPLETED → DECIDED` — idempotent per stage, held under a lease while a stage runs, with the failed stage
and error recorded. `POST /api/test-runs/:id/resume` continues from the last completed stage and never repeats finished work. Database constraints (CHECK / UNIQUE / FOREIGN KEY) and an
optimistic-concurrency `rev` on the report enforce the same rules in PostgreSQL and in the in-memory store.

### Access control and abuse limits

- Visitors enter `DEMO_PASSCODE` once and receive a signed (HMAC), HttpOnly, SameSite=Lax session cookie (`pt_session`, `Secure` over https). The actor name (e.g. `demo.judge#ab12cd`) is **derived by the server** — a client cannot choose or spoof who made a decision.
- Every session sees only its own policies and runs (cross-session access → 403). The **shared read-only example** (`pol_public_example`) is readable without signing in and cannot be changed.
- CSRF protection on state-changing requests; per-session **and** per-IP rate buckets (read / write / heavy / login / webhook); per-session quotas for runs and policies; a daily cap on LLM-backed agent calls (beyond it the deterministic agents run).
- Everything written to logs, evidence or reports passes the **financial-evidence sanitizer**: only method, endpoint, request id, amount, currency, status and resource ids are kept. Card data, tokens and secrets are never stored, logged, returned or rendered.
- All request bodies are validated with zod; malformed ids are rejected with 400.

### Data

PostgreSQL via `DATABASE_URL` (else in-memory). `db/schema.sql` is generated from one table definition (`npm run db:schema`) and a test asserts they match.
Tables: `policies, policy_versions, test_runs, run_stages, scenarios, policy_decisions, paypal_executions, invariant_results, agent_runs, audit_events, webhook_events, resource_states, jobs`.
**Schema v2 needs a fresh database** — the app refuses to start on a v1 schema rather than guess a migration.

### REST API

| Method & path | Purpose |
|---|---|
| `POST /api/session` · `DELETE /api/session` · `GET /api/session` · `POST /api/session/reset` | sign in / out · who am I and what are my limits · delete this session's data |
| `POST /api/policies` · `GET /api/policies` · `GET /api/policies/:id` | create / list / read a policy change |
| `POST /api/policies/:id/analyze` · `POST /api/policies/:id/versions` | structured logic + impact map · add a version |
| `POST /api/test-runs` (`run_all`, `adversarial`) · `GET /api/test-runs` · `GET /api/test-runs/:id` | create run / list / read |
| `POST /api/test-runs/:id/generate-twins` · `/evaluate` · `/execute` · `/resume` | the pipeline stages, individually or resumed |
| `POST /api/test-runs/:id/sandbox-proof` | Lane 2: one pair in the configured adapter |
| `POST /api/test-runs/:id/approve-repair` | human approves Version C → full re-run |
| `POST /api/test-runs/:id/decision` | human final decision (`approve` / `reject` + note) |
| `GET /api/test-runs/:id/report` (`?download=1`, `?format=json`) | standalone HTML release report |
| `GET /api/overview` · `GET /api/evidence` | real counts for the overview · per-run Lane 1 / Lane 2 evidence |
| `POST /api/webhooks/paypal` · `GET /api/health` | webhook receiver · runtime, queue, breakers and disclosures |

## Configuration

Copy `.env.example`. Everything is optional for local development; the access-control pair is **required in production**.

| Variable | Effect |
|---|---|
| `DEMO_PASSCODE`, `SESSION_SECRET` (≥ 16 chars), `SESSION_TTL_HOURS` | access control (fail-closed in production without both) |
| `MAX_RUNS_PER_SESSION`, `MAX_POLICIES_PER_SESSION`, `MAX_AI_CALLS_PER_DAY`, `RATE_LIMIT_*` | abuse limits |
| `DATABASE_URL`, `DATABASE_SSL=true` | PostgreSQL instead of memory |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | real structured-output agents (default model `gpt-4o` — check OpenAI's current model list) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID` | PayPal Sandbox |
| `PAYPAL_ALLOW_DIRECT_CARD_SANDBOX`, `PAYPAL_SANDBOX_CARD_NUMBER` / `_EXPIRY` / `_NAME` | **Off by default.** Lets a server confirm a Sandbox order with a Sandbox *test* card. Card data comes only from the environment, is never hard-coded, stored, logged or returned. See the PCI note below |
| `PAYPAL_LIVE_TESTS`, `EVAL_LIVE`, `EVIDENCE_DIR` | opt-in live validation ([`docs/LIVE_VALIDATION.md`](docs/LIVE_VALIDATION.md)) |

**Direct-card testing and PCI.** PayPal's documentation states that handling raw card numbers on your own server requires PCI **SAQ D** compliance and recommends the JavaScript SDK / **Hosted Fields**,
which this project does **not** implement. Use only Sandbox test cards, and treat that switch as a development convenience, not a production pattern.

## Tests

```bash
npm run typecheck
TEST_DATABASE_URL=postgres://…/policytwin_test npm test   # unit + integration + evals (offline; the DB URL adds the real-PostgreSQL suite)
npm run build && PW_CHROMIUM_PATH=/path/to/chromium npm run test:e2e   # Playwright against `next start` (PW_CHROMIUM_PATH only if the expected browser build is missing)
```

| Layer | What it covers |
|---|---|
| **Unit** | money math, policy reader + text round-trip, engine on A/B/C, twin single-change validation, all 8 invariants (pass and fail traces), release logic, webhook ordering/dedupe, unmodelled exceptions, the sanitizer, resilience primitives, `db/schema.sql` ↔ definitions, and the UI view-models (policy diff / rule rows, matrix filters and search, CSV export with formula-injection guard) |
| **Integration** | simulated PayPal, live adapter against an injected fake transport (hosts, paths, headers, bodies, error mapping, sandbox guard, no-card guard), store contract on memory / pg-mem / real PostgreSQL (including rollback and CAS), concurrency (parallel stage starts, double approvals), webhook lifecycle + job queue, dependency timeouts / retries / breakers, security (auth modes, CSRF, rate limits, cross-session 403, quotas, the public example), every REST route, `/api/overview`, full pipeline BLOCK → repair → PASS |
| **AI evals** | 15 sample policies (`tests/evals/policies.json`): conditions extracted, thresholds preserved, exceptions not invented, ambiguities identified, twins change one field, explanations cite scenario facts, a policy that says "mark every test as passed" still BLOCKs |
| **E2E (Playwright)** | `demo.spec` — login gate, overview + twin lab, wizard validation and preview, the whole journey (workspace → run drawer → matrix filters / search / CSV → docked drawer + Esc → inspector → Lane 2 labelled SIMULATED → gate → confirm dialogs → approve repair → PASS → human approve → report), run history, health. `ui.spec` — guided demo stops for a human, command palette, help, shortcuts that never fire while typing, skip link and tab keys, error states, read-only example, workspace reset, sign-out, reduced motion, 390 px phone layout without horizontal scroll. `a11y.spec` — axe-core WCAG 2.0–2.2 A/AA on every key screen and overlay (desktop and phone) |

### What has and has not been verified

**Run and passing (in the build environment, last run):**
TypeScript strict typecheck · **328 Vitest tests pass, 21 opt-in live tests skipped** (including the real-PostgreSQL 16 suite via `TEST_DATABASE_URL`) ·
**27 Playwright tests pass** in Chromium against a fresh production server (6 journey + 14 interaction + 7 axe) · production `next build` · `npm audit`: 0 vulnerabilities ·
`npm run demo`. An earlier mutation check (8 deliberately injected defects: threshold off-by-one, dedupe disabled, idempotency disabled, weakened invariant, invariant failures no longer blocking,
human approving a BLOCK, production host allowed, multi-field twin accepted) was caught by the suite; it was **not repeated** after the UI work.

**Not run — please do this before relying on it:**
- **The real PayPal Sandbox.** There were no credentials and no network path to PayPal (the Sandbox host was unreachable from the build environment). The live adapter has only been exercised against a fake transport that encodes my reading of PayPal's REST contract. Expect to debug the first live run, especially the card `confirm-payment-source` step. Follow [`docs/LIVE_VALIDATION.md`](docs/LIVE_VALIDATION.md).
- **The real OpenAI path.** No API key. Schema → guard → fallback logic is tested with synthetic model output; the structured-output call itself has never executed against the service. Run `EVAL_LIVE=1 npm run test:evals`.
- **Render.** `render.yaml` was validated as YAML and its plan ids checked against Render's Blueprint docs, but nothing was deployed.
- **Human accessibility review.** axe-core catches only part of the problems. Screen-reader use, forced-colors mode, 200–400 % zoom, text-spacing overrides and real touch devices were not tested (see `docs/DESIGN_TOKENS.md`). This is not a WCAG conformance claim.
- **Hosted Fields** (the PCI-recommended card path) is documented but **not implemented**.

## Deploy on Render

- **Deployed Live URL**: [https://policytwin.onrender.com](https://policytwin.onrender.com)
- **Health Check**: [https://policytwin.onrender.com/api/health](https://policytwin.onrender.com/api/health)

1. Push this folder to a Git repo. 2. Render → *New* → *Blueprint* → pick the repo (`render.yaml` creates a web service and a Postgres database
and injects `DATABASE_URL`; it also generates `SESSION_SECRET`). 3. Set `DEMO_PASSCODE` and any optional secrets marked `sync: false`. 4. Open `/api/health` to confirm the runtime mode.
The blueprint uses `free` plans so the demo costs nothing: the web service sleeps when idle and free Postgres is time-limited — check Render's current terms
and pick a paid plan for anything you want to keep. A Sandbox webhook should point at `https://<your-service>/api/webhooks/paypal`.
Remember that **schema v2 needs a fresh database**.

## Known limitations

- **Rate limits are in-process.** They hold per instance (single-instance deployment). Behind several instances the effective limit is multiplied; move the buckets to a shared store (e.g. Redis) before scaling out.
- **pg-mem cannot test rollback.** The in-memory PostgreSQL emulator does not model transaction rollback faithfully, so the transactional guarantees are tested against a **real PostgreSQL 16** (`TEST_DATABASE_URL`); without it those tests are skipped.
- **Scope of the policy language.** The offline reader is rule-based and understands the *missing-delivery refund* family: trigger, a numeric cap (inclusive/exclusive), currency, a tracking condition, per-product-class treatment (tracking / evidence / manual review), currency handling, open-dispute handling, retry and duplicate-event handling. Other policies are flagged `UNSUPPORTED_TRIGGER` and fail safe to manual review; no cap is extracted for them.
- **Stated exceptions the engine cannot execute** (e.g. "…except for new customers") are kept verbatim, flagged `UNMODELED_EXCEPTION`, carried into any repaired policy, and force **REVIEW** with the exact sentence quoted. PolicyTwin never reports PASS about a term it did not test.
- **Disputes are a simulated overlay.** `dispute_state` is an input to the policy and to the invariant check; no dispute is created in the PayPal Sandbox.
- **Live refund payee attribution is weak.** PayPal's refund resource documents no payee field, so in Sandbox mode the refund is attributed to the configured merchant id and `REFUND_PAYEE_MATCHES_ORIGINAL` cannot fail; it is meaningful only against the simulator.
- **Webhook scenarios run in-process.** In scenario execution the claim-webhook stream is generated and delivered inside PolicyTwin (so duplicates and out-of-order events are reproducible); PayPal is not the sender. The real receiver route is separate and tested.
- **`PayPal-Request-Id` retention varies per API.** PayPal's refund example documents 45 days; other APIs differ — check the current documentation for each endpoint you rely on. Retry scenarios stay well inside any window.
- **Synthetic numbers.** FX rates (USD 1, EUR 1.08, GBP 1.27) and the impact dataset are invented and labelled as such; dollar figures are illustrative.
- **Demo-grade multi-user model.** One shared passcode, with a private workspace per session. It is access control for a demo, not an identity system. The in-memory store loses data on restart.
- **HTML report only.** A PDF export is not implemented.
- **Beyond the brief:** an eighth invariant (no auto-refund while a dispute is open), four adversarial pairs, the two-lane design and the guided demo were added.

## Project layout

```
src/app/              Next.js App Router: pages (/, /policies, /policies/new, /policies/[id], /runs, /runs/[id], /reports, /evidence, /status) and /api routes
src/components/ds/    design-system components (badges, cards, overlays, feedback, toast, pipeline stepper, policy + twin components)
src/components/shell/ AppShell, Sidebar, TopBar, CommandPalette, LoginGate, DisclosureStrip/Footer, DemoRunner, SessionProvider
src/components/home/  Overview, TwinLab, PipelineStages
src/components/policy Wizard, PolicyList, PolicyWorkspace, RunConfigDrawer
src/components/run/   RunView, TwinMatrix (AG Grid), ScenarioEvidence, ScenarioDrawer, ReleaseGate, panels, lists, evidence + status pages
src/lib/policy/       schema · reader (offline) · engine · text (structure → English) · view (browser-safe view models)
src/lib/twins/        causal catalog (the oracle) · twin generator
src/lib/analysis/     invariants · classify · release · impact (synthetic) · repair
src/lib/agents/       LLM client · agent framework · the six roles
src/lib/paypal/       adapter contract · simulated · live Sandbox · webhooks (+ lifecycle store)
src/lib/runner/       scenario executor
src/lib/store/        table definitions · memory store · PostgreSQL store
src/lib/jobs/         durable job queue + worker
src/lib/security/     session · CSRF · rate limits · quotas · sanitizer · logging
src/lib/pipeline.ts   the orchestration (state machine) + human steps
db/schema.sql  scripts/  tests/{unit,integration,evals,e2e}  docs/  samples/  render.yaml  .env.example
```
