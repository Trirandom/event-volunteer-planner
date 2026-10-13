// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { afterLoginTarget } from './redirect';

/**
 * `?redirect=` is the one value in the sign-in path that an attacker chooses,
 * because the whole point of the parameter is that somebody may have been sent
 * the URL. These cases are the ones an open-redirect check is normally written
 * without.
 */
describe('afterLoginTarget', () => {
  const ADMIN = { name: 'admin' };

  it('returns the admin panel when no redirect was given', () => {
    expect(afterLoginTarget(undefined)).toStrictEqual(ADMIN);
  });

  it('returns the admin panel for a bare flag with no value', () => {
    // `?redirect` with no `=` parses to null, not to an empty string.
    expect(afterLoginTarget(null)).toStrictEqual(ADMIN);
  });

  it('returns the admin panel when the parameter is repeated', () => {
    // `?redirect=/a&redirect=//evil.example` — an array, and picking one of
    // them is a decision with no right answer.
    expect(afterLoginTarget(['/admin', '//evil.example'])).toStrictEqual(ADMIN);
  });

  it('keeps a same-origin path, with its query and hash', () => {
    expect(afterLoginTarget('/admin?tab=orgs#list')).toBe(
      '/admin?tab=orgs#list',
    );
  });

  it('refuses an absolute URL', () => {
    expect(afterLoginTarget('https://evil.example/')).toStrictEqual(ADMIN);
  });

  it('refuses a protocol-relative URL', () => {
    // Begins with a slash and is still another origin: this is the case a
    // `startsWith('/')` check alone gets wrong.
    expect(afterLoginTarget('//evil.example/admin')).toStrictEqual(ADMIN);
  });

  it('refuses a backslash-smuggled origin', () => {
    // Some parsers normalise `\` to `/`, making this protocol-relative too.
    expect(afterLoginTarget('/\\evil.example')).toStrictEqual(ADMIN);
    expect(afterLoginTarget('\\\\evil.example')).toStrictEqual(ADMIN);
  });

  it('refuses a scheme that is not a navigation', () => {
    expect(afterLoginTarget('javascript:alert(1)')).toStrictEqual(ADMIN);
  });
});
