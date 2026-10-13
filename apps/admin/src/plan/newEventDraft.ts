// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * What the "add a day" form holds, and what it would send.
 *
 * Split out of the component for the reason `eventDraft.ts` states and this
 * form makes worse: the same two wall-clock fields, but with no stored row to
 * be checked against afterwards. An editing form that converts a zone wrongly
 * shows the wrong time back and somebody notices; a creating form that does
 * it writes an event whose hours are an hour out and nothing on screen
 * disagrees. Conversion happens here, at one edge, and never in the template.
 *
 * The slug is the other half. It is `UNIQUE (org_id, slug)` in the schema and
 * has no default — the events list makes a coordinator type one, which is the
 * kind of field people fill with `Samedi 1er` and then wonder about. Here it
 * is derived from the name until somebody edits it, and derived into
 * something the column will actually accept.
 */
import { Temporal } from '@evp/shared/time';

import type { CreateEventInput } from '../api/events';
import { instantFromLocal } from '../format/period';

/**
 * The form's state: five `<input>` values and one flag.
 *
 * Mutable, unlike most of `plan/`, for the reason `NewMissionDraft` is: three
 * of these fields are written straight by `v-model`, and a `readonly` field
 * bound to one is a type error or a lie. The two that are *not* independent —
 * the name and the slug — are written through `withName`/`withSlug` instead,
 * which is what keeps the rule between them in one testable place.
 */
export interface NewEventDraft {
  name: string;
  slug: string;
  /**
   * Whether the slug has been typed in rather than derived.
   *
   * Part of the draft and not component state, because it is what decides
   * whether renaming rewrites the slug — the one piece of this form's
   * behaviour worth proving without a browser. Once true it stays true: a
   * coordinator who clears the field they edited is asking for an empty slug
   * and a red field, not for the name to silently take the field back over.
   */
  slugEdited: boolean;
  timezone: string;
  start: string;
  end: string;
}

/**
 * A blank form for a production in `timezone`.
 *
 * The zone is seeded and the hours are not, and the difference is deliberate.
 * The zone is a fact about the production that is already on the page and is
 * wrong roughly never; the hours are the thing being decided, and a form that
 * guessed "the day after the last one, same times" would be right often
 * enough that the times would stop being read.
 */
export function emptyNewEventDraft(timezone: string): NewEventDraft {
  return {
    name: '',
    slug: '',
    slugEdited: false,
    timezone,
    start: '',
    end: '',
  };
}

/**
 * A name as a slug.
 *
 * Unicode is folded rather than dropped, so `Samedi 1er août` becomes
 * `samedi-1er-aout` instead of `samedi-1er-ao-t`: half the festivals this is
 * written for are French, and a slug is a URL a volunteer may end up reading
 * aloud. `NFD` splits the accent off its letter and the combining-mark range
 * is what gets removed, which handles every accented Latin letter without a
 * table of them.
 *
 * The output is the shape `organizations_slug_format` asks of an org slug —
 * lowercase, digits and inner hyphens. Events carry no such `CHECK`, but the
 * slug goes in a URL either way and there is no reason to generate something
 * the neighbouring table would have refused.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * The draft with a new name, and the slug still following it.
 *
 * One function rather than a `v-model` on the name plus a watcher, because
 * "the slug follows the name until you touch it" is a rule about two fields
 * at once and a watcher makes it a rule about the order they happened to
 * update in.
 */
export function withName(draft: NewEventDraft, name: string): NewEventDraft {
  return {
    ...draft,
    name,
    slug: draft.slugEdited ? draft.slug : slugify(name),
  };
}

/** The draft with a hand-typed slug, which the name stops overwriting. */
export function withSlug(draft: NewEventDraft, slug: string): NewEventDraft {
  return { ...draft, slug, slugEdited: true };
}

/**
 * Why a draft cannot be sent.
 *
 * Named rather than pre-worded, as everywhere else in `plan/`: the component
 * owns the sentence. Each mirrors a refusal the server would make anyway —
 * except `slug-taken`, which mirrors one it *would* make (`UNIQUE (org_id,
 * slug)` comes back as a 409) but only about the days this page can see.
 */
