// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The schedule email: who gets one, what their shifts are, and what the
 * coordinator's template turns into once it is filled in for them.
 *
 * Built from the assignation grid (`plan/roster.ts`) rather than from raw
 * assignments, because the grid has already joined each placement to its
 * mission's name and its day's timezone — a second join here would be a
 * second place for "which post is this shift at?" to be answered wrongly.
 *
 * Pure and test-first: "does Camille get the right lines, and can her name
 * break the HTML?" is the whole question this page exists to answer, and it
 * is not one to check by looking at five hundred rows.
 */
import {
  eventTimeZone,
  formatDay,
  formatTime,
  nameCollator,
  type ViewerLocale,
} from '@evp/shared/intl';

import { isAssignable, type Participation } from '../api/participations';
import { locale, t } from '../i18n';
import type { RosterRow } from './roster';

/** One line of somebody's schedule: a post, on a day, for some hours. */
export interface ScheduleLine {
  readonly key: string;
  readonly mission: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly timezone: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface Recipient {
  readonly volunteerId: string;
  readonly name: string;
  /** Chronological, with touching shifts at one post already merged. */
  readonly lines: readonly ScheduleLine[];
}

/**
 * Touching shifts at the same post, on the same day, become one line.
 *
 * docs/01 S10: "Sam. 5/9 10h–18h : Bar", not four half-day entries. The cut
 * points exist so different people can take different hours; somebody who
 * took all of them worked one afternoon, and a schedule listing four is one
 * a volunteer reads as four separate trips to the site. Only an exact touch
 * merges — a break of any length between two shifts is a break they are owed.
 */
export function mergeAdjacent(
  lines: readonly ScheduleLine[],
): readonly ScheduleLine[] {
  const sorted = [...lines].sort((a, b) => a.startMs - b.startMs);
  const merged: ScheduleLine[] = [];
  for (const line of sorted) {
    const index = merged.findLastIndex(
      (earlier) =>
        earlier.mission === line.mission &&
        earlier.eventId === line.eventId &&
        earlier.endMs === line.startMs,
    );
    const earlier = merged[index];
    if (earlier === undefined) {
      merged.push(line);
    } else {
      merged[index] = { ...earlier, endMs: line.endMs };
    }
  }
  return merged;
}

/**
 * Everybody who should receive a schedule, and what it lists.
 *
 * Keyed by *volunteer*, not participation: a festival-wide run covers several
 * days, each with its own enrolment, and one person must get one email
 * listing all of them rather than one per day.
 *
 * Enrolled volunteers with no shift at all are included, with no lines. The
 * spec is explicit that silence is not an acceptable output for them
 * (docs/01 S10) — they are the case most likely to turn up when they should
 * not — so the page shows them rather than quietly leaving them out.
 * Declined and withdrawn volunteers are not written to at all.
 */
export function recipientsOf(
  rows: readonly RosterRow[],
  participants: ReadonlyMap<string, readonly Participation[]>,
  locale: ViewerLocale,
): readonly Recipient[] {
  const names = new Map<string, string>();
  const lines = new Map<string, ScheduleLine[]>();

  for (const people of participants.values()) {
    for (const person of people) {
      if (isAssignable(person)) {
        names.set(person.volunteer_id, person.display_name);
        if (!lines.has(person.volunteer_id)) {
          lines.set(person.volunteer_id, []);
        }
      }
    }
  }

  for (const row of rows) {
    for (const slot of row.slots) {
      for (const seat of slot.seats) {
        const holder = seat.holder;
        if (holder === null) {
          continue;
        }
        if (!names.has(holder.volunteerId)) {
          names.set(holder.volunteerId, holder.name);
        }
        const own = lines.get(holder.volunteerId) ?? [];
        own.push({
          key: `${slot.shiftId}:${holder.volunteerId}`,
          mission: row.name,
          eventId: slot.eventId,
          eventName: slot.eventName,
          timezone: slot.timezone,
          startMs: slot.startMs,
          endMs: slot.endMs,
        });
        lines.set(holder.volunteerId, own);
      }
    }
  }

  const collator = nameCollator(locale);
  return [...lines.entries()]
    .map(([volunteerId, own]): Recipient => ({
      volunteerId,
      name: names.get(volunteerId) ?? volunteerId,
      lines: mergeAdjacent(own),
    }))
    .sort(
      (a, b) =>
        collator.compare(a.name, b.name) ||
        (a.volunteerId < b.volunteerId ? -1 : 1),
    );
}

/**
 * One schedule line as the volunteer reads it, in the event's own timezone.
 *
 * The server writes the same line in `evp_domain::schedule::locale` when it
 * sends; `fixtures/schedule_render.json` holds the two to one output.
 */
export function formatLine(line: ScheduleLine): string {
  const options = {
    locale: locale.value,
    timeZone: eventTimeZone(line.timezone),
  };
  const day = formatDay(line.startMs, options);
  // The last millisecond, not the end instant: a shift ending at midnight
  // ended on the day it started, and "samedi 22:00 – dimanche 00:00" says a
  // night nobody worked.
  const endDay = formatDay(line.endMs - 1, options);
  const parts = {
    day,
    start: formatTime(line.startMs, options),
    end: formatTime(line.endMs, options),
    mission: line.mission,
  };
  return day === endDay
    ? t('emails.message.line', parts)
    : t('emails.message.lineAcrossDays', { ...parts, endDay });
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/** Every placeholder a template may use. `assignations` is HTML this module
 * builds; every other one is text, escaped on the way in. */
export const TEMPLATE_VARIABLES = [
  'firstName',
  'displayName',
  'eventName',
  'festivalName',
  'organizationName',
  'assignations',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** The values one recipient's message is filled with — already safe to drop
 * into HTML. */
export type TemplateValues = Readonly<Record<TemplateVariable, string>>;

function isVariable(name: string): name is TemplateVariable {
  return TEMPLATE_VARIABLES.some((known) => known === name);
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Text made safe to place in HTML.
 *
 * Names are volunteer data typed into a public form, and "<b>Zoé</b>" or an
 * `&` in a scene name is a real row, not an attack — either way it must arrive
 * as the characters they typed rather than as markup in someone's inbox.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * `{{a|b}}` is "a, or b where a is empty".
 *
 * That is what lets one template serve both scopes: `{{eventName|
 * festivalName}}` names the day on a one-day run and the festival on a
 * festival-wide one, where no single day's name is right.
 */
function alternativesOf(inner: string): readonly string[] {
  return inner.split('|').map((part) => part.trim());
}

export type TextPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'placeholder';
      readonly inner: string;
      readonly whole: string;
    };

/** Text cut at its placeholders, in order, by the same grammar the renderer
 * reads — so the editor finds exactly the placeholders that get filled. */
export function textParts(text: string): readonly TextPart[] {
  const parts: TextPart[] = [];
  let from = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match.index > from) {
      parts.push({ kind: 'text', text: text.slice(from, match.index) });
    }
    parts.push({ kind: 'placeholder', inner: match[1] ?? '', whole: match[0] });
    from = match.index + match[0].length;
  }
  if (from < text.length) {
    parts.push({ kind: 'text', text: text.slice(from) });
  }
  return parts;
}

/** Whether every alternative in a placeholder's inner text is one this page
 * fills: `eventName|festivalName` is, `firstname` is not. */
export function isKnownPlaceholder(inner: string): boolean {
  return alternativesOf(inner).every(isVariable);
}

/** Placeholders the template names that nothing fills. Reported rather than
 * silently emptied: `{{firstname}}` sent to four hundred people as the
 * literal braces is the typo this exists to catch before sending. */
export function unknownPlaceholders(template: string): readonly string[] {
  const unknown = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    for (const name of alternativesOf(match[1] ?? '')) {
      if (!isVariable(name)) {
        unknown.add(name);
      }
    }
  }
  return [...unknown];
}

