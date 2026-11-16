// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { expect, test } from '@playwright/test';

/**
 * The volunteer form's first-paint budget (docs/01 §5, docs/09 §6): the form
 * is asked for once, by the early entry, and the application uses that
 * response rather than asking again.
 *
 * The outline painted from index.html is not tested here: this suite runs
 * against the Vite dev servers, where the stylesheet arrives through a script,
 * so the copy only paints on its own in a build. `shell.test.ts` holds its
 * markup to the component.
 */
test('the public form is asked for once, before the application has booted', async ({
  page,
}) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/public/forms/')) {
      asked.push(new URL(request.url()).pathname);
    }
  });

  await page.goto('/f/any-slug?t=capability');
  // An unknown slug ends on the generic unavailable page (docs/09 §5); the
  // outline goes only once the response has been taken and read.
  await expect(page.locator('.evp-skeleton')).toHaveCount(0);

  expect(asked).toEqual(['/api/v1/public/forms/any-slug']);
});
