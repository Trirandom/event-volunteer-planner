// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The first-party volunteer form, from the authoring side: the form row, its
 * versions and their questions (docs/09, docs/04 §"The volunteer form").
 *
 * Two concurrency tokens, and they are not interchangeable. `Form.version` is
 * the form row's own — name, slug, whether the public route is open — and
 * `FormVersion.etag_version` is the draft's, bumped by every `PUT` of its
 * questions. A coordinator renaming the form must not invalidate somebody
 * else's unsaved questions, which is exactly what one shared token would do.
 * Both are read from the body rather than from `ETag`, because both are in
 * the body and the header is only the same number quoted.
 *
 * **Tolerant of two envelopes on writes.** docs/04 says `POST …/forms` answers
 * "Form" and `PUT …/versions/{v}` answers "FormVersion", and also that every
 * mutating route returns an `operation_id` — which the festival and event
 * routes do by wrapping the resource under a named key (`{ festival,
 * operation_id }`). Which of the two readings the server settles on was not
 * fixed when this was written, so each write schema accepts both and keeps
 * the operation id when there is one. Once `@evp/api-client` is generated the
 * union collapses to whichever arm it names.
 */

import * as v from 'valibot';

import {
  request,
  requestNoContent,
  type ApiResult,
  type Failure,
} from './http';

const CONFLICT = 'https://evp.example/errors/conflict';
const PRECONDITION_REQUIRED =
  'https://evp.example/errors/precondition-required';
const FORBIDDEN = 'https://evp.example/errors/forbidden';
const VALIDATION_FAILED = 'https://evp.example/errors/validation-failed';
const INVALID_REQUEST = 'https://evp.example/errors/invalid-request';

const id = v.pipe(v.string(), v.minLength(1));
const count = v.pipe(v.number(), v.integer(), v.minValue(0));

export const QUESTION_KINDS = [
  'short_text',
  'long_text',
  'email',
  'phone',
  'date',
  'single_choice',
  'multi_choice',
  'boolean',
  'availability',
  'missions',
  'consent',
  'section',
] as const;

export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const TARGET_PATHS = [
  'volunteer.first_name',
  'volunteer.last_name',
  'volunteer.email',
  'volunteer.phone',
  'volunteer.tshirt_size',
  'volunteer.dietary',
  'volunteer.notes',
] as const;

export type TargetPath = (typeof TARGET_PATHS)[number];

export const CONSENT_PURPOSES = [
  'processing',
  'pool_retention',
  'commitment',
] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const FORM_LOCALES = ['fr', 'en'] as const;

export type FormLocale = (typeof FORM_LOCALES)[number];

/**
 * `fr` always, `en` when somebody wrote one (docs/09 §7). `nullish` on `en`
 * because an absent translation may reach us as a missing key or as `null`
 * depending on how the DTO is serialised, and either spelling means the same
 * thing: fall back to French.
 */
const localizedSchema = v.object({
  fr: v.string(),
  en: v.nullish(v.string()),
});

export type Localized = v.InferOutput<typeof localizedSchema>;

const optionSchema = v.object({
  value: id,
  label: localizedSchema,
  skill_id: v.nullish(id),
  /**
   * `missions` only, and read-only: the server stamps both from the zones on
   * every write, so what this client sends back is ignored. Defaulted rather
   * than required so a version stored before migration
   * `…093000_locations_form_flags` still parses; `false` is also what the
   * server writes on every other kind's options.
   */
  checked_by_default: v.optional(v.boolean(), false),
  adults_only: v.optional(v.boolean(), false),
});

export type QuestionOption = v.InferOutput<typeof optionSchema>;

/**
 * `kind`, `target_path` and `consent_purpose` are picklists, unlike the plain
 * strings `events.ts` keeps `status` as. The editor has to *act* on these —
 * which toggle is locked, which options editor to draw — and a kind it does
 * not know could not be round-tripped through a `PUT` without losing what the
 * server meant by it. Refusing the version outright is the honest failure.
 */
export const questionSchema = v.object({
  id,
  position: v.pipe(v.number(), v.integer()),
  kind: v.picklist(QUESTION_KINDS),
  target_path: v.nullable(v.picklist(TARGET_PATHS)),
  consent_purpose: v.nullable(v.picklist(CONSENT_PURPOSES)),
  label: localizedSchema,
  help_text: v.nullish(localizedSchema),
  options: v.nullish(v.array(optionSchema)),
  is_required: v.boolean(),
  is_sensitive: v.boolean(),
  builtin: v.boolean(),
});

