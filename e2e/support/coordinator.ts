// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { fileURLToPath } from 'node:url';

import { test, type Page } from '@playwright/test';

/**
 * The coordinator every signed-in spec acts as, signed in once for the whole
 * run by `coordinator.setup.ts`.
 *
 * Once, not per test: `POST /auth/login` is rate limited per client address —
 * ten, then one every fifteen seconds (`EVP_LOGIN_RATE_LIMIT_*`) — and the
 * whole suite, every project, is one address. Signing in per test spent that
 * budget by the eleventh sign-in, after which every test failed at the login
 * form for a reason unrelated to what it asserts: a flake in the sense
 * docs/13 §8 refuses.
 *
 * Needs an account that already exists in the running stack — the bootstrap
 * owner (`EVP_BOOTSTRAP_*`) — because there is no self-service sign-up. Set
 * `EVP_E2E_EMAIL` / `EVP_E2E_PASSWORD` to it; otherwise the signed-in specs
 * are skipped rather than failing on a precondition nobody arranged.
 */
export const coordinator = {
  email: process.env['EVP_E2E_EMAIL'],
  password: process.env['EVP_E2E_PASSWORD'],
};

export const COORDINATOR_STATE = fileURLToPath(
  new URL('../.auth/coordinator.json', import.meta.url),
);

/** Called at the top of a spec file: its tests start with the session. */
export function signedInAsCoordinator(): void {
  test.skip(
    coordinator.email === undefined || coordinator.password === undefined,
    'EVP_E2E_EMAIL / EVP_E2E_PASSWORD not set — no coordinator account to sign in as',
  );
  test.use({ storageState: COORDINATOR_STATE });
}

/** Arrive signed in, on the page a coordinator lands on after the login form. */
export async function openAdmin(page: Page): Promise<void> {
  await page.goto('/admin');
}
