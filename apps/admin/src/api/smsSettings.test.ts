// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EMPTY_SMS_SETTINGS,
  fetchSmsSettings,
  updateSmsSettings,
} from './smsSettings';

const SETTINGS = {
  provider: 'ovh',
  service_name: 'sms-xxxxx-1',
  sender: 'MyOrg',
  application_key: 'app-key-123',
  has_application_secret: true,
  has_consumer_key: true,
  updated_at: '2026-01-01T00:00:00Z',
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

describe('fetchSmsSettings', () => {
  it('parses a saved configuration, never carrying the secret itself', async () => {
    stubFetchOnce(200, SETTINGS);

    const result = await fetchSmsSettings('org-1');

    expect(result).toStrictEqual({ ok: true, value: SETTINGS });
  });

  it('reports a 404 (nothing saved yet) as the empty settings value', async () => {
    stubFetchOnce(404, {
      type: 'https://evp.example/errors/not-found',
      title: 'Not found',
      status: 404,
    });

    const result = await fetchSmsSettings('org-1');

    expect(result).toStrictEqual({ ok: true, value: EMPTY_SMS_SETTINGS });
  });

  it('reports a network failure as unavailable', async () => {
    stubFetchUnreachable();

    const result = await fetchSmsSettings('org-1');

    expect(result).toStrictEqual({
      ok: false,
      failure: { reason: 'unavailable' },
    });
  });
});

describe('updateSmsSettings', () => {
  const input = {
    provider: 'ovh' as const,
    serviceName: 'sms-xxxxx-1',
    sender: 'MyOrg',
    applicationKey: 'app-key-123',
    applicationSecret: 'shh',
    consumerKey: 'ck-123',
  };

  it('returns the saved settings and an operation id', async () => {
    stubFetchOnce(200, { ...SETTINGS, operation_id: 'op-1' });

    const result = await updateSmsSettings('org-1', input);

    expect(result).toStrictEqual({
      ok: true,
      settings: SETTINGS,
      operationId: 'op-1',
    });
  });

  it('reports 422 as validation-failed, carrying the server detail', async () => {
    stubFetchOnce(422, {
      type: 'https://evp.example/errors/validation-failed',
      title: 'Validation failed',
      status: 422,
      detail: 'service_name is required',
    });

    const result = await updateSmsSettings('org-1', input);

    expect(result).toStrictEqual({
      ok: false,
      rejection: {
        reason: 'validation-failed',
        detail: 'service_name is required',
      },
    });
  });

  it('reports 403 as forbidden', async () => {
    stubFetchOnce(403, {
      type: 'https://evp.example/errors/forbidden',
      title: 'Forbidden',
      status: 403,
    });

    const result = await updateSmsSettings('org-1', input);

    expect(result).toStrictEqual({
      ok: false,
      rejection: { reason: 'forbidden', detail: 'Forbidden' },
    });
  });

  it('omits blank secret fields so the server keeps the stored value', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ...SETTINGS, operation_id: 'op-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await updateSmsSettings('org-1', {
      provider: 'ovh',
      serviceName: 'sms-xxxxx-1',
      sender: 'MyOrg',
      applicationKey: 'app-key-123',
    });

    const call = fetchMock.mock.calls[0];
    if (call === undefined) {
      throw new Error('fetch was not called');
    }
    const [, requestInit] = call;
    const rawBody = requestInit?.body;
    const sentBody: unknown = JSON.parse(
      typeof rawBody === 'string' ? rawBody : '{}',
    );
    expect(sentBody).not.toHaveProperty('application_secret');
    expect(sentBody).not.toHaveProperty('consumer_key');
  });

  it('reports a network failure as unavailable', async () => {
    stubFetchUnreachable();

    const result = await updateSmsSettings('org-1', input);

    expect(result).toStrictEqual({
      ok: false,
      rejection: { reason: 'unavailable' },
    });
  });
});
