// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assignMember,
  createOrganization,
  createUser,
  listMembers,
  listOrganizations,
  listUsers,
  removeMember,
} from './backoffice';

const KEY = 'k'.repeat(64);

const ORGANIZATION = {
  id: 'org-1',
  slug: 'soundclash',
  name: 'Soundclash',
  timezone: 'Europe/Paris',
  created_at: '2026-10-01T08:00:00Z',
  member_count: 2,
};

const MEMBER = {
  user_id: 'user-1',
  email: 'ada@example.org',
  display_name: 'Ada',
  role: 'coordinator',
  created_at: '2026-10-01T08:00:00Z',
};

const USER = {
  id: 'user-1',
  email: 'ada@example.org',
  display_name: 'Ada',
  created_at: '2026-10-01T08:00:00Z',
  last_login_at: null,
  memberships: [
    { org_id: 'org-1', slug: 'soundclash', name: 'Soundclash', role: 'owner' },
  ],
};

function problem(status: number, slug: string, detail?: string) {
  return {
    type: `https://evp.example/errors/${slug}`,
    title: slug,
    status,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Stands in for the fetch layer `http.ts` calls, and keeps the calls so the
 * request itself can be inspected. */
function stubFetch(status: number, body?: unknown) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof stubFetch>) {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) {
    throw new Error('fetch was not called');
  }
  const [path, init] = call;
  const headers = new Headers(init?.headers);
  const rawBody = init?.body;
  const body: unknown =
    typeof rawBody === 'string' ? JSON.parse(rawBody) : null;
  return {
    path,
    method: init?.method,
    credentials: init?.credentials,
    authorization: headers.get('authorization'),
    body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the key', () => {
  it('is sent as a bearer, and the session cookie is left behind', async () => {
    const fetchMock = stubFetch(200, { data: [ORGANIZATION], next: null });

    await listOrganizations(KEY);

    const request = sent(fetchMock);
    expect(request.path).toBe('/api/v1/backoffice/organizations');
    expect(request.authorization).toBe(`Bearer ${KEY}`);
    expect(request.credentials).toBe('omit');
  });

  it('rides every write too', async () => {
    const fetchMock = stubFetch(204);

    await removeMember(KEY, 'org-1', 'user-1');

    const request = sent(fetchMock);
    expect(request.method).toBe('DELETE');
    expect(request.path).toBe(
      '/api/v1/backoffice/organizations/org-1/members/user-1',
    );
    expect(request.authorization).toBe(`Bearer ${KEY}`);
    expect(request.credentials).toBe('omit');
  });
});

describe('listOrganizations', () => {
  it('unwraps the list envelope', async () => {
    stubFetch(200, { data: [ORGANIZATION], next: null });

    expect(await listOrganizations(KEY)).toStrictEqual({
      ok: true,
      value: [ORGANIZATION],
    });
  });

  it('reports a 401 as a bad key', async () => {
    stubFetch(401, problem(401, 'unauthenticated'));

    expect(await listOrganizations(KEY)).toStrictEqual({
      ok: false,
      rejection: { reason: 'bad-key' },
    });
  });

  it('reports a 404 as the backoffice being switched off', async () => {
    stubFetch(404, problem(404, 'not-found'));

    expect(await listOrganizations(KEY)).toStrictEqual({
      ok: false,
      rejection: { reason: 'disabled' },
    });
  });

  it('reports the router’s bare 404 the same way', async () => {
    // An unmounted route has no problem document to send: "indistinguishable
    // from a path that does not exist" (ADR-0045) is exactly this response.
    stubFetch(404);

    expect(await listOrganizations(KEY)).toStrictEqual({
      ok: false,
      rejection: { reason: 'disabled' },
    });
  });

  it('reports a 429 as rate-limited', async () => {
    stubFetch(429, problem(429, 'rate-limited'));

    expect(await listOrganizations(KEY)).toStrictEqual({
      ok: false,
      rejection: { reason: 'rate-limited' },
    });
  });

  it('reports a network failure as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network unavailable'))),
    );

    expect(await listOrganizations(KEY)).toStrictEqual({
      ok: false,
      rejection: { reason: 'unavailable' },
    });
  });

  it('reports a body off-contract as unavailable', async () => {
    stubFetch(200, { data: [{ ...ORGANIZATION, member_count: -1 }] });

    expect(await listOrganizations(KEY)).toStrictEqual({
      ok: false,
      rejection: { reason: 'unavailable' },
    });
  });
});