export type Question = v.InferOutput<typeof questionSchema>;

const versionSummarySchema = v.object({
  id,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  published_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  question_count: count,
});

export type FormVersionSummary = v.InferOutput<typeof versionSummarySchema>;

export const formSchema = v.object({
  id,
  name: v.pipe(v.string(), v.minLength(1)),
  slug: v.pipe(v.string(), v.minLength(1)),
  festival_id: v.nullable(id),
  event_id: v.nullable(id),
  public_open: v.boolean(),
  default_locale: v.picklist(FORM_LOCALES),
  live_version_id: v.nullable(id),
  versions: v.array(versionSummarySchema),
  version: count,
});

export type Form = v.InferOutput<typeof formSchema>;

export const formVersionSchema = v.object({
  id,
  form_id: id,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  published_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  privacy_notice_version: v.nullable(v.string()),
  questions: v.array(questionSchema),
  etag_version: count,
});

export type FormVersion = v.InferOutput<typeof formVersionSchema>;

/**
 * One mission the scope could offer. `value` is the folded name key — the
 * same fold `plan/missionCatalog.ts` applies — so it is what a `missions`
 * option's `value` must equal to resolve to a location.
 */
const missionOptionSchema = v.object({
  value: id,
  label: v.pipe(v.string(), v.minLength(1)),
  event_ids: v.array(id),
  /** Already folded by the server: `false` when any of the mission's zones
   * asks for an explicit tick or is adults-only — what the volunteer will
   * actually see, not the zone setting itself. */
  checked_by_default: v.optional(v.boolean(), false),
  adults_only: v.optional(v.boolean(), false),
});

export type MissionOption = v.InferOutput<typeof missionOptionSchema>;

/** `position` names the question; `null` is a whole-form omission, such as
 * "no processing consent". */
export const publishProblemSchema = v.object({
  position: v.nullable(v.pipe(v.number(), v.integer())),
  code: v.pipe(v.string(), v.minLength(1)),
  message: v.string(),
});

export type PublishProblem = v.InferOutput<typeof publishProblemSchema>;

/** What `PUT …/versions/{v}` accepts per question: a `Question` without the
 * three fields the server owns, in array order. */
export interface QuestionInput {
  readonly kind: QuestionKind;
  readonly target_path: TargetPath | null;
  readonly consent_purpose: ConsentPurpose | null;
  readonly label: { readonly fr: string; readonly en?: string };
  readonly help_text: { readonly fr: string; readonly en?: string } | null;
  readonly options:
    | readonly {
        readonly value: string;
        readonly label: { readonly fr: string; readonly en?: string };
        readonly skill_id?: string;
      }[]
    | null;
  readonly is_required: boolean;
  readonly is_sensitive: boolean;
}

/* Each accepts the bare resource or `{ <key>: resource, operation_id }` — see
 * the module comment. The wrapped arm is tried first: a bare `FormVersion`
 * has a numeric `version`, so it can never be mistaken for `{ version: {…} }`.
 * Written out twice rather than through a generic helper, because a computed
 * key erases the entry's type and the transform would have to assert it back. */
const writtenFormSchema = v.union([
  v.pipe(
    v.object({ form: formSchema, operation_id: v.optional(v.string()) }),
    v.transform((body) => body.form),
  ),
  formSchema,
]);

const writtenVersionSchema = v.union([
  v.pipe(
    v.object({
      version: formVersionSchema,
      operation_id: v.optional(v.string()),
    }),
    v.transform((body) => body.version),
  ),
  formVersionSchema,
]);

/** The list envelope was not fixed by docs/04 either; the paginated
 * `{ data, next }` every other list uses, a named key, and a bare array are
 * all accepted and read the same. */
const formListSchema = v.union([
  v.pipe(
    v.object({ data: v.array(formSchema) }),
    v.transform((body) => body.data),
  ),
  v.pipe(
    v.object({ forms: v.array(formSchema) }),
    v.transform((body) => body.forms),
  ),
  v.array(formSchema),
]);

const missionOptionsSchema = v.object({
  options: v.array(missionOptionSchema),
});