export type NewEventProblem =
  | 'name-missing'
  | 'slug-missing'
  | 'slug-taken'
  | 'timezone-unknown'
  | 'start-missing'
  | 'end-missing'
  | 'period-inverted';

/** A wall-clock field as epoch milliseconds, or `null` when it is not a
 * reading — see `eventDraft.ts`: the parser is the authority on what it
 * accepts, and an unknown IANA zone throws out of here too. */
function msOrNull(value: string, timezone: string): number | null {
  if (value === '') {
    return null;
  }
  try {
    return Temporal.Instant.from(instantFromLocal(value, timezone))
      .epochMilliseconds;
  } catch {
    return null;
  }
}

/**
 * Whether `instantFromLocal` will accept this zone.
 *
 * Asked separately rather than inferred from a failed conversion, so a
 * mistyped zone says "that is not a timezone" instead of "say when the day
 * starts" about a field that is filled in.
 *
 * Probed through the conversion itself, on a fixed wall-clock reading that is
 * neither ambiguous nor skipped in any zone, rather than by constructing a
 * formatter: `Intl` is off limits here (`docs/16 §6` — every formatter goes
 * through `@evp/shared/intl` with an explicit event zone), and the authority
 * on what this module can convert is the function that does the converting.
 * The instant is discarded; only whether it could be computed matters.
 */
function zoneIsKnown(timezone: string): boolean {
  if (timezone === '') {
    return false;
  }
  try {
    instantFromLocal('2000-01-01T12:00', timezone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first thing wrong with a draft, or `null`.
 *
 * First and not all, as in `eventDraft.ts`. The order is the order the fields
 * are read in, so the message points at the field a coordinator's eye is
 * already near.
 *
 * `taken` is every slug already in use among the days this page covers. It is
 * not the whole org — this page has not loaded the whole org — so a clash
 * outside the production still comes back as a 409, and both paths have to
 * keep working.
 */
export function newEventProblem(
  draft: NewEventDraft,
  taken: readonly string[],
): NewEventProblem | null {
  if (draft.name.trim() === '') {
    return 'name-missing';
  }

  const slug = draft.slug.trim().toLowerCase();
  if (slug === '') {
    return 'slug-missing';
  }
  // `citext`, so the comparison is case-insensitive on both sides.
  if (taken.some((other) => other.toLowerCase() === slug)) {
    return 'slug-taken';
  }

  if (!zoneIsKnown(draft.timezone)) {
    return 'timezone-unknown';
  }

  const start = msOrNull(draft.start, draft.timezone);
  if (start === null) {
    return 'start-missing';
  }
  const end = msOrNull(draft.end, draft.timezone);
  if (end === null) {
    return 'end-missing';
  }
  // `events_period_valid` — a period that is empty or inverted is refused by
  // the column; refused here so it is refused next to the field.
  if (end <= start) {
    return 'period-inverted';
  }

  return null;
}

/**
 * What to POST, or `null` when the draft is not sendable.
 *
 * Returns `null` rather than throwing on a bad draft: the caller has already
 * asked `newEventProblem` and a second answer to the same question should not
 * be an exception. The festival is passed in rather than read off the draft
 * because it is not a field — it is which page this form is on, and a form
 * that let it be edited would be the events list's form, not this one.
 */
export function newEventInput(
  draft: NewEventDraft,
  festivalId: string | null,
): CreateEventInput | null {
  if (newEventProblem(draft, []) !== null) {
    return null;
  }

  return {
    name: draft.name.trim(),
    slug: draft.slug.trim().toLowerCase(),
    timezone: draft.timezone,
    period: {
      start: instantFromLocal(draft.start, draft.timezone),
      end: instantFromLocal(draft.end, draft.timezone),
    },
    // Omitted, not `undefined`-valued: `exactOptionalPropertyTypes` makes
    // those two different bodies, and the server reads "standalone" as the
    // absent key (`api/events.ts`).
    ...(festivalId === null ? {} : { festivalId }),
  };
}
