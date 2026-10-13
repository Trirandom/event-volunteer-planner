// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEvent,
  eventSchema,
  fetchEvent,
  fetchEvents,
  loadExampleEvent,
} from './events';

const EVENT = {
  id: '018f1e2d-0000-7000-8000-000000000010',
  festival_id: null,
  name: 'Club Night 1',
  slug: 'club-night-1',
  timezone: 'Europe/Paris',
  // Deliberately crosses midnight: 22:00 local to 05:00 the next day, the
  // shape the example festival's club nights use and the shape a naive
  // "format the date" gets wrong.
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

describe('eventSchema', () => {
  it('parses a standalone event (festival_id is null)', () => {
    expect(v.safeParse(eventSchema, EVENT).success).toBe(true);
  });

  it('parses an event attached to a festival', () => {
    const attached = {
      ...EVENT,
      festival_id: '018f1e2d-0000-7000-8000-000000000001',
    };
    expect(v.safeParse(eventSchema, attached).success).toBe(true);
  });

  it('rejects an event whose festival_id is missing rather than null', () => {
    const withoutFestivalId: Record<string, unknown> = { ...EVENT };
    delete withoutFestivalId['festival_id'];
    expect(v.safeParse(eventSchema, withoutFestivalId).success).toBe(false);
  });
});

describe('fetchEvents', () => {
  it('unwraps the {data, next} envelope on success', async () => {
    stubFetchOnce(200, { data: [EVENT], next: null });

    const result = await fetchEvents('org-1');

    expect(result).toStrictEqual({ ok: true, value: [EVENT] });
  });

  it('reports the org has none as an empty list, not a failure', async () => {
    stubFetchOnce(200, { data: [], next: null });

    const result = await fetchEvents('org-1');

    expect(result).toStrictEqual({ ok: true, value: [] });
  });

  it('reports a network failure as unavailable', async () => {
    stubFetchUnreachable();

    const result = await fetchEvents('org-1');

    expect(result).toStrictEqual({
      ok: false,
      failure: { reason: 'unavailable' },
    });
  });
});

describe('fetchEvent', () => {
  it('parses a single event', async () => {
    stubFetchOnce(200, EVENT);

    const result = await fetchEvent('org-1', EVENT.id);

    expect(result).toStrictEqual({ ok: true, value: EVENT });
  });

  it('reports a 404 as a rejected failure carrying the problem', async () => {
    stubFetchOnce(404, {
      type: 'https://evp.example/errors/not-found',
      title: 'Not found',
      status: 404,
    });

    const result = await fetchEvent('org-1', 'missing');

    expect(result).toStrictEqual({
      ok: false,
      failure: {
        reason: 'rejected',
        problem: {
          type: 'https://evp.example/errors/not-found',
          title: 'Not found',
          status: 404,
        },
      },
    });
  });
});

describe('createEvent', () => {
  const input = {
    name: EVENT.name,
    slug: EVENT.slug,
    timezone: EVENT.timezone,
    period: EVENT.period,
  };

  it('creates a standalone event when festivalId is omitted', async () => {
    stubFetchOnce(201, { event: EVENT, operation_id: 'op-1' });

    const result = await createEvent('org-1', input);

    expect(result).toStrictEqual({
      ok: true,
      event: EVENT,
      operationId: 'op-1',
    });
  });

  it('sends festival_id when the event is attached', async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(() =>
      Promise.resolve(
        new Response(JSON.stringify({ event: EVENT, operation_id: 'op-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createEvent('org-1', { ...input, festivalId: 'festival-1' });

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const body = call?.[1]?.body;
    const sentBody: unknown = JSON.parse(
      typeof body === 'string' ? body : '{}',
    );
    expect(sentBody).toMatchObject({ festival_id: 'festival-1' });
  });

  it('reports 422 as validation-failed', async () => {
    stubFetchOnce(422, {
      type: 'https://evp.example/errors/validation-failed',
      title: 'Validation failed',
      status: 422,
      detail: 'period.end must be after period.start',
    });

    const result = await createEvent('org-1', input);

    expect(result).toStrictEqual({
      ok: false,
      rejection: {
        reason: 'validation-failed',
        detail: 'period.end must be after period.start',
      },
    });
  });

  it('reports a 2xx body that fails the schema as unavailable, not refused', async () => {
    // `http.ts`'s `malformed` is a contract break, not a decision the server
    // made — `createRejectionFor` only reads `rejected` failures, so anything
    // else (network-unavailable or malformed-2xx alike) must fall through to
    // `unavailable` rather than being misread as a silent `refused`.
    stubFetchOnce(201, { event: { ...EVENT, id: '' }, operation_id: 'op-1' });

    const result = await createEvent('org-1', input);

    expect(result).toStrictEqual({
      ok: false,
      rejection: { reason: 'unavailable' },
    });
  });
});

describe('loadExampleEvent', () => {
  it('returns the created example event', async () => {
    stubFetchOnce(201, { event: EVENT, operation_id: 'op-2' });

    const result = await loadExampleEvent('org-1');

    expect(result).toStrictEqual({
      ok: true,
      event: EVENT,
      operationId: 'op-2',
    });
  });

  it('reports 409 as conflict — the org already has an event', async () => {
    stubFetchOnce(409, {
      type: 'https://evp.example/errors/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'This organisation already has an event.',
    });

    const result = await loadExampleEvent('org-1');

    expect(result).toStrictEqual({
      ok: false,
      rejection: {
        reason: 'conflict',
        detail: 'This organisation already has an event.',
      },
    });
  });

  it('reports forbidden distinctly from a generic refusal', async () => {
    stubFetchOnce(403, {
      type: 'https://evp.example/errors/forbidden',
      title: 'Forbidden',
      status: 403,
    });

    const result = await loadExampleEvent('org-1');

    expect(result).toStrictEqual({
      ok: false,
      rejection: { reason: 'forbidden', detail: 'Forbidden' },
    });
  });
});
