// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Who gets a schedule, what it lists, and whether the filled-in template can
 * be broken by what volunteers typed into the form.
 */
import { describe, expect, it } from 'vitest';

import type { Participation } from '../api/participations';
import {
  assignationsHtml,
  escapeHtml,
  htmlToText,
  mergeAdjacent,
  recipientsOf,
  renderTemplate,
  unknownPlaceholders,
  type ScheduleLine,
  type TemplateValues,
} from './emails';
import type { RosterRow, Seat, Slot } from './roster';

const HOUR = 3_600_000;

function person(
  volunteerId: string,
  name: string,
  status: Participation['status'] = 'confirmed',
): Participation {
  return {
    id: `p-${volunteerId}`,
    volunteer_id: volunteerId,
    display_name: name,
    status,
    availability: [],
  };
}

function slot(
  shiftId: string,
  eventId: string,
  startHour: number,
  endHour: number,
  holders: readonly Participation[],
): Slot {
  const seats = holders.map((holder, index): Seat => ({
    key: `${shiftId}:${String(index)}`,
    index,
    holder: {
      assignmentId: `a-${shiftId}-${holder.volunteer_id}`,
      participationId: holder.id,
      volunteerId: holder.volunteer_id,
      name: holder.display_name,
      version: 0,
    },
    extra: false,
  }));
  return {
    key: shiftId,
    shiftId,
    eventId,
    eventName: eventId === 'sat' ? 'Samedi' : 'Dimanche',
    timezone: 'Europe/Paris',
    color: 0,
    startMs: startHour * HOUR,
    endMs: endHour * HOUR,
    requiredCount: holders.length,
    maxCount: null,
    seats: [
      ...seats,
      {
        key: `${shiftId}:empty`,
        index: seats.length,
        holder: null,
        extra: true,
      },
    ],
    filled: holders.length,
    laneRow: 0,
    seatOffset: 0,
  };
}

function row(name: string, slots: readonly Slot[]): RosterRow {
  return {
    key: name,
    name,
    alsoAtDays: 0,
    slots,
    seatRows: 1,
    laneCount: 1,
  };
}

function line(
  mission: string,
  startHour: number,
  endHour: number,
  eventId = 'sat',
): ScheduleLine {
  return {
    key: `${mission}-${String(startHour)}-${eventId}`,
    mission,
    eventId,
    eventName: eventId,
    timezone: 'Europe/Paris',
    startMs: startHour * HOUR,
    endMs: endHour * HOUR,
  };
}

const CAMILLE = person('v-camille', 'Camille');
const EMILIE = person('v-emilie', 'Émilie');
const ZOE = person('v-zoe', 'Zoé');

describe('mergeAdjacent', () => {
  it('joins touching shifts at the same post into one line', () => {
    const merged = mergeAdjacent([line('Bar', 12, 14), line('Bar', 10, 12)]);
    expect(merged.map((l) => [l.startMs / HOUR, l.endMs / HOUR])).toEqual([
      [10, 14],
    ]);
  });

  it('keeps a break between two shifts, however short', () => {
    const lines = [
      line('Bar', 10, 12),
      { ...line('Bar', 12, 14), startMs: 12 * HOUR + 1 },
    ];
    expect(mergeAdjacent(lines)).toHaveLength(2);
  });

  it('keeps touching shifts at two different posts apart', () => {
    expect(
      mergeAdjacent([line('Bar', 10, 12), line('Entrée', 12, 14)]),
    ).toHaveLength(2);
  });

  it('keeps the same post on two different days apart', () => {
    expect(
      mergeAdjacent([line('Bar', 10, 12, 'sat'), line('Bar', 12, 14, 'sun')]),
    ).toHaveLength(2);
  });
});

