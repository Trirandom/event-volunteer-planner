// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterEach, describe, expect, it } from 'vitest';

import {
  accountLocale,
  initialLocale,
  storeLocale,
  storedLocale,
} from './preference';

afterEach(() => {
  localStorage.clear();
});

describe('initialLocale', () => {
  it('prefers a choice made on this device', () => {
    storeLocale('en');
    expect(initialLocale(['fr-FR'])).toBe('en');
  });

  it('falls back to the first browser language it can render', () => {
    expect(initialLocale(['de-DE', 'en-GB', 'fr'])).toBe('en');
  });

  it('defaults to French', () => {
    expect(initialLocale(['de', 'es'])).toBe('fr');
    expect(initialLocale([])).toBe('fr');
  });

  it('ignores a stored value this build does not know', () => {
    localStorage.setItem('evp.locale', 'de');
    expect(storedLocale()).toBeNull();
    expect(initialLocale(['en'])).toBe('en');
  });
});

describe('accountLocale', () => {
  it('applies the account locale when the device has no choice', () => {
    expect(accountLocale('en')).toBe('en');
    expect(accountLocale('fr-FR')).toBe('fr');
  });

  it('leaves a device choice alone', () => {
    storeLocale('en');
    expect(accountLocale('fr')).toBeNull();
  });

  it('leaves the language alone for an account locale it cannot render', () => {
    expect(accountLocale('de')).toBeNull();
  });
});
