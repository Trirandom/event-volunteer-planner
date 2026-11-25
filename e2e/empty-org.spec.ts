// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { expect, test, type Page } from '@playwright/test';

import { openAdmin, signedInAsCoordinator } from './support/coordinator';
import { openEvents } from './support/festival';

/**
 * What an organisation with nothing planned is offered: the worked examples.
 *
 * Its own project, run after sign-in and before every other one
 * (playwright.config.ts), because every other signed-in spec loads the
 * example festival on its first test, and once loaded nothing gives an
 * empty organisation back. Emptying it from here was the alternative and
 * was rejected: the example is named after a real festival, and `just e2e`
 * points at the main development stack by default, so deleting "the
 * example" by name could delete the real one. Against an organisation that
 * already has something in it — a second run without `just db-reset` —
 * these skip, and say why.
 *
 * Signed in as the suite's coordinator (`support/coordinator.ts`).
 */
signedInAsCoordinator();

/** Waits for the list to answer — empty, or a section of events — since
 * `isVisible` does not wait and asked too early reads a list still loading.
 * True when the organisation is empty. */
async function isEmpty(page: Page): Promise<boolean> {
  const empty = page.getByRole('heading', { name: 'Nothing planned yet' });
  const listed = page.getByRole('heading', {
    name: /^(Coming up|Past)$/,
    level: 2,
  });
  await expect(empty.or(listed).first()).toBeVisible();
  return empty.isVisible();
}

test('a fresh organisation offers the worked examples', async ({ page }) => {
  await openAdmin(page);
  await openEvents(page);
  test.skip(
    !(await isEmpty(page)),
    'this organisation already has events; `just db-reset` to see it empty',
  );

  await expect(
    page.getByRole('button', { name: /Load the example festival/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Load the example event/ }),
  ).toBeVisible();
});

test('loading the example festival announces what was created', async ({
  page,
}) => {
  await openAdmin(page);
  await openEvents(page);
  test.skip(
    !(await isEmpty(page)),
    'this organisation already has events; `just db-reset` to see it empty',
  );

  await page.getByRole('button', { name: /Load the example festival/ }).click();

  await expect(
    page.getByRole('status').filter({ hasText: /Loaded the example festival/ }),
  ).toBeVisible();
});