describe('recipientsOf', () => {
  const participants = new Map([
    ['sat', [ZOE, CAMILLE, EMILIE, person('v-gone', 'Parti', 'withdrawn')]],
  ]);

  it('gives one recipient per enrolled volunteer, sorted by collation', () => {
    const recipients = recipientsOf(
      [row('Bar', [slot('s1', 'sat', 10, 12, [CAMILLE])])],
      participants,
      'fr',
    );
    // «Émilie» between «Camille» and «Zoé», not after «Zoé» by byte order.
    expect(recipients.map((r) => r.name)).toEqual(['Camille', 'Émilie', 'Zoé']);
  });

  it('keeps volunteers with no shift, with no lines', () => {
    const recipients = recipientsOf([], participants, 'fr');
    expect(recipients.every((r) => r.lines.length === 0)).toBe(true);
    expect(recipients).toHaveLength(3);
  });

  it('writes to nobody who declined or withdrew', () => {
    const recipients = recipientsOf([], participants, 'fr');
    expect(recipients.map((r) => r.volunteerId)).not.toContain('v-gone');
  });

  it('lists one volunteer’s shifts across days and posts in time order', () => {
    const sunday = { ...CAMILLE, id: 'p-camille-sun' };
    const recipients = recipientsOf(
      [
        row('Bar', [
          slot('s2', 'sun', 30, 32, [sunday]),
          slot('s1', 'sat', 10, 12, [CAMILLE]),
        ]),
        row('Entrée', [slot('s3', 'sat', 14, 16, [CAMILLE, ZOE])]),
      ],
      new Map([
        ['sat', [CAMILLE, ZOE]],
        ['sun', [sunday]],
      ]),
      'fr',
    );
    const camille = recipients.find((r) => r.volunteerId === 'v-camille');
    expect(camille?.lines.map((l) => [l.mission, l.eventId])).toEqual([
      ['Bar', 'sat'],
      ['Entrée', 'sat'],
      ['Bar', 'sun'],
    ]);
    expect(
      recipients.filter((r) => r.volunteerId === 'v-camille'),
    ).toHaveLength(1);
  });
});

describe('renderTemplate', () => {
  const values: TemplateValues = {
    firstName: 'Camille',
    displayName: 'Camille',
    eventName: '',
    festivalName: 'Soundclash 26',
    organizationName: 'Asso',
    assignations: '<ul><li>Bar</li></ul>',
  };

  it('fills each placeholder, tolerating spaces inside the braces', () => {
    expect(
      renderTemplate('Bonjour {{ firstName }} — {{organizationName}}', values),
    ).toBe('Bonjour Camille — Asso');
  });

  it('falls back through `|` to the first non-empty value', () => {
    expect(renderTemplate('{{eventName|festivalName}}', values)).toBe(
      'Soundclash 26',
    );
    expect(
      renderTemplate('{{eventName|festivalName}}', {
        ...values,
        eventName: 'Samedi',
      }),
    ).toBe('Samedi');
  });

  it('leaves an unknown placeholder exactly as written', () => {
    expect(renderTemplate('Salut {{firstname}}', values)).toBe(
      'Salut {{firstname}}',
    );
  });

  it('inserts the schedule as HTML, not as escaped text', () => {
    expect(renderTemplate('{{assignations}}', values)).toBe(
      '<ul><li>Bar</li></ul>',
    );
  });
});

describe('unknownPlaceholders', () => {
  it('names each unknown placeholder once, including inside a fallback', () => {
    expect(
      unknownPlaceholders('{{firstname}} {{eventName|festival}} {{firstname}}'),
    ).toEqual(['firstname', 'festival']);
  });

  it('is empty for the known ones', () => {
    expect(
      unknownPlaceholders('{{firstName}} {{eventName|festivalName}}'),
    ).toEqual([]);
  });
});

describe('escaping volunteer data', () => {
  it('escapes markup characters in a name', () => {
    expect(escapeHtml(`<b>Zoé</b> & "Léa" l'ami`)).toBe(
      '&lt;b&gt;Zoé&lt;/b&gt; &amp; &quot;Léa&quot; l&#39;ami',
    );
  });

  it('escapes each schedule line, so a mission name cannot close the list', () => {
    expect(
      assignationsHtml([line('Bar & </ul>', 10, 12)], (l) => l.mission, 'Rien'),
    ).toBe('<ul><li>Bar &amp; &lt;/ul&gt;</li></ul>');
  });

  it('says so in words when there is nothing to list', () => {
    expect(assignationsHtml([], (l) => l.mission, 'Aucun créneau')).toBe(
      '<p>Aucun créneau</p>',
    );
  });
});

describe('htmlToText', () => {
  it('keeps the line breaks the markup stood for', () => {
    expect(
      htmlToText(
        '<div>Bonjour Camille,<br>\n<br>Voici :<ul><li>Bar</li><li>Entrée</li></ul>À bientôt</div>',
      ),
    ).toBe('Bonjour Camille,\n\nVoici :\n• Bar\n• Entrée\nÀ bientôt');
  });

  it('never runs what it parses', () => {
    expect(
      htmlToText('<img src=x onerror="throw 1">ok<script>throw 1</script>'),
    ).toBe('ok');
  });
});
