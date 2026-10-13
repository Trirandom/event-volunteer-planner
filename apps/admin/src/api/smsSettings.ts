// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * OVH SMS credentials for one organisation.
 *
 * Modelled on `festivals.ts` throughout: a valibot schema is the boundary,
 * the TypeScript type is inferred from it, and every rejection is a value
 * the caller must destructure. See `http.ts`'s module doc comment for why.
 *
 * The server never returns the secret or consumer key values themselves —
 * only whether they are set (`has_application_secret` / `has_consumer_key`)
 * — so this module never carries a previously-saved secret back into a form.
 * A coordinator who wants to rotate a key retypes it; leaving both fields
 * blank on save keeps whatever is already stored (ADR-0034).
 */
import * as v from 'valibot';

import { request, type ApiResult, type Failure } from './http';

const VALIDATION_FAILED = 'https://evp.example/errors/validation-failed';
const FORBIDDEN = 'https://evp.example/errors/forbidden';

export const smsSettingsSchema = v.object({
  provider: v.pipe(v.string(), v.minLength(1)),
  service_name: v.nullable(v.string()),
  sender: v.nullable(v.string()),
  application_key: v.nullable(v.string()),
  has_application_secret: v.boolean(),
  has_consumer_key: v.boolean(),
  updated_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
});

export type SmsSettings = v.InferOutput<typeof smsSettingsSchema>;

/** No settings saved yet — a legitimate state, not a failure the caller has
 * to unpack from a 404. */
export const EMPTY_SMS_SETTINGS: SmsSettings = {
  provider: 'ovh',
  service_name: null,
  sender: null,
  application_key: null,
  has_application_secret: false,
  has_consumer_key: false,
  updated_at: null,
};

/** `GET /api/v1/orgs/{org}/sms-settings`.
 *
 * A 404 (nothing saved yet) is folded into `EMPTY_SMS_SETTINGS` here, at the
 * boundary, rather than pushed onto every call site — the view has exactly
 * one thing to render either way: a form, populated or blank.
 */
export async function fetchSmsSettings(
  orgId: string,
  signal?: AbortSignal,
): Promise<ApiResult<SmsSettings>> {
  const result = await request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/sms-settings`,
      ...(signal === undefined ? {} : { signal }),
    },
    smsSettingsSchema,
  );

  if (
    !result.ok &&
    result.failure.reason === 'rejected' &&
    result.failure.problem.status === 404
  ) {
    return { ok: true, value: EMPTY_SMS_SETTINGS };
  }

  return result;
}

export interface UpdateSmsSettingsInput {
  readonly provider: 'ovh';
  readonly serviceName: string;
  readonly sender: string;
  readonly applicationKey: string;
  /** Omitted (not empty-string) means "keep the value already stored". */
  readonly applicationSecret?: string;
  readonly consumerKey?: string;
}

const updateResponseSchema = v.object({
  ...smsSettingsSchema.entries,
  operation_id: v.pipe(v.string(), v.minLength(1)),
});

/** Why `PUT /sms-settings` did not save. */
export type UpdateSmsSettingsRejection =
  | { readonly reason: 'validation-failed'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type UpdateSmsSettingsResult =
  | {
      readonly ok: true;
      readonly settings: SmsSettings;
      readonly operationId: string;
    }
  | { readonly ok: false; readonly rejection: UpdateSmsSettingsRejection };

/** `PUT /api/v1/orgs/{org}/sms-settings`. */
export async function updateSmsSettings(
  orgId: string,
  input: UpdateSmsSettingsInput,
): Promise<UpdateSmsSettingsResult> {
  const result = await request(
    {
      method: 'PUT',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/sms-settings`,
      body: {
        provider: input.provider,
        service_name: input.serviceName,
        sender: input.sender,
        application_key: input.applicationKey,
        ...(input.applicationSecret === undefined
          ? {}
          : { application_secret: input.applicationSecret }),
        ...(input.consumerKey === undefined
          ? {}
          : { consumer_key: input.consumerKey }),
      },
    },
    updateResponseSchema,
  );

  if (!result.ok) {
    return { ok: false, rejection: updateRejectionFor(result.failure) };
  }

  const { operation_id: operationId, ...settings } = result.value;
  return { ok: true, settings, operationId };
}

function updateRejectionFor(failure: Failure): UpdateSmsSettingsRejection {
  if (failure.reason !== 'rejected') {
    return { reason: 'unavailable' };
  }

  const { problem } = failure;
  const detail = problem.detail ?? problem.title;

  if (problem.type === VALIDATION_FAILED) {
    return { reason: 'validation-failed', detail };
  }
  if (problem.type === FORBIDDEN) {
    return { reason: 'forbidden', detail };
  }
  return { reason: 'refused', detail };
}
