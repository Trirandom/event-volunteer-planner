// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The merged detail page — a festival and its days on one screen.
 *
 * Runs against the worked example (`POST …/festivals/example`, one festival
 * of six events), because the thing under test is what a festival looks like
 * when it has more than one day in it; a standalone event exercises none of
 * the scope switching this page exists for.
 *
 * Needs a coordinator account that already exists in the running stack — the
 * one `just bootstrap <email>` creates — because there is no self-service
 * sign-up. Set `EVP_E2E_EMAIL` / `EVP_E2E_PASSWORD` to run these against a
 * stack seeded that way; otherwise every test here is skipped rather than
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
 * Opens a festival from the events list, loading the worked example first if
 * this organisation has nothing in it yet. Returns `null` when there is no
 * festival to open and none can be created, which is a skip rather than a
 * failure — another run may have filled the org with standalone events.
 */
async function openAFestival(page: Page): Promise<string | null> {
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
    return null;
  }

  const name = (await festival.textContent())?.trim() ?? '';
  await festival.click();
  return name;
}

test('a festival opens as one page, at its details section', async ({
  page,
}) => {
  await signIn(page);
  const name = await openAFestival(page);
  if (name === null) {
    test.skip();
    return;
  }

  // The bare festival URL redirects to a section rather than rendering a
  // page with an empty middle.
  await expect(page).toHaveURL(/\/festivals\/[^/]+\/details$/);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Event details' }),
  ).toBeVisible();
});

test('picking a day narrows the same page instead of leaving it', async ({
  page,
}) => {
  await signIn(page);
  if ((await openAFestival(page)) === null) {
    test.skip();
    return;
  }

  const scope = page.getByRole('navigation', { name: 'Festival scope' });
  await expect(
    scope.getByRole('link', { name: 'Whole festival' }),
  ).toBeVisible();

  const day = scope.getByRole('link').nth(1);
  const dayName = (await day.textContent())?.trim() ?? '';
  await day.click();

  await expect(page).toHaveURL(/\/events\/[^/]+\/details$/);
  // The festival is still the heading: a day is a narrowing of it, not a
  // different subject.
  await expect(page.locator('.evp-day-summary')).toContainText(dayName);
  await expect(scope.getByRole('link', { name: dayName })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('switching scope keeps the section the coordinator is reading', async ({
  page,
}) => {
  await signIn(page);
  if ((await openAFestival(page)) === null) {
    test.skip();
    return;
  }

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Shifts' })
    .click();
  await expect(page).toHaveURL(/\/festivals\/[^/]+\/shifts$/);

  await page
    .getByRole('navigation', { name: 'Festival scope' })
    .getByRole('link')
    .nth(1)
    .click();

  await expect(page).toHaveURL(/\/events\/[^/]+\/shifts$/);
});

/**
 * The day strip is where the colours the rest of the product uses are
 * introduced, so a chip that lost its colour would leave the board and the
 * cards keyed to nothing. Asserted here rather than only in the component
 * test because the custom property only becomes a colour once the real
 * stylesheet is loaded.
 */
test('each day chip carries its own colour', async ({ page }) => {
  await signIn(page);
  if ((await openAFestival(page)) === null) {
    test.skip();
    return;
  }

  const days = page
    .getByRole('navigation', { name: 'Festival scope' })
    .getByRole('link');
  const count = await days.count();
  expect(count).toBeGreaterThan(2);

  const colours = new Set<string>();
  // From 1: "Whole festival" is first and has no colour of its own.
  for (let index = 1; index < count; index += 1) {
    const colour = await days
      .nth(index)
      .locator('.evp-day-dot')
      .evaluate((dot) => getComputedStyle(dot).backgroundColor);
    expect(colour).not.toBe('rgba(0, 0, 0, 0)');
    colours.add(colour);
  }
  // The server hands each day of a festival a different index, and telling
  // them apart is the entire job of the strip.
  expect(colours.size).toBe(count - 1);
});

/**
 * Opening the form only. Submitting it would leave a day behind in whatever
 * org the run signed into, and `UNIQUE (org_id, slug)` would make the second
 * run of the same suite fail on the first one's leftovers — what the form
 * *sends* is proven against a mocked API in `PlanDetailsView.test.ts`.
 */
test('a day can be added from the details section', async ({ page }) => {
  await signIn(page);
  if ((await openAFestival(page)) === null) {
    test.skip();
    return;
  }

  await page.getByRole('button', { name: 'Add a day' }).click();

  const zone = page.getByLabel('Timezone');
  await expect(zone).not.toHaveValue('');

  // The slug follows the name, accents folded, until somebody edits it.
  await page.getByLabel('Name').fill('Samedi 1er août');
  await expect(page.getByLabel('Slug')).toHaveValue('samedi-1er-aout');
});

test('the merged page has no axe violations at either scope', async ({
  page,
}) => {
  await signIn(page);
  if ((await openAFestival(page)) === null) {
    test.skip();
    return;
  }

  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

  const festivalScope = await new AxeBuilder({ page }).withTags(tags).analyze();
  expect(festivalScope.violations).toEqual([]);

  await page
    .getByRole('navigation', { name: 'Festival scope' })
    .getByRole('link')
    .nth(1)
    .click();
  await expect(page.locator('.evp-day-summary')).toBeVisible();

  const dayScope = await new AxeBuilder({ page }).withTags(tags).analyze();
  expect(dayScope.violations).toEqual([]);
});
