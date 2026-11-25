// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { openAdmin, signedInAsCoordinator } from './support/coordinator';

/**
 * The events page — festivals and events on one list — end to end.
 *
 * Signed in as the suite's coordinator (`support/coordinator.ts`).
 */
signedInAsCoordinator();

/** The header link, which is the route a signed-in coordinator actually takes
 * — and which only exists once the session has resolved. */
async function openEvents(page: Page): Promise<void> {
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Events' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Events', level: 1 }),
  ).toBeVisible();
}

test('the events page offers both create forms above the list', async ({
  page,
}) => {
  await openAdmin(page);
  await openEvents(page);

  await expect(page.getByRole('button', { name: 'New event' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New festival' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'New event' }).click();
  await expect(page.getByLabel('Festival')).toBeVisible();
});

test('a fresh organisation offers the worked examples', async ({ page }) => {
  await openAdmin(page);
  await openEvents(page);

  const empty = page.getByRole('heading', { name: 'Nothing planned yet' });
  if (!(await empty.isVisible())) {
    // Another run already populated this org; nothing left to prove here.
    test.skip();
  }

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

  const loadButton = page.getByRole('button', {
    name: /Load the example festival/,
  });
  if (!(await loadButton.isVisible())) {
    test.skip();
  }

  await loadButton.click();

  await expect(page.getByRole('status')).toContainText(
    /Loaded the example festival/,
  );
});

test('the old festivals path still lands somewhere useful', async ({
  page,
}) => {
  await openAdmin(page);
  await openEvents(page);

  const orgPath = new URL(page.url()).pathname;
  const orgId = orgPath.split('/')[1] ?? '';
  await page.goto(`/${orgId}/festivals`);

  await expect(page).toHaveURL(new RegExp(`/${orgId}/events$`));
});

test('the events page has no axe violations', async ({ page }) => {
  await openAdmin(page);
  await openEvents(page);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  expect(results.violations).toEqual([]);
});
