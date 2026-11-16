// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type { ThemeName } from '@evp/shared';

/**
 * The light/dark choice, kept on this device the way the language choice is
 * (`i18n/preference.ts`). Not on the account: there is no endpoint to write
 * user preferences yet, and the theme has to be known before the first paint,
 * which a request for the session cannot be. If an account preference
 * arrives, this storage becomes its cache rather than going away.
 *
 * With nothing stored, `data-theme` stays off <html> and tokens.css follows
 * `prefers-color-scheme` (docs/14 §6), so a viewer who never touches the
 * toggle keeps tracking their system, including when it changes at dusk.
 */
const STORAGE_KEY = 'evp.theme';

function isTheme(value: unknown): value is ThemeName {
  return value === 'light' || value === 'dark';
}

/** Storage can be absent or throw (private mode, blocked site data); a theme
 * is a convenience and never worth an error. */
export function storedTheme(): ThemeName | null {
  try {
    const value = globalThis.localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: ThemeName): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not remembered on this device; the switch itself still happened.
  }
}

export const DARK_QUERY = '(prefers-color-scheme: dark)';

type MediaQuery = (query: string) => { matches: boolean };

/** Wrapped rather than passed as is: `matchMedia` called without `window` as
 * its receiver throws "Illegal invocation". Absent under jsdom. */
function browserMatchMedia(): MediaQuery | null {
  return typeof globalThis.matchMedia === 'function'
    ? (query) => globalThis.matchMedia(query)
    : null;
}

/**
 * What the page shows with no choice made. Light where the browser cannot
 * say, because that is what bare `:root` paints.
 */
export function systemTheme(
  matchMedia: MediaQuery | null = browserMatchMedia(),
): ThemeName {
  return matchMedia?.(DARK_QUERY).matches === true ? 'dark' : 'light';
}

/** `null` removes the override and hands the page back to the system. */
export function applyTheme(
  theme: ThemeName | null,
  root: HTMLElement = globalThis.document.documentElement,
): void {
  if (theme === null) {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

export function opposite(theme: ThemeName): ThemeName {
  return theme === 'dark' ? 'light' : 'dark';
}
