// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { formLocale } from './negotiate';

describe('formLocale (docs/09 §7)', () => {
  it('takes ?lang= first', () => {
    expect(formLocale({ lang: 'en' }, ['fr-FR'])).toBe('en');
  });

  it('then the browser, when ?lang= is absent or unusable', () => {
    expect(formLocale({}, ['de', 'en-GB'])).toBe('en');
    expect(formLocale({ lang: 'de' }, ['en'])).toBe('en');
    expect(formLocale({ lang: ['en', 'fr'] }, ['fr'])).toBe('fr');
  });

  it('then the organisation default, then French', () => {
    expect(formLocale({}, ['de'], 'en')).toBe('en');
    expect(formLocale({}, ['de'])).toBe('fr');
  });
});
