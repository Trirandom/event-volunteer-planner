// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * `GET /api/v1/public/forms/{slug}` and its submission (docs/04 §"Public and
 * unauthenticated").
 *
 * docs/04 describes what the response carries — the live version's
 * questions, the events in scope with their days and step, the suggested
 * chips, the resolved locale, and prefill with a token — but not its field
 * names; the endpoint is not built yet. The names below follow the admin
 * `FormVersion`/`Question` shapes wherever one exists, so the server side has
 * one vocabulary to implement, and this schema is the contract it will be
 * held to.
 */
import * as v from 'valibot';

import type { CaptchaSolution } from '../captcha/solve';

import { request, requestAccepted, type ApiResult, type Failure } from './http';

const id = v.pipe(v.string(), v.minLength(1));
const instant = v.pipe(v.string(), v.isoTimestamp());

export const localizedSchema = v.object({
  fr: v.string(),
  en: v.nullish(v.string()),
});

export type Localized = v.InferOutput<typeof localizedSchema>;

const QUESTION_KINDS = [
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

const optionSchema = v.object({
  value: id,
  label: localizedSchema,
  // `missions` only, and stamped from the zones at publish. Optional so a
  // version served by an older API still parses, offered as it was then:
  // nothing ticked, nothing marked.
  checked_by_default: v.optional(v.boolean(), false),
  adults_only: v.optional(v.boolean(), false),
});

export type QuestionOption = v.InferOutput<typeof optionSchema>;

/**
 * A kind this bundle does not know is a refusal of the whole form, not a
 * question silently skipped: a skipped required question is a submission the
 * server will reject after the volunteer has done all the work.
 */
const questionSchema = v.object({
  id,
  kind: v.picklist(QUESTION_KINDS),
  target_path: v.nullable(v.string()),
  // Any string: every consent renders as the same checkbox, and the server
  // judges which one is the processing consent. A purpose added later
  // (`commitment`) must not make the whole form unrenderable.
  consent_purpose: v.nullable(v.string()),
  label: localizedSchema,
  help_text: v.nullish(localizedSchema),
  options: v.nullish(v.array(optionSchema)),
  is_required: v.boolean(),
  is_sensitive: v.boolean(),
});

export type Question = v.InferOutput<typeof questionSchema>;

const periodSchema = v.object({ start: instant, end: instant });

export type Period = v.InferOutput<typeof periodSchema>;

/** One `intake_slot_options` row: a suggested range, never a constraint. */
const slotOptionSchema = v.object({
  label: localizedSchema,
  start: instant,
  end: instant,
});

export type SlotOption = v.InferOutput<typeof slotOptionSchema>;

const scopeEventSchema = v.object({
  id,
  name: v.pipe(v.string(), v.minLength(1)),
  timezone: v.pipe(v.string(), v.minLength(1)),
  /** Operational window: what availability is clamped to (ADR-0044). */
  period: periodSchema,
  /** Public hours, shown as context only. */
  public_period: v.nullish(periodSchema),
  availability_step_minutes: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(240),
  ),
  slot_options: v.optional(v.array(slotOptionSchema), []),
});

export type ScopeEvent = v.InferOutput<typeof scopeEventSchema>;

const windowSchema = v.object({
  event_id: id,
  kind: v.picklist(['available', 'unavailable']),
  start: instant,
  end: instant,
});

export type AvailabilityWindow = v.InferOutput<typeof windowSchema>;

/**
 * An answer as the server stores it per question. One union for every kind
 * rather than one per kind, because prefill arrives keyed by question id and
 * the kind is only known by looking the question up.
 */
const answerValueSchema = v.union([
  v.string(),
  v.boolean(),
  v.array(v.string()),
  v.null(),
]);

export type AnswerValue = v.InferOutput<typeof answerValueSchema>;

const prefillSchema = v.object({
  answers: v.record(v.string(), answerValueSchema),
  availability: v.optional(v.array(windowSchema), []),
});

export type Prefill = v.InferOutput<typeof prefillSchema>;

/** ADR-0043: the proof of work a submission must carry. Absent only on the
 * development demo, which has no server to verify it. */
const captchaSchema = v.object({
  algorithm: v.string(),
  challenge: v.pipe(v.string(), v.minLength(1)),
  salt: v.pipe(v.string(), v.minLength(1)),
  maxnumber: v.pipe(v.number(), v.integer(), v.minValue(0)),
  signature: v.pipe(v.string(), v.minLength(1)),
});

export const publicFormSchema = v.object({
  form: v.object({
    slug: id,
    name: v.pipe(v.string(), v.minLength(1)),
    default_locale: v.picklist(['fr', 'en']),
  }),
  version: v.object({
    id,
    version: v.pipe(v.number(), v.integer(), v.minValue(1)),
    privacy_notice_version: v.nullable(v.string()),
    questions: v.array(questionSchema),
  }),
  /** Events in scope, in period order: one availability group each. */
  events: v.array(scopeEventSchema),
  prefill: v.nullish(prefillSchema),
  captcha: v.nullish(captchaSchema),
});

export type PublicForm = v.InferOutput<typeof publicFormSchema>;

function path(slug: string, token: string | null, suffix = ''): string {
  const query = token === null ? '' : `?t=${encodeURIComponent(token)}`;
  return `/api/v1/public/forms/${encodeURIComponent(slug)}${suffix}${query}`;
}

export async function fetchPublicForm(
  slug: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<ApiResult<PublicForm>> {
  return request(
    {
      method: 'GET',
      path: path(slug, token),
      ...(signal === undefined ? {} : { signal }),
    },
    publicFormSchema,
  );
}

export interface SubmissionBody {
  readonly form_version_id: string;
  readonly locale: 'fr' | 'en';
  readonly answers: Readonly<Record<string, AnswerValue>>;
  readonly availability: readonly AvailabilityWindow[];
  /** docs/09 §5: the honeypot, sent as typed. Anything but `''` is spam. */
  readonly website: string;
  /** docs/09 §5: the timing floor is judged server-side from this. */
  readonly elapsed_ms: number;
  /** ADR-0043: the solved challenge; `null` if it could not be solved, which
   * the server refuses as `captcha`. */
  readonly captcha: CaptchaSolution | null;
}

export type SubmitOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: 'stale' | 'email_taken' | 'captcha' | 'refused';
      readonly failure: Failure;
    }
  | {
      readonly ok: false;
      readonly kind: 'unavailable';
      readonly failure: Failure;
    };

/**
 * `409` is a stale version (docs/04): the form changed while it was open, and
 * the volunteer re-renders rather than answering questions that are gone.
 * The address-in-use refusal of ADR-0028 is told apart by its problem type,
 * never by its prose.
 */
export async function submitForm(
  slug: string,
  token: string | null,
  body: SubmissionBody,
): Promise<SubmitOutcome> {
  const sent = await requestAccepted({
    method: 'POST',
    path: path(slug, token, '/submissions'),
    body,
  });
  if (sent.ok) {
    return sent;
  }
  const { failure } = sent;
  if (failure.reason !== 'rejected') {
    return { ok: false, kind: 'unavailable', failure };
  }
  if (
    failure.status === 409 &&
    failure.problem?.type.endsWith('/email-in-use') === true
  ) {
    return { ok: false, kind: 'email_taken', failure };
  }
  if (failure.status === 409) {
    return { ok: false, kind: 'stale', failure };
  }
  if (failure.problem?.type.endsWith('/captcha-failed') === true) {
    return { ok: false, kind: 'captcha', failure };
  }
  return { ok: false, kind: 'refused', failure };
}
