// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Lengthening a bar past the end of its day, which lengthens the day.
 *
 * This is the one board gesture that cannot be proved anywhere cheaper. The
 * planner's arithmetic is unit-tested in `board/edit.test.ts` and the widening
 * rule is a `CASE` in one `UPDATE`, but what was broken was neither of those
 * in isolation — it was that the axis ended exactly where every bar ended, so
 * there was no pixel to drag to and the feature was unreachable. Only a real
 * browser against a real API has both the layout and the constraint triggers,
 * and jsdom answers `getBoundingClientRect` with zeros, so this is the level
 * at which the bug was visible and the level at which it stays fixed.
 *
 * **These tests write.** They lengthen a day of the worked example and leave
 * it lengthened, so every assertion is relative to what the page said a moment
 * earlier rather than to a fixture — including the published-hours one, which
 * is specified for both the first widening and every later one precisely
 * because a second run of this file is a later one.
 *
 * Needs a coordinator account that already exists in the running stack — the
 * one `just bootstrap <email>` creates — because there is no self-service
 * sign-up. Set `EVP_E2E_EMAIL` / `EVP_E2E_PASSWORD` to run these against a
 * stack seeded that way; otherwise every test here is skipped rather than
 * failing on a precondition nobody arranged.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

const email = process.env['EVP_E2E_EMAIL'];
const password = process.env['EVP_E2E_PASSWORD'];

test.skip(
  email === undefined || password === undefined,
  'EVP_E2E_EMAIL / EVP_E2E_PASSWORD not set — no coordinator account to sign in as',
);

const MINUTE_MS = 60_000;

/** The shift length these tests set before dragging, so that "one more slot"
 * is a number the assertions can check rather than whatever the board happened
 * to be left on. */
const SLOT_MINUTES = 60;

/** `PlanShiftsView`'s `AXIS_MARGIN_MINUTES` — the blank axis past the first
 * and last day, which is both the room this gesture needs and the furthest it
 * may reach. */
const AXIS_MARGIN_MINUTES = 120;

/** Zoomed out, so that even the drag that deliberately overshoots the margin
 * stays inside the viewport. The board remembers zoom across navigations on
 * purpose (`stores/board.ts`), so it is set rather than assumed. */
const PIXELS_PER_HOUR = 20;

interface Period {
  readonly start: string;
  readonly end: string;
}

interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

/**
 * One sign-in for the whole file, replayed as a cookie.
 *
 * `POST /auth/login` is rate limited — ten, then one every fifteen seconds
 * (.env.example) — and that budget is *shared by the whole suite*, not per
 * spec. Four more sign-ins for four tests is how a suite starts failing on
 * whichever test happens to run eleventh, which is a flake in the sense
 * docs/13 §8 refuses: it fails for a reason that has nothing to do with what
 * it asserts.
 */
let signedIn: SessionCookie | null = null;

async function sessionCookie(
  request: APIRequestContext,
): Promise<SessionCookie> {
  if (signedIn !== null) {
    return signedIn;
  }

  const response = await request.post('/api/v1/auth/login', {
    data: { email, password },
  });
  expect(
    response.ok(),
    'EVP_E2E_EMAIL / EVP_E2E_PASSWORD must name a real coordinator',
  ).toBe(true);

  const { cookies } = await request.storageState();
  const found = cookies.find((cookie) => cookie.name === 'evp_session');
  expect(found, 'a successful login must set evp_session').toBeDefined();

  signedIn = {
    name: 'evp_session',
    value: found?.value ?? '',
    domain: found?.domain ?? 'localhost',
    path: '/',
  };
  return signedIn;
}

/** Arrive signed in, at the page every test here starts from. */
async function signIn(page: Page, request: APIRequestContext): Promise<void> {
  await page.context().addCookies([await sessionCookie(request)]);
  await page.goto('/admin');
}

/**
 * Opens one day of a festival's mission board, loading the worked example
 * first if this organisation has nothing in it yet.
 *
 * One day, not the whole festival: the axis of a festival-wide board spans
 * every day in view, so the margin past the last of them is nowhere near
 * Saturday's bar. Narrowed to a day, the end of that day is the end of the
 * axis but for the margin — which is the situation a coordinator is actually
 * in, and the one that used to be a dead end.
 */
async function openADayBoard(page: Page): Promise<boolean> {
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
  // A festival lands on its details section, not on the board: the rail's
  // order is the order a festival is set up in (`router/index.ts`).
  await page.waitForURL(/\/festivals\/[^/]+\/details$/);
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Shifts' })
    .click();
  await page.waitForURL(/\/festivals\/[^/]+\/shifts$/);

  await page
    .getByRole('navigation', { name: 'Festival scope' })
    .getByRole('link')
    .nth(1)
    .click();
  await page.waitForURL(/\/events\/[^/]+\/shifts$/);
  await expect(page.locator('.evp-run').first()).toBeVisible();

  await setZoom(page, PIXELS_PER_HOUR);
  await setSlotLength(page, SLOT_MINUTES);
  return true;
}

