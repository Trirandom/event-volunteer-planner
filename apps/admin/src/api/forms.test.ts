// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The parse boundary for the form endpoints. Two readings of docs/04 were
 * left open when this client was written — whether a write answers with the
 * bare resource or wraps it beside its `operation_id`, and how a refusal
 * carries its `problems` — and a guess in either direction is a whole-page
 * outage, so both are pinned here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createForm,
  fetchForms,
  fetchMissionOptions,
  publishFormVersion,
  saveFormVersion,
  type Form,
  type FormVersion,
} from './forms';

const FORM: Form = {
  id: 'form-1',
  name: 'Soundclash 26',
  slug: 'soundclash-26',
  festival_id: 'festival-1',
  event_id: null,
  public_open: false,
  default_locale: 'fr',
  live_version_id: null,
  versions: [{ id: 'v-1', version: 1, published_at: null, question_count: 8 }],
  version: 1,
};

const VERSION: FormVersion = {
  id: 'v-1',
  form_id: 'form-1',
  version: 1,
  published_at: null,
  privacy_notice_version: null,
  questions: [
    {
      id: 'q-1',
      position: 0,
      kind: 'short_text',
      target_path: 'volunteer.first_name',
      consent_purpose: null,
      label: { fr: 'Prénom' },
      help_text: null,
      options: null,
      is_required: true,
      is_sensitive: false,
      builtin: true,
    },
  ],
  etag_version: 3,
};

function stubFetchOnce(status: number, body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
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

describe('write envelopes', () => {
  it('reads a bare Form', async () => {
    stubFetchOnce(201, FORM);
    const result = await createForm('org-1', {
      name: 'Soundclash 26',
      slug: 'soundclash-26',
      scope: { festivalId: 'festival-1' },
    });
    expect(result).toStrictEqual({ ok: true, value: FORM });
  });

  it('reads a Form wrapped beside its operation id', async () => {
    stubFetchOnce(201, { form: FORM, operation_id: 'op-1' });
    const result = await createForm('org-1', {
      name: 'Soundclash 26',
      slug: 'soundclash-26',
      scope: { festivalId: 'festival-1' },
    });
    expect(result).toStrictEqual({ ok: true, value: FORM });
  });

  it('reads a FormVersion either way', async () => {
    stubFetchOnce(200, VERSION);
    expect(await publishFormVersion('org-1', 'form-1', 1, 3)).toStrictEqual({
      ok: true,
      value: VERSION,
    });
    stubFetchOnce(200, { version: VERSION, operation_id: 'op-2' });
    expect(await publishFormVersion('org-1', 'form-1', 1, 3)).toStrictEqual({
      ok: true,
      value: VERSION,
    });
  });
});

describe('fetchForms', () => {
  it('asks for one scope and accepts the paginated envelope', async () => {
    const fetch = stubFetchOnce(200, { data: [FORM], next: null });
    const result = await fetchForms('org-1', { eventId: 'e 1' });
    expect(result).toStrictEqual({ ok: true, value: [FORM] });
    expect(fetch.mock.calls[0]).toEqual([
      '/api/v1/orgs/org-1/forms?event=e+1',
      expect.anything(),
    ]);
  });

  it('accepts a named key or a bare array too', async () => {
    stubFetchOnce(200, { forms: [FORM] });
    expect(await fetchForms('org-1', { festivalId: 'f' })).toStrictEqual({
      ok: true,
      value: [FORM],
    });
    stubFetchOnce(200, [FORM]);
    expect(await fetchForms('org-1', { festivalId: 'f' })).toStrictEqual({
      ok: true,
      value: [FORM],
    });
  });
});

describe('refusals', () => {
  it('carries the problems a publish named, dropping ones it cannot read', async () => {
    stubFetchOnce(422, {
      type: 'https://evp.example/errors/validation-failed',
      title: 'The form cannot be published',
      status: 422,
      problems: [
        { position: null, code: 'processing_consent_missing', message: 'M' },
        { position: 2, code: 'duplicate_option', message: 'D' },
        { nonsense: true },
      ],
    });
    const result = await publishFormVersion('org-1', 'form-1', 1, 3);
    expect(result).toStrictEqual({
      ok: false,
      rejection: {
        reason: 'invalid',
        detail: 'The form cannot be published',
        problems: [
          { position: null, code: 'processing_consent_missing', message: 'M' },
          { position: 2, code: 'duplicate_option', message: 'D' },
        ],
      },
    });
  });

  it('reads a 409 on a save as a conflict, and sends If-Match', async () => {
    const fetch = stubFetchOnce(409, {
      type: 'https://evp.example/errors/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'The draft changed.',
    });
    const result = await saveFormVersion('org-1', 'form-1', {
      version: 2,
      etag: 7,
      privacyNoticeVersion: null,
      questions: [],
    });
    expect(result).toStrictEqual({
      ok: false,
      rejection: { reason: 'conflict', detail: 'The draft changed.' },
    });
    const init = fetch.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'if-match': '"7"' },
      body: JSON.stringify({ privacy_notice_version: null, questions: [] }),
    });
  });
});

describe('mission flags', () => {
  it('reads an option stored before the flags existed as an ordinary one', async () => {
    stubFetchOnce(200, {
      options: [{ value: 'bar', label: 'Bar', event_ids: ['e-1'] }],
    });
    expect(await fetchMissionOptions('org-1', 'form-1')).toStrictEqual({
      ok: true,
      value: [
        {
          value: 'bar',
          label: 'Bar',
          event_ids: ['e-1'],
          checked_by_default: false,
          adults_only: false,
        },
      ],
    });
  });

  it('keeps the flags the server sends on a mission option', async () => {
    const option = {
      value: 'bar',
      label: 'Bar',
      event_ids: ['e-1'],
      checked_by_default: false,
      adults_only: true,
    };
    stubFetchOnce(200, { options: [option] });
    expect(await fetchMissionOptions('org-1', 'form-1')).toStrictEqual({
      ok: true,
      value: [option],
    });
  });
});
