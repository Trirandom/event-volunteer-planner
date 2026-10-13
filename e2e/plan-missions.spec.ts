// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The missions section: declaring a post, describing it, and taking it away.
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

/** Cards start collapsed; the name in the heading is the disclosure. */
async function openCard(page: Page, name: string) {
  const card = cardFor(page, name);
  await card.locator('.evp-mission-toggle').click();
  return card;
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
  await signIn(page);
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

test('a briefing written once is stored on every day it runs on', async ({
  page,
}) => {
  await signIn(page);
  if (!(await openFestivalMissions(page))) {
    test.skip();
    return;
  }

  const name = uniqueName();
  await page.getByRole('button', { name: 'Add a zone' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Add mission' }).click();
  await expect(page.getByRole('status')).toBeVisible();

  const card = await openCard(page, name);
  await card
    .getByLabel('What the job is')
    .fill('Serving, restock, glass return.');
  await card.getByRole('button', { name: 'Save changes' }).click();
  await expect(card.getByRole('status')).toContainText('Saved');

  // The round trip is the point: reload, and the text has to come back from
  // the database rather than from the draft that typed it.
  await page.reload();
  const reloaded = await openCard(page, name);
  await expect(reloaded.getByLabel('What the job is')).toHaveValue(
    'Serving, restock, glass return.',
  );

  await removeMission(page, name);
});

test('narrowing to one day edits that day alone', async ({ page }) => {
  await signIn(page);
  if (!(await openFestivalMissions(page))) {
    test.skip();
    return;
  }

  const name = uniqueName();
  await page.getByRole('button', { name: 'Add a zone' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Add mission' }).click();
  await expect(page.getByRole('status')).toBeVisible();

  // One day of the festival, same section — the scope switch keeps it.
  await page
    .getByRole('navigation', { name: 'Festival scope' })
    .getByRole('link')
    .nth(1)
    .click();
  await expect(page).toHaveURL(/\/events\/[^/]+\/missions$/);

  const dayCard = await openCard(page, name);
  await expect(dayCard.locator('.evp-day')).toHaveCount(1);
  await dayCard.getByLabel('Where to stand').fill('Only here');
  await dayCard.getByRole('button', { name: 'Save changes' }).click();
  await expect(dayCard.getByRole('status')).toContainText('Saved');

  // Back at festival scope the days now disagree, and the page says so rather
  // than showing one of the two values in a box that would flatten the other.
  await page
    .getByRole('navigation', { name: 'Festival scope' })
    .getByRole('link', { name: 'Whole festival' })
    .click();
  const wholeCard = await openCard(page, name);
  await expect(wholeCard.locator('.evp-varies')).toContainText('Only here');
  await expect(wholeCard.locator('.evp-varies')).toContainText('nothing said');

  await removeMission(page, name);
});

test('the missions section has no axe violations', async ({ page }) => {
  await signIn(page);
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
