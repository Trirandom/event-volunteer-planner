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
 * Needs a coordinator account that already exists in the running stack — the
 * one `just bootstrap <email>` creates. Set `EVP_E2E_EMAIL` /
 * `EVP_E2E_PASSWORD` to run these; otherwise every test here skips rather than
 * failing on a precondition nobody arranged.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const email = process.env['EVP_E2E_EMAIL'];
const password = process.env['EVP_E2E_PASSWORD'];

test.skip(
  email === undefined || password === undefined,
  'EVP_E2E_EMAIL / EVP_E2E_PASSWORD not set — no coordinator account to sign in as',
);

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email ?? '');
  await page.getByLabel('Password').fill(password ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/admin');
}

/**
 * Opens one day of the worked example at its details section, loading the
 * example first if this organisation is empty. Returns `false` when there is
 * nothing to open, which is a skip rather than a failure.
 */
async function openADayDetails(page: Page): Promise<boolean> {
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
  return true;
}

test('the rail names the production and reaches the details section', async ({
  page,
}) => {
  await signIn(page);
  if (!(await openADayDetails(page))) {
    test.skip();
    return;
  }

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
  await signIn(page);
  if (!(await openADayDetails(page))) {
    test.skip();
    return;
  }

  // Doors inside the working hours, expressed relative to them so this works
  // on whichever day of the example the run landed on.
  const start = await page.getByLabel('Starts').inputValue();
  const end = await page.getByLabel('Ends').inputValue();

  await page.getByLabel('Doors open').fill(start);
  await page.getByLabel('Doors close').fill(end);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  await page.reload();
  expect(await page.getByLabel('Doors open').inputValue()).toBe(start);

  // The half a plain optional could not express: "there are no published
  // hours" is a decision, and it has to be storable.
  await page.getByRole('button', { name: 'Publish no door times' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  await page.reload();
  expect(await page.getByLabel('Doors open').inputValue()).toBe('');
  expect(await page.getByLabel('Doors close').inputValue()).toBe('');
});

test('doors outside the working hours are refused before the round trip', async ({
  page,
}) => {
  await signIn(page);
  if (!(await openADayDetails(page))) {
    test.skip();
    return;
  }

  const end = await page.getByLabel('Ends').inputValue();
  await page.getByLabel('Doors open').fill(end);
  // An hour past the end of the day, whatever the day is: same wall-clock
  // reading on the next calendar day is outside it either way.
  await page.getByLabel('Doors close').fill(end.replace(/T\d\d:/u, 'T23:'));

  await expect(page.getByRole('alert')).toContainText(/cannot fall outside/);
  await expect(
    page.getByRole('button', { name: 'Save changes' }),
  ).toBeDisabled();
});

test('a colour picked on the form is the colour the event keeps', async ({
  page,
}) => {
  await signIn(page);
  if (!(await openADayDetails(page))) {
    test.skip();
    return;
  }

  const swatches = page.getByRole('radio');
  await expect(swatches).toHaveCount(64);

  // By position, not by value: these tests leave their writes behind, so the
  // currently-selected swatch differs between runs. Two positions and whichever
  // one is not already chosen is the change.
  const first = swatches.nth(0);
  const other = swatches.nth(17);
  const target = (await first.isChecked()) ? other : first;

  await target.check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  await page.reload();
  await expect(target).toBeChecked();
});

test('the details section has no axe violations', async ({ page }) => {
  await signIn(page);
  if (!(await openADayDetails(page))) {
    test.skip();
    return;
  }

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
