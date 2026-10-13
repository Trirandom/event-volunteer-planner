// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFestival,
  fetchFestival,
  fetchFestivals,
  festivalSchema,
  loadExampleFestival,
} from './festivals';

const FESTIVAL = {
  id: '018f1e2d-0000-7000-8000-000000000001',
  name: 'Midsummer Nights',
  slug: 'midsummer-nights',
  timezone: 'Europe/Paris',
  period: {
    start: '2026-07-03T22:00:00Z',
    end: '2026-07-06T04:00:00Z',
  },
  status: 'draft',
  event_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  version: 1,
};

const EVENT = {
  id: '018f1e2d-0000-7000-8000-000000000010',
  festival_id: FESTIVAL.id,
  name: 'Club Night 1',
  slug: 'club-night-1',
  timezone: 'Europe/Paris',
  period: {
    start: '2026-07-03T20:00:00Z',
    end: '2026-07-04T03:00:00Z',
  },
  status: 'draft',
  color: 7,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  version: 1,
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

function stubFetchUnreachable(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('network unavailable'))),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('festivalSchema', () => {
  it('parses a documented festival', () => {
    expect(v.safeParse(festivalSchema, FESTIVAL).success).toBe(true);
  });

  it('rejects a festival missing its period', () => {
    const withoutPeriod: Record<string, unknown> = { ...FESTIVAL };
    delete withoutPeriod['period'];
    expect(v.safeParse(festivalSchema, withoutPeriod).success).toBe(false);
  });

  it('rejects a period whose end is not a timestamp', () => {
    const malformed = {
      ...FESTIVAL,
      period: { start: FESTIVAL.period.start, end: 'not-a-timestamp' },
    };
    expect(v.safeParse(festivalSchema, malformed).success).toBe(false);
  });
});

describe('fetchFestivals', () => {
  it('unwraps the {data, next} envelope on success', async () => {
    stubFetchOnce(200, { data: [FESTIVAL], next: null });

    const result = await fetchFestivals('org-1');

    expect(result).toStrictEqual({ ok: true, value: [FESTIVAL] });
  });

  it('reports the org has none as an empty list, not a failure', async () => {
    stubFetchOnce(200, { data: [], next: null });

    const result = await fetchFestivals('org-1');

    expect(result).toStrictEqual({ ok: true, value: [] });
  });

  it('reports a network failure as unavailable', async () => {
    stubFetchUnreachable();

    const result = await fetchFestivals('org-1');

    expect(result).toStrictEqual({
      ok: false,
      failure: { reason: 'unavailable' },
    });
  });

  it('reports a body that does not match the contract as malformed', async () => {
    stubFetchOnce(200, { data: [{ ...FESTIVAL, id: '' }], next: null });

    const result = await fetchFestivals('org-1');

    expect(result).toStrictEqual({
      ok: false,
      failure: { reason: 'malformed' },
    });
  });
});

describe('fetchFestival', () => {
  it('parses the festival with its events inlined', async () => {
    stubFetchOnce(200, { ...FESTIVAL, events: [EVENT] });

    const result = await fetchFestival('org-1', FESTIVAL.id);

    expect(result).toStrictEqual({
      ok: true,
      value: { ...FESTIVAL, events: [EVENT] },
    });
  });
});

describe('createFestival', () => {
  const input = {
    name: FESTIVAL.name,
    slug: FESTIVAL.slug,
    timezone: FESTIVAL.timezone,
    period: FESTIVAL.period,
  };

  it('returns the created festival and its operation id', async () => {
    stubFetchOnce(201, { festival: FESTIVAL, operation_id: 'op-1' });

    const result = await createFestival('org-1', input);

    expect(result).toStrictEqual({
      ok: true,
      festival: FESTIVAL,
      operationId: 'op-1',
    });
  });

  it('reports 422 as validation-failed, carrying the server detail', async () => {
    stubFetchOnce(422, {
      type: 'https://evp.example/errors/validation-failed',
      title: 'Validation failed',
      status: 422,
      detail: 'slug must be unique within the organisation',
    });

    const result = await createFestival('org-1', input);

    expect(result).toStrictEqual({
      ok: false,
      rejection: {
        reason: 'validation-failed',
        detail: 'slug must be unique within the organisation',
      },
    });
  });

  it('reports 403 as forbidden', async () => {
    stubFetchOnce(403, {
      type: 'https://evp.example/errors/forbidden',
      title: 'Forbidden',
      status: 403,
    });

    const result = await createFestival('org-1', input);

    expect(result).toStrictEqual({
      ok: false,
      rejection: { reason: 'forbidden', detail: 'Forbidden' },
    });
  });

  it('reports an unrecognised problem type as refused rather than crashing', async () => {
    stubFetchOnce(500, {
      type: 'https://evp.example/errors/internal',
      title: 'Something went wrong',
      status: 500,
    });

    const result = await createFestival('org-1', input);

    expect(result).toStrictEqual({
      ok: false,
      rejection: { reason: 'refused', detail: 'Something went wrong' },
    });
  });

  it('reports a network failure as unavailable', async () => {
    stubFetchUnreachable();

    const result = await createFestival('org-1', input);

    expect(result).toStrictEqual({
      ok: false,
      rejection: { reason: 'unavailable' },
    });
  });
});

describe('loadExampleFestival', () => {
  it('returns the created example festival', async () => {
    stubFetchOnce(201, { festival: FESTIVAL, operation_id: 'op-2' });

    const result = await loadExampleFestival('org-1');

    expect(result).toStrictEqual({
      ok: true,
      festival: FESTIVAL,
      operationId: 'op-2',
    });
  });

  it('reports 409 as conflict — the org already has a festival', async () => {
    stubFetchOnce(409, {
      type: 'https://evp.example/errors/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'This organisation already has a festival.',
    });

    const result = await loadExampleFestival('org-1');

    expect(result).toStrictEqual({
      ok: false,
      rejection: {
        reason: 'conflict',
        detail: 'This organisation already has a festival.',
      },
    });
  });
});
