// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { openAdmin, signedInAsCoordinator } from './support/coordinator';
import { openEvents } from './support/festival';

/**
 * The events page — festivals and events on one list — end to end. What it
 * shows an organisation with nothing in it is `empty-org.spec.ts`.
 *
 * Signed in as the suite's coordinator (`support/coordinator.ts`).
 */
signedInAsCoordinator();

test('the events page offers both create forms above the list', async ({
  page,
}) => {
  await openAdmin(page);
  await openEvents(page);

  await expect(page.getByRole('button', { name: 'New event' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New festival' }),
  ).toBeVisible();

  // A standalone event: an event inside a festival is added from that
  // festival's own card, so this form no longer asks which festival.
  await page.getByRole('button', { name: 'New event' }).click();
  await expect(
    page.getByRole('button', { name: 'Create event' }),
  ).toBeVisible();
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
