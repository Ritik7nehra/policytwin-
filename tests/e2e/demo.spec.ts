import { expect, test } from '@playwright/test';
import { createDemoPolicy, login, startRunFromWorkspace } from './helpers';

/**
 * The spec's demo, as a person would run it through the redesigned UI:
 *   login → overview (twin lab) → 3-step wizard → Policy Workspace → run configuration drawer
 *   → Twin Matrix → evidence drawer → Scenario Inspector (+ Lane 2) → Release Gate
 *   → BLOCK → approve the AI-proposed repair → re-run → PASS → human final decision → report.
 * Runs against `next start` in fully offline mode (simulated PayPal, deterministic agents, in-memory store).
 */

test.describe('access', () => {
  test('without a session the app shows the login gate, rejects a wrong passcode, and accepts the right one', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-gate')).toBeVisible();
    await expect(page.getByTestId('open-run-config')).toHaveCount(0);
    await page.getByTestId('passcode').fill('definitely-wrong');
    await page.getByTestId('login-submit').click();
    await expect(page.locator('#login-err')).toContainText(/incorrect passcode/i);
    await expect(page.getByTestId('login-gate')).toBeVisible();
    await page.getByTestId('passcode').fill(process.env.E2E_PASSCODE ?? 'e2e-demo-passcode');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-gate')).toHaveCount(0);
    await expect(page.getByTestId('hero-run-demo')).toBeVisible();
  });
});

test('overview: disclosures, honest scope, and the interactive twin lab', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/before it reaches real money/i);

  // Safety disclosures are on screen from the first page, in the shell and the footer.
  const strip = page.getByTestId('disclosure-strip');
  await expect(strip).toContainText('Sandbox and synthetic data only');
  await expect(strip).toContainText('Not an official PayPal internal system');
  const footer = page.getByTestId('footer');
  for (const t of [/fictional/i, /synthetic/i, /test money|simulator/i, /not legal or compliance advice/i, /human makes the final/i, /trademark of PayPal/i]) await expect(footer).toContainText(t);

  // The mode is never hidden: this server has no Sandbox credentials, so it says so.
  await expect(page.getByTestId('env-badge')).toContainText(/Simulated/);
  await expect(page.getByTestId('topbar')).toContainText('PayPal PolicyTwin');

  // Twin lab: change one field at a time, and the live (deterministic) result changes with it.
  const lab = page.getByTestId('twin-lab');
  await expect(lab).toBeVisible();
  await page.getByTestId('twin-field-product_type').click();
  await expect(page.getByTestId('twin-lab-result')).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('twin-twin')).toContainText(/digital/i);
  await page.getByTestId('twin-field-amount').click();
  await expect(page.getByTestId('twin-field-amount')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('twin-field-product_type')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('twin-lab-result')).toBeVisible();

  // The pipeline is explained, with the AI/code split visible.
  await expect(page.getByTestId('pipeline-stages')).toBeVisible();
  await expect(page.getByTestId('pipeline-stages')).toContainText(/AI proposes/i);
  await expect(page.getByTestId('pipeline-stages')).toContainText(/Human decides/i);

  // Metrics are real counts with a stated scope — nothing invented.
  await expect(page.getByTestId('metrics-scope')).toBeVisible();
});

