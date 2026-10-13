// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The add-a-day draft.
 *
 * Test-first, because two of the three things this module does are the kinds
 * of thing docs/13 §2 names outright: it converts a wall-clock reading in the
 * event's zone into an instant, and it decides what a `POST` body contains.
 * The third — the slug following the name until it does not — is here because
 * it is a rule about two fields that is easy to half-implement and impossible
 * to see going wrong.
 */
import { describe, expect, it } from 'vitest';

import {
  emptyNewEventDraft,
  newEventInput,
  newEventProblem,
  slugify,
  withName,
  withSlug,
  type NewEventDraft,
} from './newEventDraft';

/** A complete, sendable draft, for tests that break one thing about it. */
function draft(overrides: Partial<NewEventDraft> = {}): NewEventDraft {
  return {
    ...emptyNewEventDraft('Europe/Paris'),
    name: 'Samedi',
    slug: 'samedi',
    start: '2026-08-01T10:00',
    end: '2026-08-02T04:00',
    ...overrides,
  };
}

describe('slugify', () => {
  it('folds accents rather than dropping the letter', () => {
    expect(slugify('Samedi 1er août')).toBe('samedi-1er-aout');
  });

  it('collapses everything that is not a letter or digit', () => {
    expect(slugify('Dub & 2step — nuit')).toBe('dub-2step-nuit');
  });

  it('leaves no leading or trailing hyphen', () => {
    expect(slugify('  ¡Fiesta!  ')).toBe('fiesta');
  });

  /** A name with nothing sluggable in it is not silently turned into `-` or
   * into something invented; it is empty, which `newEventProblem` refuses. */
  it('is empty when there is nothing to slug', () => {
    expect(slugify('———')).toBe('');
  });
});

describe('the slug following the name', () => {
  it('follows until the slug is edited', () => {
    const typed = withName(emptyNewEventDraft('Europe/Paris'), 'Open Air');

    expect(typed.slug).toBe('open-air');
  });

  it('stops following once the slug is typed in', () => {
    const edited = withSlug(
      withName(emptyNewEventDraft('Europe/Paris'), 'Open Air'),
      'oa-26',
    );
    const renamed = withName(edited, 'Open Air 2026');

    expect(renamed.slug).toBe('oa-26');
  });

  /** Clearing an edited slug is a request for an empty slug — and therefore
   * for `slug-missing` — not a request to hand the field back to the name. */
  it('does not take an emptied slug back over', () => {
    const cleared = withSlug(withName(draft(), 'Open Air'), '');

    expect(withName(cleared, 'Open Air 2026').slug).toBe('');
  });
});

describe('newEventProblem', () => {
  it('passes a complete draft', () => {
    expect(newEventProblem(draft(), [])).toBeNull();
  });

  it('wants a name', () => {
    expect(newEventProblem(draft({ name: '   ' }), [])).toBe('name-missing');
  });

  it('wants a slug', () => {
    expect(newEventProblem(draft({ slug: '' }), [])).toBe('slug-missing');
  });

  /** `slug` is `citext`, so the clash the server would report is
   * case-insensitive and the one reported here has to be too. */
  it('refuses a slug the production already uses, whatever its case', () => {
    expect(newEventProblem(draft({ slug: 'Samedi' }), ['samedi'])).toBe(
      'slug-taken',
    );
  });

  it('allows a slug no day in scope is using', () => {
    expect(newEventProblem(draft(), ['dimanche'])).toBeNull();
  });

  it('refuses a zone no clock knows', () => {
    expect(newEventProblem(draft({ timezone: 'Europe/Paaris' }), [])).toBe(
      'timezone-unknown',
    );
  });

  it('wants both ends of the period', () => {
    expect(newEventProblem(draft({ start: '' }), [])).toBe('start-missing');
    expect(newEventProblem(draft({ end: '' }), [])).toBe('end-missing');
  });

  it('refuses a period that ends before it starts', () => {
    expect(
      newEventProblem(
        draft({ start: '2026-08-01T10:00', end: '2026-08-01T09:00' }),
        [],
      ),
    ).toBe('period-inverted');
  });

  /** An empty range is what `events_period_valid` refuses, and the same
   * boundary the editing form's `period-inverted` covers. */
  it('refuses a period of zero length', () => {
    expect(
      newEventProblem(
        draft({ start: '2026-08-01T10:00', end: '2026-08-01T10:00' }),
        [],
      ),
    ).toBe('period-inverted');
  });

  /**
   * A club night is the normal case, not an edge one: 22:00 to 05:00 the next
   * morning is one day of the festival, and a draft that refused it would
   * have the bug `format/period.ts` exists to avoid.
   */
  it('accepts a night that ends the next morning', () => {
    expect(
      newEventProblem(
        draft({ start: '2026-08-01T22:00', end: '2026-08-02T05:00' }),
        [],
      ),
    ).toBeNull();
  });
});

describe('newEventInput', () => {
  /**
   * The conversion this module exists for. 10:00 in Paris on 1 August is
   * 08:00Z — the browser's own zone never appears in the answer, and neither
   * does a fixed +01:00 that would be an hour out in summer.
   */
  it('sends wall-clock readings as instants in the event zone', () => {
    const input = newEventInput(draft(), null);

    expect(input?.period).toEqual({
      start: '2026-08-01T08:00:00Z',
      end: '2026-08-02T02:00:00Z',
    });
  });

  /** Winter, where Paris is +01:00 rather than +02:00. The same wall-clock
   * text is a different instant, which is the whole reason the zone travels
   * with the reading. */
  it('reads the same clock differently across the DST boundary', () => {
    const input = newEventInput(
      draft({ start: '2026-12-01T10:00', end: '2026-12-01T18:00' }),
      null,
    );

    expect(input?.period.start).toBe('2026-12-01T09:00:00Z');
  });

  it('attaches the festival the page is under', () => {
    expect(newEventInput(draft(), 'festival-1')?.festivalId).toBe('festival-1');
  });

  /** Omitted rather than `undefined`: the server reads a standalone event as
   * the absent key (`api/events.ts`). */
  it('omits the festival entirely for a standalone event', () => {
    const input = newEventInput(draft(), null);

    expect(input === null ? [] : Object.keys(input)).not.toContain(
      'festivalId',
    );
  });

  it('trims and lowercases what goes in the URL', () => {
    const input = newEventInput(
      draft({ name: '  Samedi  ', slug: '  Samedi-1  ' }),
      null,
    );

    expect(input?.name).toBe('Samedi');
    expect(input?.slug).toBe('samedi-1');
  });

  it('sends nothing for a draft that is not sendable', () => {
    expect(newEventInput(draft({ end: '' }), null)).toBeNull();
  });
});