function formsPath(orgId: string): string {
  return `/api/v1/orgs/${encodeURIComponent(orgId)}/forms`;
}

function formPath(orgId: string, formId: string): string {
  return `${formsPath(orgId)}/${encodeURIComponent(formId)}`;
}

/**
 * `{v}` is the version *number* — `v1`, `v2`, as the version list shows them
 * — rather than the version's id. Kept in one function so that reading of
 * docs/04 is a one-line change if the server keys it the other way.
 */
function versionPath(orgId: string, formId: string, version: number): string {
  return `${formPath(orgId, formId)}/versions/${String(version)}`;
}

/** What a form covers. Exactly one of the two is sent: docs/04's `?festival=`
 * and `?event=` are alternatives, and a form has at most one scope
 * (`forms_one_scope`, ADR-0035). */
export type FormScope =
  { readonly festivalId: string } | { readonly eventId: string };

/** `GET /api/v1/orgs/{org}/forms?festival=|event=`. */
export async function fetchForms(
  orgId: string,
  scope: FormScope,
  signal?: AbortSignal,
): Promise<ApiResult<readonly Form[]>> {
  const params = new URLSearchParams(
    'festivalId' in scope
      ? { festival: scope.festivalId }
      : { event: scope.eventId },
  );
  return request(
    {
      method: 'GET',
      path: `${formsPath(orgId)}?${params.toString()}`,
      ...(signal === undefined ? {} : { signal }),
    },
    formListSchema,
  );
}

/** `GET /api/v1/orgs/{org}/forms/{form}`. */
export async function fetchForm(
  orgId: string,
  formId: string,
  signal?: AbortSignal,
): Promise<ApiResult<Form>> {
  return request(
    {
      method: 'GET',
      path: formPath(orgId, formId),
      ...(signal === undefined ? {} : { signal }),
    },
    formSchema,
  );
}

/** `GET …/forms/{form}/versions/{v}`. */
export async function fetchFormVersion(
  orgId: string,
  formId: string,
  version: number,
  signal?: AbortSignal,
): Promise<ApiResult<FormVersion>> {
  return request(
    {
      method: 'GET',
      path: versionPath(orgId, formId, version),
      ...(signal === undefined ? {} : { signal }),
    },
    formVersionSchema,
  );
}

/** `GET …/forms/{form}/mission-options` — the scope's missions *now*, which
 * is what a draft is compared against to find missions added since. */
export async function fetchMissionOptions(
  orgId: string,
  formId: string,
  signal?: AbortSignal,
): Promise<ApiResult<readonly MissionOption[]>> {
  const result = await request(
    {
      method: 'GET',
      path: `${formPath(orgId, formId)}/mission-options`,
      ...(signal === undefined ? {} : { signal }),
    },
    missionOptionsSchema,
  );
  return result.ok ? { ok: true, value: result.value.options } : result;
}

/** Why a form write did not happen. */
export type FormWriteRejection =
  /**
   * `409`: somebody else saved first, the version was published under us,
   * or — on create — the slug is taken. `428` joins it: a missing `If-Match`
   * is this client's bug, but the remedy a coordinator has is the same
   * reload.
   */
  | { readonly reason: 'conflict'; readonly detail: string }
  /** `422`, with whatever the server named. `problems` is empty when the
   * refusal was about a field rather than a question. */
  | {
      readonly reason: 'invalid';
      readonly detail: string;
      readonly problems: readonly PublishProblem[];
    }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type FormWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: FormWriteRejection };

/**
 * The `problems` extension, item by item. An item that does not parse is
 * dropped rather than failing the whole list: the refusal itself is certain,
 * and losing one line of explanation is better than losing all of them.
 */
function problemsOf(raw: readonly unknown[] | undefined): PublishProblem[] {
  return (raw ?? []).flatMap((item) => {
    const parsed = v.safeParse(publishProblemSchema, item);
    return parsed.success ? [parsed.output] : [];
  });
}

export function rejectionFor(failure: Failure): FormWriteRejection {
  if (failure.reason !== 'rejected') {
    return { reason: 'unavailable' };
  }

  const { problem } = failure;
  const detail = problem.detail ?? problem.title;

  if (problem.type === CONFLICT || problem.type === PRECONDITION_REQUIRED) {
    return { reason: 'conflict', detail };
  }
  if (
    problem.type === VALIDATION_FAILED ||
    problem.type === INVALID_REQUEST ||
    problem.problems !== undefined
  ) {
    return {
      reason: 'invalid',
      detail,
      problems: problemsOf(problem.problems),
    };
  }
  if (problem.type === FORBIDDEN) {
    return { reason: 'forbidden', detail };
  }
  return { reason: 'refused', detail };
}