/**
 * One recipient's message.
 *
 * An unknown placeholder is left exactly as written, so the preview shows the
 * mistake where it is rather than a gap nobody notices.
 */
export function renderTemplate(
  template: string,
  values: TemplateValues,
): string {
  return template.replace(PLACEHOLDER, (whole, inner: string) => {
    const names = alternativesOf(inner);
    if (!names.every(isVariable)) {
      return whole;
    }
    return (
      names.map((name) => values[name]).find((value) => value !== '') ?? ''
    );
  });
}

/**
 * A schedule as HTML: one list item per line, or a sentence saying there is
 * nothing — never an empty list, which reads as a rendering fault.
 *
 * `format` produces the translated line text; it is escaped here, so a
 * mission called "Bar & Snack" cannot close the list early.
 */
export function assignationsHtml(
  lines: readonly ScheduleLine[],
  format: (line: ScheduleLine) => string,
  none: string,
): string {
  if (lines.length === 0) {
    return `<p>${escapeHtml(none)}</p>`;
  }
  const items = lines.map((line) => `<li>${escapeHtml(format(line))}</li>`);
  return `<ul>${items.join('')}</ul>`;
}

const BLOCKS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'TR',
  'TABLE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
]);

/** Elements whose content is not text anybody reads. */
const SILENT = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE']);

/**
 * The message as a mail client without HTML would show it.
 *
 * Parsed with `DOMParser`, which builds an inert document — nothing in it
 * runs, loads or is attached to the page — and walked by hand because
 * `textContent` drops every line break a `<br>` or a `<div>` stood for.
 */
export function htmlToText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  let out = '';
  // A block starts on its own line, but two nested blocks do not make an
  // empty one between them — only `<br>` is a line break a person asked for.
  const breakLine = (): void => {
    if (out !== '' && !out.endsWith('\n')) {
      out += '\n';
    }
  };
  // A paragraph is set off by a blank line, as a mail client's margins set it
  // off on screen. The rich-text editor writes nothing else between
  // paragraphs (ADR-0046), so without this they would run together. One at
  // the very start is trimmed with the rest.
  const blankLine = (): void => {
    breakLine();
    if (!out.endsWith('\n\n')) {
      out += '\n';
    }
  };
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Source newlines are layout in HTML, not text; the tags carry them.
      out += (node.textContent ?? '').replace(/\s+/g, ' ');
      return;
    }
    if (!(node instanceof Element) || SILENT.has(node.tagName)) {
      return;
    }
    if (node.tagName === 'BR') {
      out += '\n';
      return;
    }
    const separate =
      node.tagName === 'P'
        ? blankLine
        : BLOCKS.has(node.tagName)
          ? breakLine
          : null;
    separate?.();
    if (node.tagName === 'LI') {
      out += '• ';
    }
    node.childNodes.forEach(walk);
    separate?.();
  };
  parsed.body.childNodes.forEach(walk);
  return out
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
