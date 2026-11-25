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
 * Signed in as the suite's coordinator (`support/coordinator.ts`).
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

import { openAdmin, signedInAsCoordinator } from './support/coordinator';
import { openExampleFestival } from './support/festival';

signedInAsCoordinator();

/** Opens a festival's emails section, loading the worked example first if
 * this organisation has nothing in it yet. */
async function openEmails(page: Page): Promise<void> {
  await openAdmin(page);
  await openExampleFestival(page);
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Emails' })
    .click();
  await page.waitForURL(/\/festivals\/[^/]+\/emails$/);
  await expect(editor(page)).toBeVisible();
}

function editor(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: 'Message template' });
}

function preview(page: Page): FrameLocator {
  return page.frameLocator('iframe.evp-frame');
}

test('bold is a button, and the preview shows it as bold', async ({ page }) => {
  await openEmails(page);

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
}) => {
  await openEmails(page);

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
}) => {
  await openEmails(page);

  await editor(page).click();
  await page.getByRole('button', { name: 'Link' }).click();
  await page.getByLabel('Link address').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByRole('alert')).toContainText(
    'Only web (https://…) and email (mailto:…) addresses',
  );
});
