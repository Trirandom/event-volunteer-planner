// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEarly, formRoute } from './early';
import { fetchPublicForm } from './publicForm';

describe('the form route read before the application boots', () => {
  it.each([
    ['/f/soundclash', '?t=abc', { slug: 'soundclash', token: 'abc' }],
    ['/f/soundclash/', '?t=abc', { slug: 'soundclash', token: 'abc' }],
    ['/f/soundclash', '', { slug: 'soundclash', token: null }],
    ['/f/soundclash', '?t=', { slug: 'soundclash', token: null }],
    ['/f/soundclash', '?lang=en&t=abc', { slug: 'soundclash', token: 'abc' }],
    ['/f/f%C3%AAte', '', { slug: 'fête', token: null }],
    // vue-router reads `+` in a query as a space, and so does this.
    ['/f/soundclash', '?t=a+b', { slug: 'soundclash', token: 'a b' }],
    // vue-router makes a repeated key an array, which FormView reads as no
    // token at all.
    ['/f/soundclash', '?t=a&t=b', { slug: 'soundclash', token: null }],
  ])('reads %s%s as the form route', (pathname, search, expected) => {
    expect(formRoute(pathname, search)).toEqual(expected);
  });

  it.each([
    ['/f/', 'no slug'],
    ['/f', 'no slug'],
    ['/f/a/b', 'the unavailable route'],
    ['/plan/x', 'outside the form'],
    ['/f/%E0', 'a slug that does not decode'],
  ])('reads %s as no form route (%s)', (pathname) => {
    expect(formRoute(pathname, '')).toBeNull();
  });
});

describe('the early form request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const route = { slug: 'soundclash', token: 'abc' };

  it('is the request fetchPublicForm would have sent', async () => {
    const calls: unknown[][] = [];
    const record = vi.fn((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', record);
    await fetchPublicForm(route.slug, route.token);
    const early = createEarly();
    early.start(route);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it('is handed over once, then the next load goes to the network', () => {
    const response = Promise.resolve(new Response('{}'));
    const early = createEarly();
    early.start(route, () => response);

    expect(early.take(route)).toBe(response);
    expect(early.take(route)).toBeNull();
  });

  it('is not handed to a different form or token', () => {
    const early = createEarly();
    early.start(route, () => Promise.resolve(new Response('{}')));

    expect(early.take({ slug: 'soundclash', token: null })).toBeNull();
    expect(early.take({ slug: 'other', token: 'abc' })).toBeNull();
  });

  it('hands over a request that failed, for the caller to report', async () => {
    const early = createEarly();
    early.start(route, () => Promise.reject(new TypeError('offline')));

    await expect(early.take(route)).rejects.toThrow('offline');
  });
});
