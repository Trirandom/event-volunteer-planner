// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The parse boundary, which is where this client's one real hazard lives.
 *
 * `evp-api` carries `skip_serializing_if` on `first_name`/`last_name`, so a
 * volunteer who gave neither arrives with the *keys missing* rather than with
 * `null` — and the worked example is exactly that case on every row, because
 * the legacy form asked for one name box (ADR-0012). A schema demanding the
 * keys parses nothing, and the page reports a contract break instead of
 * showing seventy volunteers. That is a whole-feature outage behind one
 * `nullable` where `nullish` belonged, so it gets a test of its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchSubmissions } from './submissions';

const WITHOUT_NAME_PARTS = {
  id: '018f1e2d-0000-7000-8000-000000000001',
  display_name: 'Camille 🐚',
  submitted_at: '2026-08-04T11:09:35Z',
  answers: [{ question: 'Postes préférés', value: 'Bar, Entrées' }],
  availability: [
    {
      event_id: '018f1e2d-0000-7000-8000-000000000010',
      start: '2026-09-05T08:00:00Z',
      end: '2026-09-05T12:00:00Z',
    },
  ],
};

/** Stands in for the fetch layer `http.ts` calls, one response at a time. */
function stubFetchOnce(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSubmissions', () => {
  it('accepts a volunteer whose name parts were never sent', async () => {
    stubFetchOnce(200, { submissions: [WITHOUT_NAME_PARTS] });

    const result = await fetchSubmissions('org-1', 'festival-1');

    // Narrowed rather than compared against `true`: `ok` is the discriminant
    // of the result union, so reading it is the assertion.
    if (!result.ok) {
      throw new Error(`expected a parsed body, got ${result.failure.reason}`);
    }
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.display_name).toBe('Camille 🐚');
    expect(result.value[0]?.last_name ?? null).toBeNull();
  });

  it('accepts them as explicit nulls too', async () => {
    stubFetchOnce(200, {
      submissions: [
        { ...WITHOUT_NAME_PARTS, first_name: null, last_name: null },
      ],
    });

    const result = await fetchSubmissions('org-1', 'festival-1');

    if (!result.ok) {
      throw new Error(`expected a parsed body, got ${result.failure.reason}`);
    }
    expect(result.value).toHaveLength(1);
  });

  it('still refuses a body that is not the documented envelope', async () => {
    // Not pedantry: `display_name` is rendered as a heading and the contract
    // says it is never null, so a build that started sending one would show a
    // card with no name rather than a failure anyone would notice.
    stubFetchOnce(200, {
      submissions: [{ ...WITHOUT_NAME_PARTS, display_name: null }],
    });

    const result = await fetchSubmissions('org-1', 'festival-1');

    expect(result).toStrictEqual({
      ok: false,
      failure: { reason: 'malformed' },
    });
  });

  it('reports a refusal as the problem document it is', async () => {
    stubFetchOnce(403, {
      type: 'https://evp.example/errors/forbidden',
      title: 'Forbidden',
      status: 403,
    });

    const result = await fetchSubmissions('org-1', 'festival-1');

    expect(result).toStrictEqual({
      ok: false,
      failure: {
        reason: 'rejected',
        problem: {
          type: 'https://evp.example/errors/forbidden',
          title: 'Forbidden',
          status: 403,
        },
      },
    });
  });
});
