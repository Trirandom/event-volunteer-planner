// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The event details section: hours, doors, colour, and the delete button.
 *
 * At this level because the two things worth proving are not in any one
 * module. The doors are a tri-state that crosses the form, the API client, the
 * handler and a `CASE` in one `UPDATE`, and "set them, then take them back
 * off" is the path where a middle state gets collapsed — unit tests of either
 * end pass happily while `null` arrives as "unchanged". The colour is the same
 * shape of claim: what a coordinator picks has to survive the round trip, the
 * invalidation and the re-render.
 *
 * **These tests write**, against the worked example, and leave their changes
 * behind. Every assertion is therefore relative to what the page said a moment
 * earlier rather than to a fixture, and the colour test picks a swatch by
 * position rather than by value so a second run is not asserting the first
 * run's leftovers.
 *
 * Signed in as the suite's coordinator (`support/coordinator.ts`).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { openAdmin, signedInAsCoordinator } from './support/coordinator';
import { openExampleFestival } from './support/festival';

signedInAsCoordinator();

/**
 * Opens one day of the worked example at its details section, loading the
 * example first if this organisation is empty.
 */
async function openADayDetails(page: Page): Promise<void> {
  await openExampleFestival(page);

  // One day, not the whole festival: the festival-scope details page renders
  // six of these forms, and every locator below would be ambiguous.
  await page
    .getByRole('navigation', { name: 'Festival scope' })
    .getByRole('link')
    .nth(1)
    .click();
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Event details' })
    .click();

  await expect(page).toHaveURL(/\/events\/[^/]+\/details$/);
}

/** The page saves by itself (ADR-0051); this waits for it to say so. */
async function expectAllSaved(page: Page): Promise<void> {
  await expect(page.locator('.evp-toolbar-status')).toHaveText(
    'Everything is saved',
  );
}

test('the rail names the production and reaches the details section', async ({
  page,
}) => {
  await openAdmin(page);
  await openADayDetails(page);

  const rail = page.getByRole('navigation', { name: 'Sections' });
  const title = await page.locator('.evp-rail-title').textContent();
  // The rail's title is the production, and it is the same subject the page's
  // own heading names — the rail is where it stays put while the board scrolls.
  await expect(
    page.getByRole('heading', { level: 1, name: title?.trim() ?? '' }),
  ).toBeVisible();
  await expect(
    rail.getByRole('link', { name: 'Event details' }),
  ).toHaveAttribute('aria-current', 'page');
});

test('door times are typed in and can be taken back off', async ({ page }) => {
  await openAdmin(page);
  await openADayDetails(page);

  // Doors inside the working hours, expressed relative to them so this works
  // on whichever day of the example the run landed on.
  const start = await page.getByLabel('Starts').inputValue();
  const end = await page.getByLabel('Ends').inputValue();

  await page.getByLabel('Doors open').fill(start);
  await page.getByLabel('Doors close').fill(end);
  await expectAllSaved(page);

  await page.reload();
  expect(await page.getByLabel('Doors open').inputValue()).toBe(start);

  // The half a plain optional could not express: "there are no published
  // hours" is a decision, and it has to be storable.
  await page.getByRole('button', { name: 'Publish no door times' }).click();
  await expectAllSaved(page);

  await page.reload();
  expect(await page.getByLabel('Doors open').inputValue()).toBe('');
  expect(await page.getByLabel('Doors close').inputValue()).toBe('');
});

test('doors outside the working hours are refused before the round trip', async ({
  page,
}) => {
  await openAdmin(page);
  await openADayDetails(page);

  const end = await page.getByLabel('Ends').inputValue();
  await page.getByLabel('Doors open').fill(end);
  // An hour past the end of the day, whatever the day is: same wall-clock
  // reading on the next calendar day is outside it either way.
  await page.getByLabel('Doors close').fill(end.replace(/T\d\d:/u, 'T23:'));

  await expect(page.getByRole('alert')).toContainText(/cannot fall outside/);
  await expect(page.locator('.evp-toolbar-status')).toContainText(
    'One event is not saved',
  );
});

test('a colour picked on the form is the colour the event keeps', async ({
  page,
}) => {
  await openAdmin(page);
  await openADayDetails(page);

  // Sixteen offered (ADR-0050), plus one when the event holds a colour
  // outside them.
  const swatches = page.getByRole('radio');
  expect([16, 17]).toContain(await swatches.count());

  // By position, not by value: these tests leave their writes behind, so the
  // currently-selected swatch differs between runs. Two positions and whichever
  // one is not already chosen is the change.
  const first = swatches.nth(0);
  const other = swatches.nth(5);
  const target = (await first.isChecked()) ? other : first;

  await target.check();
  await expectAllSaved(page);

  await page.reload();
  await expect(target).toBeChecked();
});

/** Undo is a forward write (ADR-0051), so what it puts back survives a
 * reload like any other edit. */
test('Ctrl+Z takes a colour back, and the server keeps it', async ({
  page,
}) => {
  await openAdmin(page);
  await openADayDetails(page);

  const swatches = page.getByRole('radio');
  const first = swatches.nth(0);
  const other = swatches.nth(5);
  const [original, target] = (await first.isChecked())
    ? [first, other]
    : [other, first];
  await original.check();
  await expectAllSaved(page);

  await target.check();
  await expectAllSaved(page);
  await page.keyboard.press('Control+z');
  await expect(original).toBeChecked();
  await expectAllSaved(page);

  await page.reload();
  await expect(original).toBeChecked();
});

test('the details section has no axe violations', async ({ page }) => {
  await openAdmin(page);
  await openADayDetails(page);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
