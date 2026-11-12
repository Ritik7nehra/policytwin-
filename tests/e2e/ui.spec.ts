import { expect, test, type Page } from '@playwright/test';
import { login, runGuidedDemo } from './helpers';

/** Interaction coverage for the "Financial Intelligence Control Room" shell: demo, palette, help, keyboard, responsive, states. */

const noHorizontalScroll = async (page: Page) =>
  expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: 'page must not scroll horizontally' }).toBeLessThanOrEqual(0);

test.describe('guided demo', () => {
  test('creates a fictional policy, runs it, and stops at the Release Gate without approving anything', async ({ page }) => {
    await login(page);
    await page.getByTestId('run-demo').click(); // sidebar entry point
    const dlg = page.getByTestId('demo-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText(/fictional/i);
    await expect(dlg).toContainText(/does not approve anything/i);
    await expect(dlg).toContainText(/you approve or reject/i);
    await page.getByTestId('demo-start').click();
    await expect(page.getByTestId('pipeline-stepper').first()).toBeVisible();
    await page.waitForURL(/\/runs\/run_[a-z0-9]+\?.*tab=gate.*guided=1|\/runs\/run_[a-z0-9]+\?.*guided=1.*tab=gate/, { timeout: 60_000 });

    await expect(page.getByTestId('guided-banner')).toContainText(/your turn/i);
    await expect(page.getByTestId('gate-verdict')).toHaveText('BLOCK');
    await expect(page.getByTestId('human-approve')).toBeDisabled();
    // The demo never records a human decision on the person's behalf.
    await expect(page.getByTestId('human-decision')).toHaveCount(0);
    await expect(page.getByTestId('approve-repair')).toBeEnabled();
    await expect(page.getByTestId('runtime-badges')).toContainText(/SIMULATED/i);
  });

  test('can be cancelled before it starts', async ({ page }) => {
    await login(page);
    await page.getByTestId('hero-run-demo').click();
    await expect(page.getByTestId('demo-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('demo-dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('command palette, help and keyboard', () => {
  test('Ctrl/⌘+K opens the palette, filters, navigates with Enter, and Esc closes', async ({ page }) => {
    await login(page);
    await page.keyboard.press('Control+k');
    const pal = page.getByTestId('command-palette');
    await expect(pal).toBeVisible();
    await expect(page.getByTestId('palette-input')).toBeFocused();
    await page.getByTestId('palette-input').fill('system status');
    await expect(pal.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/status$/);
    await expect(page.getByTestId('command-palette')).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await page.getByTestId('palette-input').fill('zzzz-nothing');
    await expect(pal).toContainText(/No match/i);
    await page.keyboard.press('Escape');
    await expect(pal).toHaveCount(0);
  });

  test('the search button and "/" shortcut open it; it finds the shared example policy', async ({ page }) => {
    await login(page);
    await page.getByTestId('open-palette').click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.getByTestId('palette-input').fill('missing-delivery');
    await expect(page.getByTestId('command-palette').getByRole('option').first()).toContainText(/Missing-Delivery/i);
    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(page.getByTestId('command-palette')).toBeVisible();
  });

  test('"?" opens help with shortcuts and what the product does not claim', async ({ page }) => {
    await login(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('?');
    const help = page.getByTestId('help-dialog');
    await expect(help).toBeVisible();
    await expect(help).toContainText(/What it does not claim/i);
    await expect(help).toContainText(/no regulatory certification/i);
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);
  });

  test('typing in a field never triggers a global shortcut', async ({ page }) => {
    await login(page, '/policies/new');
    await page.getByTestId('reset-demo').click();
    await page.locator('#name').click();
    await page.keyboard.type('a / b ? c');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await expect(page.getByTestId('help-dialog')).toHaveCount(0);
    await expect(page.locator('#name')).toHaveValue(/a \/ b \? c$/);
  });

  test('skip link jumps to the main content, and run tabs follow the arrow-key tab pattern', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /skip to (main )?content/i })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    await runGuidedDemo(page);
    await page.getByTestId('tab-matrix').click();
    await page.getByTestId('tab-matrix').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('tab-inspector')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(page.getByTestId('tab-gate')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.getByTestId('tab-matrix')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('states and honesty', () => {
  test('an unknown run and an unknown policy show a recovery state, not a blank page or a stack trace', async ({ page }) => {
    await login(page);
    for (const path of ['/runs/run_doesnotexist', '/policies/pol_doesnotexist']) {
      await page.goto(path);
      await expect(page.getByTestId('error-recovery')).toBeVisible();
      await expect(page.getByTestId('error-recovery')).toContainText(/money/i); // "did money move?" is always answered
      expect(await page.locator('body').innerText()).not.toMatch(/at .*\.(js|ts):\d+|TypeError|ReferenceError/);
    }
  });

  test('anonymous visitors can read the shared example, but cannot act on it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /read-only example report/i }).click();
    await page.waitForURL(/\/runs\/run_/);
    await expect(page.getByTestId('run-header')).toContainText(/Shared read-only example/i);
    await expect(page.getByTestId('gate-verdict').or(page.getByTestId('verdict').first()).first()).toBeVisible();
    await page.getByTestId('tab-gate').click();
    await expect(page.getByTestId('approve-repair')).toHaveCount(0);
    await expect(page.getByTestId('human-approve')).toHaveCount(0);
  });

  test('"Reset my workspace" asks first, then deletes only this session’s data', async ({ page }) => {
    await login(page);
    await runGuidedDemo(page);
    await page.goto('/policies');
    await expect(page.getByTestId('policy-list').getByRole('link').first()).toBeVisible();
    await page.getByTestId('avatar-menu').click();
    await page.getByTestId('reset-workspace').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText(/permanently deletes/i);
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await page.getByTestId('avatar-menu').click();
    await page.getByTestId('reset-workspace').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await page.waitForURL(/\/$/);
    await page.goto('/policies');
    // Only the shared read-only example remains.
    await expect(page.getByTestId('policy-list')).toContainText(/shared read-only example/i);
    await expect(page.getByTestId('policy-list').getByRole('listitem')).toHaveCount(1);
  });

  test('the sign-out control ends the session and brings back the gate', async ({ page }) => {
    await login(page);
    await page.getByTestId('avatar-menu').click();
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('login-gate')).toBeVisible();
  });
});

test.describe('reduced motion', () => {
  test.use({ colorScheme: 'light', reducedMotion: 'reduce' });
  test('animations collapse to (effectively) nothing and the UI still works', async ({ page }) => {
    await login(page);
    await page.keyboard.press('Control+k');
    const pal = page.getByTestId('command-palette');
    await expect(pal).toBeVisible();
    const ms = await pal.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration) * (getComputedStyle(el).animationDuration.endsWith('ms') ? 1 : 1000));
    expect(ms).toBeLessThan(5);
    const t = await page.getByTestId('twin-field-amount').evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(t)).toBeLessThan(0.01);
  });
});

test.describe('mobile (390 × 844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('navigation sheet, no horizontal scroll, and the mode badge stays visible', async ({ page }) => {
    await login(page);
    await noHorizontalScroll(page);
    await expect(page.getByTestId('env-badge')).toBeVisible();
    await expect(page.getByTestId('topbar')).toContainText('PayPal PolicyTwin');
    await expect(page.getByTestId('disclosure-strip')).toBeVisible();
    await page.getByTestId('open-nav').click();
    const nav = page.getByTestId('mobile-nav');
    await expect(nav).toBeVisible();
    await expect(page.getByTestId('mobile-search')).toBeVisible();
    await nav.getByRole('link', { name: /system status/i }).click();
    await expect(page).toHaveURL(/\/status$/);
    await expect(page.getByTestId('mobile-nav')).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test('wizard, run, matrix cards and evidence sheet all fit a phone', async ({ page }) => {
    await login(page, '/policies/new');
    await expect(page.getByTestId('policy-form')).toBeVisible();
    await noHorizontalScroll(page);

    await runGuidedDemo(page);
    await noHorizontalScroll(page);
    await expect(page.getByTestId('gate-verdict')).toHaveText('BLOCK');
    await page.getByTestId('tab-matrix').click();
    await noHorizontalScroll(page);
    // On a phone the matrix is a card list (no horizontal grid), and a card opens the evidence as a full-screen sheet.
    await expect(page.getByTestId('twin-grid').locator('.ag-row')).toHaveCount(0);
    await page.getByRole('button', { name: /Inspect.*pair_01/ }).first().click();
    await expect(page.getByTestId('drawer-inspector')).toBeVisible();
    await expect(page.getByTestId('drawer-inspector')).toHaveAttribute('data-pair', 'pair_01');
    await noHorizontalScroll(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer-inspector')).toHaveCount(0);
  });
});
