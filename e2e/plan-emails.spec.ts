// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The schedule email is written as rich text and previewed as what it sends
 * (ADR-0046).
 *
 * The schema and the serialiser are unit-tested headless
 * (`plan/emailEditor.test.ts`); what only a browser shows is that a click on
 * a toolbar button, with a real selection in a real `contenteditable`, ends
 * up as markup in the sandboxed preview, so nobody has to type the tag.
 *
 * **These tests do not write to the API.** The template lives in this
 * browser's storage only, and every Playwright context starts with none.
 *
 * Needs a coordinator account in the running stack; set `EVP_E2E_EMAIL` /
 * `EVP_E2E_PASSWORD`, or every test here is skipped.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type FrameLocator,
  type Page,
} from '@playwright/test';

const email = process.env['EVP_E2E_EMAIL'];
const password = process.env['EVP_E2E_PASSWORD'];

test.skip(
  email === undefined || password === undefined,
  'EVP_E2E_EMAIL / EVP_E2E_PASSWORD not set — no coordinator account to sign in as',
);

interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

/** One sign-in for the file, replayed as a cookie: the login route is rate
 * limited across the whole suite (see `plan-shifts.spec.ts`). */
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

/** Opens a festival's emails section, loading the worked example first if
 * this organisation has nothing in it yet. */
async function openEmails(
  page: Page,
  request: APIRequestContext,
): Promise<boolean> {
  await page.context().addCookies([await sessionCookie(request)]);
  await page.goto('/admin');
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
    .getByRole('link', { name: 'Emails' })
    .click();
  await page.waitForURL(/\/festivals\/[^/]+\/emails$/);
  await expect(editor(page)).toBeVisible();
  return true;
}

function editor(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: 'Message template' });
}

function preview(page: Page): FrameLocator {
  return page.frameLocator('iframe.evp-frame');
}

test('bold is a button, and the preview shows it as bold', async ({
  page,
  request,
}) => {
  test.skip(!(await openEmails(page, request)), 'no festival to write to');

  const box = editor(page);
  await box.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Rendez-vous à la porte B');
  await page.keyboard.press('ControlOrMeta+A');
  await page.getByRole('button', { name: 'Bold' }).click();

  await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    preview(page).locator('strong', { hasText: 'Rendez-vous à la porte B' }),
  ).toBeVisible();
  // Nothing on the page asks for markup any more.
  await expect(box).not.toContainText('<strong>');
});

test('a variable button inserts a chip that the preview fills in', async ({
  page,
  request,
}) => {
  test.skip(!(await openEmails(page, request)), 'no festival to write to');

  const recipient = page.getByLabel('Volunteer');
  test.skip(
    (await recipient.count()) === 0,
    'nobody is enrolled, so there is no name to fill in',
  );
  const name = (await recipient.locator('option:checked').textContent()) ?? '';

  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Signé pour ');
  await page
    .getByRole('button', { name: 'Insert {{displayName}} into the template' })
    .click();
  // The caret stayed in the text: the button does not take focus.
  await page.keyboard.type(', merci');

  await expect(
    editor(page).locator('[data-evp-variable="displayName"]'),
  ).toBeVisible();
  await expect(preview(page).locator('body')).toContainText(
    `Signé pour ${name}, merci`,
  );
});

test('a link the schema does not allow is refused, and the page says why', async ({
  page,
  request,
}) => {
  test.skip(!(await openEmails(page, request)), 'no festival to write to');

  await editor(page).click();
  await page.getByRole('button', { name: 'Link' }).click();
  await page.getByLabel('Link address').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByRole('alert')).toContainText(
    'Only web (https://…) and email (mailto:…) addresses',
  );
});
