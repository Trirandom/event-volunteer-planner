// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyTheme,
  opposite,
  storeTheme,
  storedTheme,
  systemTheme,
} from './preference';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

/** A stand-in for `matchMedia` that answers one query, as jsdom has none. */
function prefersDark(dark: boolean): (query: string) => { matches: boolean } {
  return (query) => ({
    matches: query === '(prefers-color-scheme: dark)' && dark,
  });
}

describe('storedTheme', () => {
  it('has no choice until one is made on this device', () => {
    expect(storedTheme()).toBeNull();
  });

  it('remembers the choice made on this device', () => {
    storeTheme('dark');
    expect(storedTheme()).toBe('dark');
  });

  it('ignores a stored value this build does not know', () => {
    localStorage.setItem('evp.theme', 'sepia');
    expect(storedTheme()).toBeNull();
  });
});

describe('systemTheme', () => {
  it('follows a dark system preference', () => {
    expect(systemTheme(prefersDark(true))).toBe('dark');
  });

  it('is light otherwise, matching the bare :root palette', () => {
    expect(systemTheme(prefersDark(false))).toBe('light');
  });

  it('is light where the browser cannot answer', () => {
    expect(systemTheme(null)).toBe('light');
  });
});

describe('applyTheme', () => {
  it('marks the document with the chosen theme', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('leaves the document to the system preference when nothing is chosen', () => {
    applyTheme('light');
    applyTheme(null);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('opposite', () => {
  it('swaps light and dark', () => {
    expect(opposite('light')).toBe('dark');
    expect(opposite('dark')).toBe('light');
  });
});