/** The board writes one slot at a time and re-reads afterwards; `aria-busy` is
 * how it says so, and waiting on it beats waiting on a duration. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('.evp-board')).toHaveAttribute(
    'aria-busy',
    'false',
  );
}

/** The first bar's end handle, re-found each time: the board re-renders from
 * the server after every plan, so a handle held across one is detached. */
function endHandle(page: Page): Locator {
  return page.locator('.evp-run').first().locator('.evp-handle--end');
}

async function numberOf(handle: Locator, attribute: string): Promise<number> {
  const raw = await handle.getAttribute(attribute);
  expect(raw).not.toBeNull();
  return Number(raw);
}

async function setZoom(page: Page, pixelsPerHour: number): Promise<void> {
  await page.locator('#board-zoom').fill(String(pixelsPerHour));
}

async function setSlotLength(page: Page, minutes: number): Promise<void> {
  const input = page.locator('#board-cut');
  await input.fill(String(minutes));
  await input.blur();
}

/**
 * One period off a JSON body, narrowed rather than asserted.
 *
 * `as` is banned across this codebase and the ban is right here too: this is a
 * response from a server that is the thing under test, so a cast would let a
 * missing `public_period` read as `undefined` and quietly pass the very
 * assertion it is being fetched for.
 */
function periodAt(body: unknown, key: string): Period | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const field: unknown = Reflect.get(body, key);
  if (typeof field !== 'object' || field === null) {
    return null;
  }
  const start: unknown = Reflect.get(field, 'start');
  const end: unknown = Reflect.get(field, 'end');
  return typeof start === 'string' && typeof end === 'string'
    ? { start, end }
    : null;
}

/** The day currently on the axis, straight from the API. Shares the page's
 * cookies, so it is the same coordinator looking. */
async function dayPeriods(
  page: Page,
): Promise<{ period: Period | null; publicPeriod: Period | null }> {
  const url = new URL(page.url());
  const [, orgId = '', , eventId = ''] = url.pathname.split('/');
  const response = await page.request.get(
    `/api/v1/orgs/${orgId}/events/${eventId}`,
  );
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  return {
    period: periodAt(body, 'period'),
    publicPeriod: periodAt(body, 'public_period'),
  };
}

/**
 * Scroll the board so that the handle *and the far end of the gesture* are
 * both on screen.
 *
 * The board is the one thing in this application that scrolls sideways
 * (docs/14 §2), and a day that has been lengthened a few times is wider than
 * the window — these tests lengthen it, so by the third one it is. Playwright
 * dispatches a mouse move at a viewport coordinate, so a handle past the right
 * edge is a drag that silently does nothing and an assertion that fails for a
 * reason that has nothing to do with the board.
 */
async function bringIntoReach(
  page: Page,
  handle: Locator,
  dx: number,
): Promise<void> {
  await handle.scrollIntoViewIfNeeded();

  const box = await handle.boundingBox();
  const gutter = await page.locator('.evp-gutter').first().boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  if (box === null || width === 0) {
    return;
  }

  // A little clear of each edge, so the last `mouse.move` of the drag is
  // inside the window rather than exactly on its boundary.
  const slack = 24;
  const x = box.x + box.width / 2;

  // The mission names are pinned over the left of the lane (`position:
  // sticky`), so a `pointerdown` there lands on the gutter and no drag starts
  // at all. Pointer *capture* takes care of the rest of the gesture, which is
  // why only this end has to clear it.
  const grabbable = (gutter?.x ?? 0) + (gutter?.width ?? 0) + slack;
  const by =
    Math.max(
      x + dx + slack - width, // the far end has run off the right
      0,
    ) -
    Math.max(
      grabbable - Math.min(x, x + dx + slack), // …or off the left
      0,
    );

  if (by !== 0) {
    await page.locator('.evp-scroll').evaluate((element, amount: number) => {
      element.scrollLeft += amount;
    }, by);
  }
}

/** Drag an edge by a number of minutes on the board's own scale. */
async function dragEdge(
  page: Page,
  handle: Locator,
  minutes: number,
): Promise<void> {
  const dx = (minutes / 60) * PIXELS_PER_HOUR;
  await bringIntoReach(page, handle, dx);

  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  // In steps, so the board sees a drag rather than a teleport: the ghost is
  // recomputed per `pointermove`, and one jump exercises a path no coordinator
  // takes.
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
  await settled(page);
}

