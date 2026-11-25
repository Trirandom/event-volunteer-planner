// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { expect, type Locator, type Page } from '@playwright/test';

/** The header link, which is the route a signed-in coordinator actually takes
 * — and which only exists once the session has resolved. */
export async function openEvents(page: Page): Promise<void> {
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Events' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Events', level: 1 }),
  ).toBeVisible();
}

/**
 * Opens the organisation's first festival at its details section, loading
 * the worked example first when the organisation has none, and returns the
 * festival's name.
 *
 * The list is waited for before it is asked anything: `isVisible` and
 * `count` do not wait, so asked straight after the navigation they answered
 * for a list that had not loaded yet — on an empty organisation the spec then
 * neither loaded the example nor found a festival, and skipped. A festival
 * can always be made here, so not finding one is a failure, not a skip.
 */
export async function openExampleFestival(page: Page): Promise<string> {
  await openEvents(page);

  const loadExample = page.getByRole('button', {
    name: /Load the example festival/,
  });
  const festival = page.locator('.evp-group-title').first();
  await expect(festival.or(loadExample)).toBeVisible();
  if (await loadExample.isVisible()) {
    await loadExample.click();
    await expect(
      page.getByRole('status').filter({ hasText: /Loaded the example/ }),
    ).toBeVisible();
  }

  await expect(festival).toBeVisible();
  const name = (await festival.textContent())?.trim() ?? '';
  await festival.click();
  // A festival lands on its details section: the rail's order is the order a
  // festival is set up in (`router/index.ts`).
  await page.waitForURL(/\/festivals\/[^/]+\/details$/);
  return name;
}

/** The festival-scope links: "Whole festival" first, then one per day. */
export function scopeLinks(page: Page): Locator {
  return page
    .getByRole('navigation', { name: 'Festival scope' })
    .getByRole('link');
}

/** Moves to another section of the plan, keeping the scope. */
export async function openSection(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name })
    .click();
}
