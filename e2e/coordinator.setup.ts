// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test as setup } from '@playwright/test';

import { COORDINATOR_STATE, coordinator } from './support/coordinator';

/**
 * Signs in once and saves the session for every signed-in spec
 * (`support/coordinator.ts` says why once). Through the API rather than the
 * login form: the form is not what is under test here, and the cookie is the
 * same either way.
 */
setup('sign in as the coordinator', async ({ request, baseURL }) => {
  const { email, password } = coordinator;
  setup.skip(
    email === undefined || password === undefined,
    'EVP_E2E_EMAIL / EVP_E2E_PASSWORD not set — no coordinator account to sign in as',
  );

  const response = await request.post('/api/v1/auth/login', {
    data: { email, password },
  });
  expect(
    response.ok(),
    `EVP_E2E_EMAIL / EVP_E2E_PASSWORD must name a real coordinator (HTTP ${String(response.status())})`,
  ).toBe(true);

  const { cookies } = await request.storageState();
  expect(
    cookies.some((cookie) => cookie.name === 'evp_session'),
    'a successful login must set evp_session',
  ).toBe(true);

  // A spec's `storageState` replaces the config's rather than merging with
  // it, so the pinned English UI (playwright.config.ts) has to be carried
  // into this one too, or every signed-in spec would turn French.
  const state = {
    cookies,
    origins: [
      {
        origin: new URL(baseURL ?? '').origin,
        localStorage: [{ name: 'evp.locale', value: 'en' }],
      },
    ],
  };
  await mkdir(dirname(COORDINATOR_STATE), { recursive: true });
  await writeFile(COORDINATOR_STATE, JSON.stringify(state));
});
