import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createDemoPolicy, login, runGuidedDemo } from './helpers';

/**
 * Automated WCAG 2.2 A/AA checks (axe-core) on every key screen and overlay.
 * Automated checks catch roughly a third of accessibility problems: keyboard order, focus management,
 * reading order and screen-reader wording still need a human pass (see docs/DESIGN_TOKENS.md).
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function audit(page: Page, label: string, include?: string) {
  // Let entrance animations finish: axe would otherwise measure the contrast of half-transparent, fading-in content.
  await page.waitForTimeout(450);
  let b = new AxeBuilder({ page }).withTags(TAGS);
  if (include) b = b.include(include);
  const { violations } = await b.analyze();
  const summary = violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' [' + n.html.slice(0, 140).replace(/\s+/g, ' ') + '] → ' + (n.failureSummary ?? '').split('\n').slice(1, 3).join(' ').trim()).join('\n    ')}`);
  expect(summary, `${label}: accessibility violations`).toEqual([]);
}

test.describe('axe — signed out', () => {
  test('login gate', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-gate')).toBeVisible();
    await audit(page, 'login gate');
  });
});

test.describe('axe — signed in', () => {
  test.describe.configure({ mode: 'serial' });
  let runPath = '';
  let policyPath = '';

  test('overview, and its command palette and help dialog', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('twin-lab')).toBeVisible();
    await page.waitForTimeout(500);
    await audit(page, 'overview');
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await audit(page, 'command palette');
    await page.keyboard.press('Escape');
    await page.getByTestId('open-help').click();
    await expect(page.getByTestId('help-dialog')).toBeVisible();
    await audit(page, 'help dialog');
  });

  test('wizard (all three steps) and the policy workspace', async ({ page }) => {
    await login(page, '/policies/new');
    await page.getByTestId('reset-demo').click();
    await audit(page, 'wizard step 1');
    await page.getByTestId('wizard-next').click();
    await audit(page, 'wizard step 2');
    await page.getByTestId('wizard-next').click();
    await audit(page, 'wizard step 3');
    // Validation errors are announced and accessible too.
    await page.getByTestId('wizard-back').click();
    await page.getByTestId('wizard-back').click();
    await page.locator('#name').fill('');
    await page.getByTestId('wizard-next').click();
    await expect(page.locator('#name-err')).toBeVisible();
    await audit(page, 'wizard with a validation error');

    await createDemoPolicy(page);
    policyPath = new URL(page.url()).pathname;
    await audit(page, 'policy workspace');
    await page.getByTestId('open-run-config').click();
    await expect(page.getByTestId('run-config')).toBeVisible();
    await audit(page, 'run configuration drawer');
  });

  test('run: matrix, evidence drawer, inspector, release gate and confirm dialog', async ({ page }) => {
    await login(page);
    await runGuidedDemo(page);
    runPath = new URL(page.url()).pathname;
    await page.waitForTimeout(500);
    await audit(page, 'release gate (BLOCK)');

    await page.getByTestId('tab-matrix').click();
    await expect(page.getByTestId('twin-grid').locator('.ag-row').first()).toBeVisible();
    await audit(page, 'twin matrix');
    await page.getByTestId('twin-grid').locator('.ag-row').filter({ hasText: 'Normal webhook vs duplicate webhook' }).click();
    await expect(page.getByTestId('scenario-drawer')).toBeVisible();
    await audit(page, 'matrix with the evidence drawer open');
    await page.getByTestId('open-inspector').click();
    await expect(page.getByTestId('inspector')).toBeVisible();
    await audit(page, 'scenario inspector');

    await page.getByTestId('tab-gate').click();
    await page.getByTestId('approve-repair').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await audit(page, 'confirmation dialog');
  });

  test('lists and status pages', async ({ page }) => {
    await login(page);
    for (const [name, path, ready] of [
      ['policies', '/policies', 'policy-list'],
      ['test runs', '/runs', 'runs-list'],
      ['evidence', '/evidence', 'evidence-list'],
      ['reports', '/reports', 'reports-list'],
      ['system status', '/status', 'status-overall'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByTestId(ready)).toBeVisible();
      await audit(page, name);
    }
    expect(runPath || policyPath).toBeTruthy();
  });

  test('error recovery state', async ({ page }) => {
    await login(page, '/runs/run_doesnotexist');
    await expect(page.getByTestId('error-recovery')).toBeVisible();
    await audit(page, 'error recovery');
  });
});

test.describe('axe — mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('overview, navigation sheet and run on a phone', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(500);
    await audit(page, 'mobile overview');
    await page.getByTestId('open-nav').click();
    await expect(page.getByTestId('mobile-nav')).toBeVisible();
    await audit(page, 'mobile navigation');
    await page.keyboard.press('Escape');
    await runGuidedDemo(page);
    await page.getByTestId('tab-matrix').click();
    await audit(page, 'mobile matrix cards');
  });
});
