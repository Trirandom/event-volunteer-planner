// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { DEFAULT_LOCALE, negotiateLocale, type Locale } from '@evp/shared/i18n';
import type { LocationQuery } from 'vue-router';

/**
 * docs/09 §7: `?lang=`, then the browser's languages (what the server would
 * read as `Accept-Language`), then the organisation's default, then French.
 *
 * The organisation's default arrives with the form itself, which this bundle
 * does not fetch yet; it slots in as `orgDefault` when it does.
 *
 * In the URL rather than in storage because the form is reached from a
 * shared link: a coordinator who sends `?lang=en` to an English-speaking crew
 * means every one of them, on every device.
 */
export function formLocale(
  query: LocationQuery,
  browserLanguages: readonly string[],
  orgDefault: Locale | null = null,
): Locale {
  const lang = query['lang'];
  const fromUrl = typeof lang === 'string' ? lang : null;
  return (
    negotiateLocale([fromUrl, ...browserLanguages, orgDefault]) ??
    DEFAULT_LOCALE
  );
}
