// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendTestRun } from './publish';

const INPUT = {
  recipient: 'me@example.test',
  locale: 'fr',
  subject: 'Tes créneaux',
  bodyHtml: '<p>Bonjour {{firstName}}</p>',
} as const;

function stubFetchOnce(status: number, body: unknown) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendTestRun', () => {
  it('posts the template to the scope’s route and reads the summary', async () => {
    const summary = {
      sent: 2,
      skipped_opted_out: 1,
      no_address: ['Nomail'],
      failed: null,
    };
    const fetch = stubFetchOnce(200, summary);

    const result = await sendTestRun(
      'org-1',
      { kind: 'festival', id: 'fest-1' },
      INPUT,
    );

    expect(result).toStrictEqual({ ok: true, summary });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/orgs/org-1/festivals/fest-1/publish/test');
    expect(typeof init?.body).toBe('string');
    expect(
      JSON.parse(typeof init?.body === 'string' ? init.body : ''),
    ).toStrictEqual({
      test_recipient: 'me@example.test',
      locale: 'fr',
      template: {
        subject: 'Tes créneaux',
        body_html: '<p>Bonjour {{firstName}}</p>',
      },
    });
  });

  it('reads a run the relay stopped as a summary, not a failure', async () => {
    const summary = {
      sent: 0,
      skipped_opted_out: 0,
      no_address: [],
      failed: {
        name: 'Aurel',
        reason: 'refused',
        detail: '550 no such mailbox',
      },
    };
    stubFetchOnce(200, summary);

    const result = await sendTestRun(
      'org-1',
      { kind: 'event', id: 'ev-1' },
      INPUT,
    );

    expect(result).toStrictEqual({ ok: true, summary });
  });

  it('names a refused address as invalid', async () => {
    stubFetchOnce(422, {
      type: 'https://evp.example/errors/validation-failed',
      title: 'Validation failed',
      status: 422,
      detail: 'test_recipient must be one email address.',
    });

    const result = await sendTestRun(
      'org-1',
      { kind: 'event', id: 'ev-1' },
      INPUT,
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'invalid',
      detail: 'test_recipient must be one email address.',
    });
  });
});
