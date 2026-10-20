// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { request } from './http';

function stubFetch(status: number, body: BodyInit | null) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(body, { status })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function initOf(fetchMock: ReturnType<typeof stubFetch>): RequestInit {
  const init = fetchMock.mock.calls[0]?.[1];
  if (init === undefined) {
    throw new Error('fetch was not called with an init');
  }
  return init;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('rides the session cookie and sends no Authorization by default', async () => {
    const fetchMock = stubFetch(200, '{}');

    await request({ method: 'GET', path: '/api/v1/x' }, v.object({}));

    const init = initOf(fetchMock);
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('sends a bearer instead of the cookie, never alongside it', async () => {
    const fetchMock = stubFetch(200, '{}');

    await request(
      { method: 'GET', path: '/api/v1/x', bearer: 'secret' },
      v.object({}),
    );

    const init = initOf(fetchMock);
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer secret',
    );
  });

  it('keeps the status of a response that carried no problem document', async () => {
    stubFetch(502, '<html>Bad Gateway</html>');

    const result = await request(
      { method: 'GET', path: '/api/v1/x' },
      v.object({}),
    );

    expect(result).toStrictEqual({
      ok: false,
      failure: { reason: 'unavailable', status: 502 },
    });
  });
});
