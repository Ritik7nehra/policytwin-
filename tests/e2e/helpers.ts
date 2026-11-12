import { expect, type Page } from '@playwright/test';

export const PASSCODE = process.env.E2E_PASSCODE ?? 'e2e-demo-passcode';

/** Sign in through the real login gate (the e2e server runs in production mode, which requires a passcode). */
export async function login(page: Page, path = '/') {
  await page.goto(path);
  await page.getByTestId('passcode').fill(PASSCODE);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-gate')).toHaveCount(0);
  await expect(page.getByTestId('avatar-menu')).toBeVisible();
}

/** Create the fictional demo policy through the 3-step wizard and land on its workspace. */
export async function createDemoPolicy(page: Page) {
  await page.goto('/policies/new');
  await expect(page.getByTestId('policy-form')).toBeVisible();
  await page.getByTestId('reset-demo').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('create-policy').click();
  await page.waitForURL(/\/policies\/pol_/, { timeout: 30_000 });
  await expect(page.getByTestId('ambiguities')).toBeVisible();
}

/** From a policy workspace: open the run drawer, start the run, and wait for the run page. */
export async function startRunFromWorkspace(page: Page) {
  await page.getByTestId('open-run-config').click();
  await expect(page.getByTestId('run-config')).toBeVisible();
  await page.getByTestId('start-run').click();
  await page.waitForURL(/\/runs\/run_/, { timeout: 60_000 });
  await expect(page.getByTestId('verdict').first()).toBeVisible({ timeout: 30_000 });
}

/** Run the guided demo from the overview. It always stops at the Release Gate for a human. */
export async function runGuidedDemo(page: Page) {
  await page.goto('/');
  await page.getByTestId('hero-run-demo').click();
  await page.getByTestId('demo-start').click();
  await page.waitForURL(/\/runs\/run_[a-z0-9]+\?.*tab=gate/, { timeout: 60_000 });
  await expect(page.getByTestId('gate-verdict')).toBeVisible({ timeout: 30_000 });
}