function settle<T>(result: ApiResult<T>): FormWriteResult<T> {
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, rejection: rejectionFor(result.failure) };
}

export interface CreateFormInput {
  readonly name: string;
  readonly slug: string;
  readonly scope: FormScope;
}

/** `POST /api/v1/orgs/{org}/forms` — `201`, with draft version 1 seeded by
 * the server (docs/04 §"The seeded draft"). */
export async function createForm(
  orgId: string,
  input: CreateFormInput,
): Promise<FormWriteResult<Form>> {
  return settle(
    await request(
      {
        method: 'POST',
        path: formsPath(orgId),
        body: {
          name: input.name,
          slug: input.slug,
          ...('festivalId' in input.scope
            ? { festival_id: input.scope.festivalId }
            : { event_id: input.scope.eventId }),
        },
      },
      writtenFormSchema,
    ),
  );
}

/** What the settings panel can change. Absent keys are left alone. */
export interface FormSettingsChanges {
  readonly name?: string;
  readonly publicOpen?: boolean;
  readonly defaultLocale?: FormLocale;
}

/** `PATCH …/forms/{form}`, asserting the form row's own version. */
export async function patchForm(
  orgId: string,
  formId: string,
  version: number,
  changes: FormSettingsChanges,
): Promise<FormWriteResult<Form>> {
  return settle(
    await request(
      {
        method: 'PATCH',
        path: formPath(orgId, formId),
        body: {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.publicOpen === undefined
            ? {}
            : { public_open: changes.publicOpen }),
          ...(changes.defaultLocale === undefined
            ? {}
            : { default_locale: changes.defaultLocale }),
        },
        ifMatchVersion: version,
      },
      writtenFormSchema,
    ),
  );
}

/** `DELETE …/forms/{form}` — only while nothing is published. */
export async function deleteForm(
  orgId: string,
  formId: string,
  version: number,
): Promise<FormWriteResult<null>> {
  const outcome = await requestNoContent({
    method: 'DELETE',
    path: formPath(orgId, formId),
    ifMatchVersion: version,
  });
  return outcome.ok
    ? { ok: true, value: null }
    : { ok: false, rejection: rejectionFor(outcome.failure) };
}

/** `POST …/forms/{form}/versions` — a new draft copied from the live one;
 * `409` when a draft already exists. */
export async function createFormVersion(
  orgId: string,
  formId: string,
): Promise<FormWriteResult<FormVersion>> {
  return settle(
    await request(
      { method: 'POST', path: `${formPath(orgId, formId)}/versions` },
      writtenVersionSchema,
    ),
  );
}

export interface SaveVersionInput {
  readonly version: number;
  /** The draft's `etag_version`, sent as `If-Match`. */
  readonly etag: number;
  readonly privacyNoticeVersion: string | null;
  readonly questions: readonly QuestionInput[];
}

/** `PUT …/versions/{v}` — the whole question list, replaced atomically
 * (docs/04 §1 "Atomic replacement"). */
export async function saveFormVersion(
  orgId: string,
  formId: string,
  input: SaveVersionInput,
): Promise<FormWriteResult<FormVersion>> {
  return settle(
    await request(
      {
        method: 'PUT',
        path: versionPath(orgId, formId, input.version),
        // Always sent: the server reads an omitted key as "leave it as it
        // is" and `null` as "clear it", and a coordinator emptying the box
        // means the second.
        body: {
          privacy_notice_version: input.privacyNoticeVersion,
          questions: input.questions,
        },
        ifMatchVersion: input.etag,
      },
      writtenVersionSchema,
    ),
  );
}

/** `POST …/versions/{v}/publish` — freezes the version and makes it live. */
export async function publishFormVersion(
  orgId: string,
  formId: string,
  version: number,
  etag: number,
): Promise<FormWriteResult<FormVersion>> {
  return settle(
    await request(
      {
        method: 'POST',
        path: `${versionPath(orgId, formId, version)}/publish`,
        ifMatchVersion: etag,
      },
      writtenVersionSchema,
    ),
  );
}