test('wizard validates each step, shows a live preview, and can go back', async ({ page }) => {
  await login(page, '/policies/new');
  await expect(page.getByTestId('wizard-steps')).toBeVisible();
  await page.getByTestId('reset-demo').click();
  await expect(page.locator('#name')).not.toHaveValue('');
  await expect(page.getByTestId('live-preview')).toBeVisible();

  // Blank the policy name: the step cannot advance and the error is announced next to the field.
  await page.locator('#name').fill('');
  await page.getByTestId('wizard-next').click();
  await expect(page.locator('#name-err')).toBeVisible();
  await expect(page.locator('#name')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#name').fill('Low-Value Missing-Delivery Refund');
  await page.getByTestId('wizard-next').click();
  await expect(page.locator('#current')).toBeVisible();

  // Step 2: the live preview reads both texts in the browser and shows the field-by-field difference and the gaps.
  const preview = page.getByTestId('live-preview');
  await expect(preview.getByTestId('policy-diff')).toBeVisible();
  await expect(preview).toContainText(/Gaps this change leaves open/i);
  await expect(page.getByTestId('preview-ambiguities')).toHaveCount(0);
  await page.getByTestId('wizard-back').click();
  await expect(page.locator('#name')).toBeVisible();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-next').click();
  // Step 3: the ambiguities to expect are explained, and creating is the only remaining action.
  await expect(page.getByTestId('preview-ambiguities')).toBeVisible();
  await expect(page.getByTestId('create-policy')).toBeVisible();
});

test('block → repair → re-run → pass → human decision', async ({ page, request }) => {
  await login(page);

  // ── Policy Workspace ──
  await createDemoPolicy(page);
  const amb = page.getByTestId('ambiguities');
  await expect(amb).toContainText(/currency conversion/i);
  await expect(amb).toContainText(/dispute/i);
  await expect(page.getByTestId('proposed-text')).toBeVisible();
  await expect(page.getByTestId('conditions')).toBeVisible();

  // ── Run configuration drawer ──
  await page.getByTestId('open-run-config').click();
  await expect(page.getByTestId('run-config')).toBeVisible();
  await expect(page.getByTestId('run-estimate')).toBeVisible();
  await expect(page.getByTestId('adversarial-toggle')).toBeChecked();
  await page.getByTestId('start-run').click();
  await expect(page.getByTestId('run-step')).toBeVisible();
  await page.waitForURL(/\/runs\/run_/, { timeout: 60_000 });
  await expect(page.getByTestId('verdict').first()).toHaveText(/BLOCK/);
  await expect(page.getByTestId('run-header')).toContainText(/not an approval/i);
  await expect(page.getByTestId('runtime-badges')).toContainText(/SIMULATED/i);

  // ── Transaction Twin Matrix (AG Grid) ──
  await page.getByTestId('tab-matrix').click();
  const grid = page.getByTestId('twin-grid');
  for (const h of ['Pair', 'Changed field', 'Original', 'Twin', 'Severity', 'Result']) await expect(grid.getByRole('columnheader', { name: h }).first()).toBeVisible();
  await expect(grid.locator('.ag-row').first()).toBeVisible();
  await expect(page.getByTestId('matrix-count')).toContainText('10 of 10');
  expect(await grid.locator('.ag-row').count()).toBe(10);

  for (const f of ['PASSED', 'UNEXPECTED_DIFFERENCE', 'INVARIANT_FAILURE', 'HUMAN_REVIEW', 'CRITICAL_REGRESSION']) await expect(page.getByTestId(`filter-${f}`)).toBeVisible();
  await page.getByTestId('filter-INVARIANT_FAILURE').click();
  await expect(page.getByTestId('filter-INVARIANT_FAILURE')).toHaveAttribute('aria-pressed', 'true');
  await expect(grid.locator('.ag-row')).toHaveCount(3); // retry (pair_04), open dispute (pair_05), duplicate webhook (pair_06)
  await page.getByTestId('filter-CRITICAL_REGRESSION').click();
  expect(await grid.locator('.ag-row').count()).toBeGreaterThanOrEqual(4);
  await page.getByTestId('filter-ALL').click();
  await page.getByTestId('matrix-search').fill('webhook');
  await expect(page.getByTestId('matrix-count')).not.toContainText('10 of 10');
  await page.getByTestId('matrix-search').fill('');

  // CSV export (formula-injection-safe) downloads.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  expect(dl.suggestedFilename()).toMatch(/\.csv$/);

  // ── Evidence drawer (docked, non-modal on desktop) ──
  await grid.locator('.ag-row').filter({ hasText: 'Normal webhook vs duplicate webhook' }).click();
  const drawer = page.getByTestId('scenario-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId('drawer-inspector')).toHaveAttribute('data-pair', 'pair_06');
  await expect(page.getByTestId('drawer-inspector').getByTestId('twin-original')).toBeVisible();
  await expect(page.getByTestId('drawer-inspector').getByTestId('twin-twin')).toBeVisible();
  // The matrix is still usable while the drawer is open (docked, not a modal).
  await expect(page.getByTestId('filter-ALL')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await grid.locator('.ag-row').filter({ hasText: 'Normal webhook vs duplicate webhook' }).click();
  await expect(drawer).toBeVisible();

  // ── Scenario Inspector ──
  await page.getByTestId('open-inspector').click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toBeVisible();
  await expect(page).toHaveURL(/tab=inspector/);
  await expect(page).toHaveURL(/pair=pair_06/);
  await expect(inspector).toContainText('webhook_deliveries');
  await expect(inspector).toContainText(/Payment evidence/i);
  await expect(inspector).toContainText(/SIMULATED/);
  await expect(inspector).toContainText('DUPLICATE_WEBHOOK_NO_DUPLICATE_OPERATION');
  await expect(inspector).toContainText(/FAILED/);
  await expect(inspector).toContainText(/Deterministic code decides these/i);

  // Lane 2 is labelled honestly: with no Sandbox credentials it re-runs on the simulator and says SIMULATED.
  await expect(inspector).toContainText(/No PayPal Sandbox credentials are configured/i);
  await page.getByTestId('verify-sandbox').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  const proof = page.getByTestId('sandbox-proof-result');
  await expect(proof).toBeVisible({ timeout: 30_000 });
  await expect(proof).toContainText(/SIMULATED/);
  await expect(proof).not.toContainText(/verified in the PayPal Sandbox/i);

  // ── Release Gate ──
  await page.getByTestId('tab-gate').click();
  await expect(page.getByTestId('gate-verdict')).toHaveText('BLOCK');
  await expect(page.getByTestId('verdict-panel')).toContainText(/Release recommendation — not an approval/i);
  await expect(page.getByTestId('critical-list')).toBeVisible();
  await expect(page.getByText(/Synthetic impact estimate — not PayPal data/i).first()).toBeVisible();
  await expect(page.getByTestId('coverage')).toBeVisible();
  // A BLOCK can never be approved.
  await expect(page.getByTestId('human-approve')).toBeDisabled();
  await expect(page.getByTestId('corrected-text')).toContainText(/dispute/i);

  const href = await page.getByTestId('download-report').getAttribute('href');
  expect(href).toMatch(/\/api\/test-runs\/run_[a-z0-9]+\/report\?download=1/);
  // The report endpoint is session-scoped: reuse the signed-in browser context's cookies.
  const rep = await page.context().request.get(href!);
  expect(rep.status()).toBe(200);
  expect(rep.headers()['content-disposition']).toMatch(/attachment/);
  expect(await rep.text()).toContain('BLOCK');
  // …and anonymous callers are turned away.
  const anon = await request.get(href!);
  expect([401, 403, 404]).toContain(anon.status());

  // ── Human approves the repair (with a confirmation) → everything re-runs against Version C ──
  await page.getByTestId('approve-repair').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText(/Nothing is released/i);
  await page.getByTestId('confirm-dialog-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('gate-verdict')).toHaveText('BLOCK'); // cancelling changed nothing
  await page.getByTestId('approve-repair').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await page.waitForURL(/\/runs\/run_/, { timeout: 60_000 });
  await expect(page.getByTestId('verdict').first()).toHaveText(/PASS/, { timeout: 30_000 });
  await page.getByTestId('tab-gate').click();
  await expect(page.getByTestId('gate-verdict')).toHaveText('PASS');
  await expect(page.getByTestId('critical-list')).toHaveCount(0);
  await expect(page.getByTestId('run-lineage')).toBeVisible();

  // ── Final decision is a human's, and is confirmed ──
  await expect(page.getByTestId('human-decision')).toHaveCount(0);
  await page.getByTestId('human-approve').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText(/your.*decision/i);
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByTestId('human-decision')).toContainText(/Approved/);
  await expect(page.getByTestId('human-approve')).toHaveCount(0);

  // ── Wording rules: never claim compliance certification, a guarantee, or production data ──
  const body = (await page.locator('body').innerText()).toLowerCase();
  expect(body).not.toMatch(/guarantees? (regulatory )?compliance/);
  expect(body).not.toMatch(/compliance[- ]certified|certified compliant/);
  expect(body).not.toMatch(/production data (access|connected)/);
});

test('policy workspace → run history lists the finished run, and a run can be reopened', async ({ page }) => {
  await login(page);
  await createDemoPolicy(page);
  const policyUrl = page.url();
  await startRunFromWorkspace(page);
  const runUrl = page.url();
  await page.goto(policyUrl);
  await expect(page.getByTestId('run-history')).toContainText(/BLOCK/);
  await page.goto('/runs');
  await expect(page.getByTestId('runs-list')).toContainText(/BLOCK/);
  await page.goto(runUrl.replace(/\?.*/, '') + '?tab=gate');
  await expect(page.getByTestId('gate-verdict')).toHaveText('BLOCK');
});

test('API health reports offline mode and disclosures', async ({ request }) => {
  const r = await request.get('/api/health');
  expect(r.ok()).toBeTruthy();
  const j = await r.json();
  expect(j.runtime.paypal_mode).toBe('simulated');
  expect(j.runtime.lane1_mode).toBe('simulated');
  expect(j.disclosures.length).toBeGreaterThanOrEqual(7);
  // No secret, token or key is ever exposed by the health endpoint.
  const blob = JSON.stringify(j);
  expect(blob).not.toMatch(/client_secret|access_token|api[_-]?key|session_secret/i);
  expect(blob).not.toContain(process.env.E2E_PASSCODE ?? 'e2e-demo-passcode');
  expect(blob).not.toContain('e2e-only-session-secret');
});
