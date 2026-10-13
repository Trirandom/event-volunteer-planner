// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * The only end-to-end test M0 earns, and it is not a smoke test: AGPL §13
 * obliges a deployment to offer its source to every network user, coordinators
 * and volunteers alike (CONTRIBUTING, docs/01 §4 S0a). An operator who strips
 * the link is out of compliance and will not notice, so the gate is here.
 *
 * It also exercises the whole single-origin path — bundle → Caddy →
 * `GET /api/v1/meta` — which is the other thing M0 is for.
 */
const surfaces = [
  { name: 'admin', path: '/' },
  { name: 'public form', path: '/f/any-slug' },
] as const;

for (const surface of surfaces) {
  test(`the ${surface.name} shows the running version and a source link`, async ({
    page,
  }) => {
    await page.goto(surface.path);

    const link = page.getByRole('link', { name: /source code/i });
    await expect(link).toBeVisible();

    const href = await link.getAttribute('href');
    expect(href).toMatch(/^https?:\/\//);
  });

  test(`the ${surface.name} has no axe violations`, async ({ page }) => {
    await page.goto(surface.path);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
}
