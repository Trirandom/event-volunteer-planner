// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * A board wider than the window scrolls inside itself, and only there.
 *
 * The bug this holds fixed: on the shifts and availability sections the page
 * grew a second horizontal scrollbar under the board's own, and the header
 * stretched to the board's full width. `#app` is a grid (styles.css), and a
 * grid's implicit column is `auto`, which is as wide as the widest min-content
 * contribution inside it. A scroll container still reports its content's
 * width as that contribution, so a board of `min-width: max-content` rows
 * widened the column, and with it everything in the column.
 *
 * Only a real browser can see this: jsdom lays nothing out, so no unit test
 * can tell a page that overflows from one that does not.
 *
 * Signed in as the suite's coordinator (`support/coordinator.ts`).
 */
import { expect, test, type Page } from '@playwright/test';

import { openAdmin, signedInAsCoordinator } from './support/coordinator';

signedInAsCoordinator();

/** Narrower than any festival's board at full zoom, wide enough to keep the
 * rail beside the content rather than above it. */
test.use({ viewport: { width: 1024, height: 768 } });

/** The whole festival rather than one day: its axis spans every day, which is
 * the widest board the page can be asked to hold. */
async function openFestival(page: Page): Promise<void> {
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
  // `isVisible` does not wait, so it is asked only once the list has settled
  // into one of its two answers: a festival to open, or the button to make one.
  const festival = page.locator('.evp-group-title').first();
  await expect(festival.or(loadExample)).toBeVisible();
  if (await loadExample.isVisible()) {
    await loadExample.click();
    await expect(page.getByRole('status')).toBeVisible();
  }

  await festival.click();
  await page.waitForURL(/\/festivals\/[^/]+\/details$/);
}

async function openSection(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name })
    .click();
}

/** Measured, not judged by eye: the page overflows when the root's scroll
 * width passes the viewport, and the header has stretched when its box does. */
async function widths(page: Page): Promise<{
  viewport: number;
  page: number;
  header: number;
  board: number;
  boardVisible: number;
}> {
  return page.evaluate(() => {
    const scroller = document.querySelector('.evp-scroll');
    const header = document.querySelector('.evp-header');
    return {
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      header: header?.getBoundingClientRect().width ?? Number.NaN,
      board: scroller?.scrollWidth ?? Number.NaN,
      boardVisible: scroller?.clientWidth ?? Number.NaN,
    };
  });
}

async function expectOnlyTheBoardScrolls(page: Page): Promise<void> {
  const measured = await widths(page);
  expect(
    measured.board,
    'precondition: the board must be wider than its box, or nothing is tested',
  ).toBeGreaterThan(measured.boardVisible);
  expect(measured.page, 'the page must not scroll sideways').toBe(
    measured.viewport,
  );
  expect(measured.header, 'the header must be as wide as the window').toBe(
    measured.viewport,
  );
}

test('the shifts board scrolls inside itself, not the page', async ({
  page,
}) => {
  await openAdmin(page);
  await openFestival(page);
  await openSection(page, 'Shifts');
  await page.waitForURL(/\/festivals\/[^/]+\/shifts$/);
  await expect(page.locator('.evp-scroll')).toBeVisible();

  const zoom = page.locator('#board-zoom');
  await zoom.fill((await zoom.getAttribute('max')) ?? '');

  await expectOnlyTheBoardScrolls(page);
});

test('the availability board scrolls inside itself, not the page', async ({
  page,
}) => {
  await openAdmin(page);
  await openFestival(page);
  await openSection(page, 'Availability');
  await page.waitForURL(/\/festivals\/[^/]+\/availability$/);

  // An organisation with no submissions has no rows and so no board; that is
  // a different page, with nothing wide on it.
  const board = page.locator('.evp-scroll');
  await expect(
    page.locator('.evp-scroll, .evp-availability .evp-empty').first(),
  ).toBeVisible();
  test.skip(
    !(await board.isVisible()),
    'no availability windows in this organisation, so no board to overflow',
  );

  const zoom = page.locator('#availability-zoom');
  await zoom.fill((await zoom.getAttribute('max')) ?? '');

  await expectOnlyTheBoardScrolls(page);
});
