# Live validation runbook

> **Status: NOT EXECUTED in the environment this project was built in.**
> The build environment had no PayPal Sandbox credentials, no OpenAI key, and no route to `api-m.sandbox.paypal.com`
> (the host was unreachable), and no Render account. Everything below is a procedure for *you* to run. Until you do,
> there is **no** live PayPal, OpenAI or Render evidence for this project — only the simulated/offline results in the
> README. Each step says which file proves it ran; if the file does not exist, the step has not happened.

The offline suite (`npm test`, ~300 tests; real PostgreSQL when `TEST_DATABASE_URL` is set) is separate and does not need
any of this. These steps exist because a simulator can never prove how the *real* PayPal or OpenAI behaves.

## 0. Preconditions

| You need | Where from |
|---|---|
| PayPal **Sandbox** REST app (client id + secret) | PayPal Developer Dashboard → Apps & Credentials → **Sandbox** |
| For the order→capture→refund smoke flow: a Sandbox business account with *Advanced Credit and Debit Card Payments*, and a Sandbox test card | Dashboard → Sandbox → Credit Card Generator |
| For webhook verification: a Sandbox webhook (its id) pointing at your deployed `/api/webhooks/paypal` | Dashboard → your Sandbox app → Webhooks |
| OpenAI API key | platform.openai.com |
| A Render account (free plan is enough) | render.com |

Use **Sandbox only**. PolicyTwin refuses a non-sandbox `PAYPAL_BASE_URL`; never paste production credentials.
The test card is read from the environment only (never committed) and the direct-card path is an explicit opt-in:
PayPal's docs say raw card numbers on your server require PCI SAQ D compliance, which is acceptable for Sandbox test
cards and not for production. Hosted Fields / the JS SDK is the recommended production path and is **not implemented** here.

```bash
export PAYPAL_CLIENT_ID=…            # Sandbox
export PAYPAL_CLIENT_SECRET=…        # Sandbox
export PAYPAL_WEBHOOK_ID=…           # optional, enables the signature checks
export PAYPAL_SANDBOX_CARD_NUMBER=…  # optional, enables the order→refund flow (Sandbox test card only)
export OPENAI_API_KEY=…
```

## 1. Static checks and offline tests (reproducible anywhere)

```bash
npm ci
npm run typecheck
npm test                              # add TEST_DATABASE_URL=postgres://… to also run the contract tests on real PostgreSQL
npm run build
npm run test:e2e                      # needs the production build; PW_CHROMIUM_PATH=/path/to/chromium if Playwright's browser is not installed
```

## 2. PayPal Sandbox smoke flow  →  `evidence/paypal-sandbox-<timestamp>.json`

```bash
PAYPAL_LIVE_TESTS=1 npm run test:integration
```

Proves, against the real Sandbox:

1. OAuth works (no token is recorded).
2. `POST /v2/checkout/orders` twice with the **same `PayPal-Request-Id`** returns the **same order id**.
3. With a test card: create → confirm payment source → capture → refund 1.00 of 2.00. The same refund `PayPal-Request-Id`
   sent twice returns the **same refund id** and the capture is `PARTIALLY_REFUNDED` (one refund, not two). A new request id
   makes a second refund; a third is rejected with `CAPTURE_FULLY_REFUNDED`.
4. With `PAYPAL_WEBHOOK_ID`: a deliberately bogus signature is rejected by PayPal's `verify-webhook-signature`.

The evidence file lists order / capture / refund ids, request ids, HTTP statuses and issue codes — and is passed through
the sanitizer (no secrets, tokens, card or payer data).

**On the Request-Id retention claim.** PayPal documents idempotency keys per API; for example, its Payments refund example
states a retention window (45 days at the time of writing) and other APIs differ. This project's earlier README said
"hours"; that was wrong and has been corrected. Do not rely on any single number — check the page for the API you call.

## 3. Webhook verification  →  `webhook_events` row `PROCESSED`

Signature verification and canonical-fetch processing need a *real delivery*, which a unit test cannot create.

1. Deploy (section 5) or expose a local server with a tunnel; set `PAYPAL_WEBHOOK_ID`.
2. In the Dashboard open **Webhooks simulator** (or run the §2 flow so PayPal emits real `PAYMENT.CAPTURE.*` events) and send an
   event to `https://<your-host>/api/webhooks/paypal`.
3. `GET /api/health` → `queue` shows the job; the event row moves `VERIFIED → PROCESSING → PROCESSED`.
   A simulator event whose capture id does not exist in Sandbox correctly ends `FAILED_RETRYABLE` / `FAILED_PERMANENT` —
   that is the canonical-fetch rule working, not a bug. Use a real capture id from §2 to see `PROCESSED`.
4. Re-send the same event: the response says `DUPLICATE` (ignored *because* it is PROCESSED).

Record the event id, final status and timestamps yourself (the webhook route stores a sanitized payload and the status
history in `webhook_events`).

## 4. OpenAI structured outputs  →  `evidence/openai-eval-<timestamp>.json`

```bash
EVAL_LIVE=1 npm run test:evals
```

Runs the 15 labelled policy sentences through the real Policy Reader agent. For each case the evidence records whether the
structured output was accepted, accepted after deterministic-guard corrections, or **replaced by the deterministic
fallback** (and why), and whether the final policy met the hand-written expectations. The suite fails if every case fell
back (that would mean the API call is not working and the run proved nothing). Because model output varies, treat a
single run as a sample; the *safety* property under test is that the final policy passes the deterministic expectations
whatever the model returned.

## 5. Render deployment  →  your own record

1. Push the repo, create a **Blueprint** from `render.yaml`, and set `DEMO_PASSCODE` when prompted (`SESSION_SECRET` is generated).
   Optionally set the PayPal/OpenAI secrets. Use a **fresh** database (schema v2).
2. Wait for `/api/health` to return `200` with `"status":"healthy"`; open the URL, sign in with the passcode.
3. Click **Run demo** and confirm BLOCK → repair → PASS. The runtime banner says SIMULATED or PAYPAL SANDBOX honestly.
4. With Sandbox credentials set, open a run → a twin pair → **Verify selected pair in PayPal Sandbox**; the real
   order/capture/refund ids appear on the same scenario (Lane 2).
5. Without the passcode every protected endpoint must answer `401`, and an unconfigured production deploy `503` — try it.

The free web service sleeps when idle and the free database is time-limited: neither is a place to keep data.

## What a successful validation does *not* prove

* It does not prove compliance with anything, and nothing here is legal or compliance advice.
* Sandbox behaviour can differ from production behaviour.
* The simulator remains a model of PayPal's documented behaviour, labelled as such everywhere.
* A human still makes the final release decision; PolicyTwin only recommends.