describe('createOrganization', () => {
  it('omits a timezone left to the server’s default', async () => {
    const fetchMock = stubFetch(201, ORGANIZATION);

    const result = await createOrganization(KEY, {
      name: 'Soundclash',
      slug: 'soundclash',
    });

    expect(result).toStrictEqual({ ok: true, value: ORGANIZATION });
    const request = sent(fetchMock);
    expect(request.method).toBe('POST');
    expect(request.body).toStrictEqual({
      name: 'Soundclash',
      slug: 'soundclash',
    });
  });

  it('carries a taken slug’s detail as a conflict', async () => {
    stubFetch(409, problem(409, 'conflict', 'slug soundclash is taken'));

    expect(
      await createOrganization(KEY, { name: 'Soundclash', slug: 'soundclash' }),
    ).toStrictEqual({
      ok: false,
      rejection: { reason: 'conflict', detail: 'slug soundclash is taken' },
    });
  });

  it('carries a refused timezone’s detail as validation-failed', async () => {
    stubFetch(422, problem(422, 'validation-failed', 'unknown time zone'));

    expect(
      await createOrganization(KEY, {
        name: 'Soundclash',
        slug: 'soundclash',
        timezone: 'Mars/Olympus',
      }),
    ).toStrictEqual({
      ok: false,
      rejection: { reason: 'validation-failed', detail: 'unknown time zone' },
    });
  });
});

describe('members', () => {
  it('lists them out of the envelope', async () => {
    stubFetch(200, { data: [MEMBER], next: null });

    expect(await listMembers(KEY, 'org-1')).toStrictEqual({
      ok: true,
      value: [MEMBER],
    });
  });

  it('reads a 404 on a member route as a missing row, not a switched-off backoffice', async () => {
    stubFetch(404, problem(404, 'not-found', 'no such organization'));

    expect(await listMembers(KEY, 'org-404')).toStrictEqual({
      ok: false,
      rejection: { reason: 'not-found', detail: 'no such organization' },
    });
  });

  it('assigns with a PUT carrying only the role', async () => {
    const fetchMock = stubFetch(200, { ...MEMBER, role: 'zone_lead' });

    const result = await assignMember(KEY, 'org-1', 'user-1', 'zone_lead');

    expect(result).toStrictEqual({
      ok: true,
      value: { ...MEMBER, role: 'zone_lead' },
    });
    const request = sent(fetchMock);
    expect(request.method).toBe('PUT');
    expect(request.path).toBe(
      '/api/v1/backoffice/organizations/org-1/members/user-1',
    );
    expect(request.body).toStrictEqual({ role: 'zone_lead' });
  });

  it('refuses a role this client does not know', async () => {
    stubFetch(200, { ...MEMBER, role: 'admin' });

    expect(
      await assignMember(KEY, 'org-1', 'user-1', 'coordinator'),
    ).toStrictEqual({ ok: false, rejection: { reason: 'unavailable' } });
  });

  it('removes with a 204', async () => {
    stubFetch(204);

    expect(await removeMember(KEY, 'org-1', 'user-1')).toStrictEqual({
      ok: true,
      value: null,
    });
  });

  it('reports removing a membership that is not there as not-found', async () => {
    stubFetch(404, problem(404, 'not-found'));

    expect(await removeMember(KEY, 'org-1', 'user-9')).toStrictEqual({
      ok: false,
      rejection: { reason: 'not-found', detail: 'not-found' },
    });
  });
});

describe('users', () => {
  it('lists them with a nullable last sign-in', async () => {
    stubFetch(200, { data: [USER], next: null });

    expect(await listUsers(KEY)).toStrictEqual({ ok: true, value: [USER] });
  });

  it('sends the display name in the wire’s spelling', async () => {
    const fetchMock = stubFetch(201, USER);

    await createUser(KEY, {
      email: 'ada@example.org',
      displayName: 'Ada',
      password: 'correct horse battery',
    });

    expect(sent(fetchMock).body).toStrictEqual({
      email: 'ada@example.org',
      display_name: 'Ada',
      password: 'correct horse battery',
    });
  });

  it('carries a taken e-mail’s detail as a conflict', async () => {
    stubFetch(409, problem(409, 'conflict', 'email already registered'));

    expect(
      await createUser(KEY, {
        email: 'ada@example.org',
        displayName: 'Ada',
        password: 'correct horse battery',
      }),
    ).toStrictEqual({
      ok: false,
      rejection: { reason: 'conflict', detail: 'email already registered' },
    });
  });
});
