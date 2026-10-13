// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { expect, test } from '@playwright/test';

/**
 * Language selection end to end (docs/16 §6, docs/09 §7, ADR-0038). The unit
 * tests cover negotiation; what only a browser shows is that the choice
 * reaches the page — the words, `<html lang>` for a screen reader, and the
 * lazily loaded catalogue actually arriving through Caddy.
 *
 * The suite pins English (playwright.config.ts); each test here starts from
 * that and moves away from it.
 */

test('the coordinator application switches language and remembers it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  const switcher = page.getByRole('group', { name: 'Language' });
  await switcher.getByRole('button', { name: 'Français' }).click();

  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(
    page.getByRole('group', { name: 'Langue' }).getByRole('button', {
      name: 'Français',
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: /code source/i })).toBeVisible();

  // The device choice outlives a reload, and wins over the browser's `en-GB`.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
});

test('the volunteer form follows ?lang= over the browser language', async ({
  page,
}) => {
  await page.goto('/f/any-slug?lang=fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('link', { name: /code source/i })).toBeVisible();

  // The switcher writes the query, so the address is shareable as-is.
  await page
    .getByRole('group', { name: 'Langue' })
    .getByRole('button', { name: 'English' })
    .click();
  await expect(page).toHaveURL(/[?&]lang=en\b/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: /source code/i })).toBeVisible();
});
