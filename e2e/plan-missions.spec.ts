// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The missions section: declaring a mission, and taking it away.
 *
 * At this level because the claim worth proving is the *reach* of one gesture
 * across the whole stack. A mission is one card and N `locations` rows
 * (ADR-0032), so "add a mission" at festival scope is N `POST`s, and the thing
 * that can silently be wrong is not the fold — `plan/missionCatalog.test.ts`
 * proves that without a server — but whether the rows actually landed on every
 * day and come back folded into the one card the coordinator expects. Only a
 * real API has the tenant isolation, the uniqueness constraint and the
 * `If-Match` handling that decide it.
 *
 * **These tests write**, against the worked example, and clean up after
 * themselves: the mission they add carries a run-unique name and is removed at
 * the end, so a second run is not asserting the first run's leftovers and a
 * failure leaves at most one stray post behind.
 *
 * Signed in as the suite's coordinator (`support/coordinator.ts`).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { openAdmin, signedInAsCoordinator } from './support/coordinator';

signedInAsCoordinator();

/**
 * Opens the worked example's festival at its missions section, loading the
 * example first if this organisation is empty. Returns `false` when there is
 * nothing to open, which is a skip rather than a failure.
 */
async function openFestivalMissions(page: Page): Promise<boolean> {
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Events' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Events', level: 1 }),
  ).toBeVisible();

  const loadExample = page.getByRole('button', {
    name: /Load the example festival/,
  });
  if (await loadExample.isVisible()) {
    await loadExample.click();
    await expect(page.getByRole('status')).toBeVisible();
  }

  const festival = page.locator('.evp-group-title').first();
  if ((await festival.count()) === 0) {
    return false;
  }
  await festival.click();
  await page.waitForURL(/\/festivals\/[^/]+\/details$/);

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Missions' })
    .click();
  await expect(page).toHaveURL(/\/festivals\/[^/]+\/missions$/);
  return true;
}

/**
 * Unique per run, so two runs against one stack do not collide on
 * `locations_event_id_parent_id_name_key` and report it as a page bug.
 *
 * Random rather than a timestamp: the clock is not this test's to read
 * (docs/16 §4), and uniqueness is all that is wanted here anyway.
 */
function uniqueName(): string {
  return `E2E poste ${crypto.randomUUID().slice(0, 8)}`;
}

/** The card for one mission, found by its heading rather than by position:
 * the list is sorted by name and the example's own posts move around it. */
function cardFor(page: Page, name: string) {
  return page.locator('.evp-mission').filter({ hasText: name });
}

/** The trash button only asks; the answer is given in the modal dialog. */
async function removeMission(page: Page, name: string): Promise<void> {
  const card = cardFor(page, name);
  await card.getByRole('button', { name: `Remove ${name}` }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(name);
  await dialog.getByRole('button', { name: /^Remove (zone|post)$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toHaveCount(0);
}

test('a mission added at festival scope lands on every day', async ({
  page,
}) => {
  await openAdmin(page);
  if (!(await openFestivalMissions(page))) {
    test.skip();
    return;
  }

  // How many days this festival runs, as the page itself counts them — the
  // fan-out's expected reach, read off the scope switch rather than assumed
  // from the fixture.
  const dayCount = await page
    .getByRole('navigation', { name: 'Festival scope' })
    .getByRole('link')
    .count();
  // 'Whole festival' is one of those links; the rest are the days.
  const days = dayCount - 1;
  test.skip(days < 2, 'the example festival has fewer than two days');

  const name = uniqueName();
  await page.getByRole('button', { name: 'Add a zone' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Where to stand').fill('Halle 3, quai ouest');
  await page.getByRole('button', { name: 'Add mission' }).click();

  await expect(page.getByRole('status')).toContainText(
    `added to all ${String(days)} days`,
  );

  // One card, not N: the rows fold back into the mission the coordinator
  // thought they were declaring.
  const card = cardFor(page, name);
  await expect(card).toHaveCount(1);
  await expect(card.locator('.evp-day')).toHaveCount(days);

  await removeMission(page, name);
});

test('the missions section has no axe violations', async ({ page }) => {
  await openAdmin(page);
  if (!(await openFestivalMissions(page))) {
    test.skip();
    return;
  }

  // With the add form open, since a closed disclosure hides half the controls
  // on the page from the scan.
  await page.getByRole('button', { name: 'Add a zone' }).click();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
