// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import {
  DEFAULT_LOCALE,
  isLocale,
  negotiateLocale,
  type Locale,
} from '@evp/shared/i18n';

/**
 * Which language the coordinator application speaks, in order:
 *
 * 1. a choice made with the switcher on this device;
 * 2. the account's `locale` (`users.locale`, default `fr`), once the session
 *    is known;
 * 3. the browser's languages, which is all a signed-out visitor has;
 * 4. French (docs/16 §6).
 *
 * The device choice wins over the account because there is no endpoint yet to
 * write `users.locale`: a coordinator who switches to English must not be
 * switched back on every page load by a column they cannot change. When that
 * endpoint exists the switcher should write through to it and this storage
 * becomes a cache.
 */
const STORAGE_KEY = 'evp.locale';

/** Storage can be absent or throw (private mode, blocked site data); a
 * language preference is a convenience and never worth an error. */
export function storedLocale(): Locale | null {
  try {
    const value = globalThis.localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale: Locale): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Not remembered on this device; the switch itself still happened.
  }
}

/** The language before the session is known: steps 1, 3 and 4. */
export function initialLocale(
  browserLanguages: readonly string[] = globalThis.navigator.languages,
): Locale {
  return storedLocale() ?? negotiateLocale(browserLanguages) ?? DEFAULT_LOCALE;
}

/**
 * The language once the session is known: the device choice if there is one,
 * otherwise the account's. `null` means "leave it as it is".
 */
export function accountLocale(userLocale: string): Locale | null {
  if (storedLocale() !== null) {
    return null;
  }
  return negotiateLocale([userLocale]);
}