test('dragging a bar past closing time adds a slot and lengthens the day', async ({
  page,
  request,
}) => {
  await signIn(page, request);
  if (!(await openADayBoard(page))) {
    test.skip();
    return;
  }

  const bar = page.locator('.evp-run').first();
  const barEndBefore = await numberOf(endHandle(page), 'aria-valuenow');
  const axisEndBefore = await numberOf(endHandle(page), 'aria-valuemax');
  const slotsBefore = await bar.locator('.evp-cut-mark').count();
  const before = await dayPeriods(page);

  // The precondition that made this a bug rather than a preference: a bar
  // arrives already spanning its whole day, so the only way out is through.
  expect(before.period?.end).toBeDefined();
  expect(axisEndBefore - barEndBefore).toBe(AXIS_MARGIN_MINUTES * MINUTE_MS);

  await dragEdge(page, endHandle(page), SLOT_MINUTES);

  // One slot of exactly the shift length…
  expect(
    (await numberOf(endHandle(page), 'aria-valuenow')) - barEndBefore,
  ).toBe(SLOT_MINUTES * MINUTE_MS);
  expect(
    await page.locator('.evp-run').first().locator('.evp-cut-mark').count(),
  ).toBe(slotsBefore + 1);

  // …and the day grown to hold it. Read through the axis, whose margin past
  // the last day is a constant, so its end moves exactly as the day's does.
  expect(
    (await numberOf(endHandle(page), 'aria-valuemax')) - axisEndBefore,
  ).toBe(SLOT_MINUTES * MINUTE_MS);
  expect((await dayPeriods(page)).period?.end).not.toBe(before.period?.end);

  // Moving the day is not a change to one bar, so the board says so.
  await expect(page.getByRole('status')).toContainText(/now runs until/);
  await expect(page.locator('.evp-error')).toHaveCount(0);
});

test('growing a day leaves its published door times alone', async ({
  page,
  request,
}) => {
  await signIn(page, request);
  if (!(await openADayBoard(page))) {
    test.skip();
    return;
  }

  const axisEndBefore = await numberOf(endHandle(page), 'aria-valuemax');
  const before = await dayPeriods(page);

  await dragEdge(page, endHandle(page), SLOT_MINUTES);

  const after = await dayPeriods(page);
  // The day grew, read off the axis rather than by parsing two timestamps:
  // `new Date` is banned here for the same reason it is banned in the app
  // (docs/16 §4), and the axis margin is a constant, so its end moves exactly
  // as the day's does.
  expect(
    (await numberOf(endHandle(page), 'aria-valuemax')) - axisEndBefore,
  ).toBe(SLOT_MINUTES * MINUTE_MS);

  // The rule, and the whole reason the old one was wrong: the doors are a
  // published fact somebody typed on the event details page, and a drag about
  // where the crew works is not a statement about them. Widening used to fill
  // this field in from whatever the period had been at that moment — an
  // editing accident frozen into the programme.
  expect(after.publicPeriod).toEqual(before.publicPeriod);

  // And the board says only what it did.
  await expect(page.getByRole('status')).toContainText(/now runs until/);
  await expect(page.getByRole('status')).not.toContainText(/public/);
});

/**
 * WCAG 2.2 AA 2.5.7 and a CI gate, not a nicety (docs/14 §1, ADR-0017): the
 * pointer path is an enhancement, so every drag has a keyboard equivalent —
 * including this one, now that it also moves the event.
 */
test('the keyboard lengthens the day the same way', async ({
  page,
  request,
}) => {
  await signIn(page, request);
  if (!(await openADayBoard(page))) {
    test.skip();
    return;
  }

  const barEndBefore = await numberOf(endHandle(page), 'aria-valuenow');
  const axisEndBefore = await numberOf(endHandle(page), 'aria-valuemax');

  await endHandle(page).focus();
  // `Shift` moves by one whole slot, which is the unit a coordinator thinks in
  // — "one more hour on the bar" — and the unit this file set.
  await page.keyboard.press('Shift+ArrowRight');
  await settled(page);

  expect(
    (await numberOf(endHandle(page), 'aria-valuenow')) - barEndBefore,
  ).toBe(SLOT_MINUTES * MINUTE_MS);
  expect(
    (await numberOf(endHandle(page), 'aria-valuemax')) - axisEndBefore,
  ).toBe(SLOT_MINUTES * MINUTE_MS);
});

/**
 * The bar may not walk off the board. The axis reaches a fixed margin past the
 * days on it and no further, so a coordinator who needs four more hours does
 * the same drag twice rather than the board planning somewhere they cannot
 * see.
 *
 * Asserted on the *start* edge, dragging left, for a reason worth writing
 * down: at the right-hand end the room past the handle is exactly the margin
 * — both scale with the zoom — so a gesture that overshoots the margin is a
 * gesture that leaves the window, and the test would be measuring Playwright's
 * viewport rather than the board's clamp. To the left there is the whole
 * gutter and page to move into. The clamp is one function either way
 * (`settledEdge`).
 */
test('a drag past the end of the axis stops there and says so', async ({
  page,
  request,
}) => {
  await signIn(page, request);
  if (!(await openADayBoard(page))) {
    test.skip();
    return;
  }

  const startHandle = page
    .locator('.evp-run')
    .first()
    .locator('.evp-handle--start');
  const axisStartBefore = await numberOf(startHandle, 'aria-valuemin');

  await dragEdge(page, startHandle, -4 * AXIS_MARGIN_MINUTES);

  const grewBy =
    axisStartBefore -
    (await numberOf(
      page.locator('.evp-run').first().locator('.evp-handle--start'),
      'aria-valuemin',
    ));

  expect(grewBy).toBeGreaterThan(0);
  expect(grewBy).toBeLessThanOrEqual(AXIS_MARGIN_MINUTES * MINUTE_MS);
  await expect(page.getByRole('status')).toContainText(
    /as far as this board reaches/,
  );
});
