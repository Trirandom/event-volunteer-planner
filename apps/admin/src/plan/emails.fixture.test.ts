// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The admin half of `crates/evp-domain/fixtures/schedule_render.json`. The
 * server half is `crates/evp-domain/tests/schedule_fixture.rs`: the page
 * previews a message the server will send, and the two must not drift.
 */
import * as v from 'valibot';
import { afterAll, describe, expect, it } from 'vitest';

// `?raw`, not `node:fs`: under jsdom `import.meta.url` is not a file URL.
import fixtureJson from '../../../../crates/evp-domain/fixtures/schedule_render.json?raw';
import { i18n } from '../i18n';
import {
  assignationsHtml,
  escapeHtml,
  formatLine,
  groupsOf,
  htmlToText,
  renderTemplate,
  unknownPlaceholders,
} from './emails';
import { Temporal } from '@evp/shared/time';

const Fixture = v.object({
  lines: v.array(
    v.object({
      locale: v.picklist(['fr', 'en']),
      timezone: v.string(),
      event: v.string(),
      start: v.string(),
      end: v.string(),
      mission: v.string(),
      expected: v.string(),
    }),
  ),
  schedules: v.array(
    v.object({
      locale: v.picklist(['fr', 'en']),
      timezone: v.string(),
      lines: v.array(
        v.object({
          eventId: v.string(),
          event: v.string(),
          mission: v.string(),
          start: v.string(),
          end: v.string(),
        }),
      ),
      expected: v.string(),
    }),
  ),
  values: v.object({
    firstName: v.string(),
    displayName: v.string(),
    eventName: v.string(),
    festivalName: v.string(),
    organizationName: v.string(),
    assignations: v.string(),
  }),
  render: v.array(
    v.object({
      template: v.string(),
      expected: v.string(),
      unknown: v.array(v.string()),
    }),
  ),
  escape: v.array(v.object({ text: v.string(), expected: v.string() })),
  htmlToText: v.array(v.object({ html: v.string(), expected: v.string() })),
});

const fixture = v.parse(Fixture, JSON.parse(fixtureJson));

describe('the schedule fixture shared with the server', () => {
  afterAll(async () => {
    await i18n.setLocale('en');
  });

  it.each(fixture.lines)(
    'formats $locale $start in $timezone',
    async (line) => {
      await i18n.setLocale(line.locale);
      expect(
        formatLine({
          key: 'k',
          mission: line.mission,
          eventId: 'e',
          eventName: line.event,
          timezone: line.timezone,
          startMs: Temporal.Instant.from(line.start).epochMilliseconds,
          endMs: Temporal.Instant.from(line.end).epochMilliseconds,
        }),
      ).toBe(line.expected);
    },
  );

  it.each(fixture.schedules)(
    'groups a $locale schedule of $lines.length lines',
    async (schedule) => {
      await i18n.setLocale(schedule.locale);
      const lines = schedule.lines.map((line, index) => ({
        key: String(index),
        mission: line.mission,
        eventId: line.eventId,
        eventName: line.event,
        timezone: schedule.timezone,
        startMs: Temporal.Instant.from(line.start).epochMilliseconds,
        endMs: Temporal.Instant.from(line.end).epochMilliseconds,
      }));
      expect(assignationsHtml(groupsOf(lines), 'none')).toBe(schedule.expected);
    },
  );

  it.each(fixture.render)('renders $template', (render) => {
    expect(renderTemplate(render.template, fixture.values)).toBe(
      render.expected,
    );
    expect(unknownPlaceholders(render.template)).toEqual(render.unknown);
  });

  it.each(fixture.escape)('escapes $text', (escape) => {
    expect(escapeHtml(escape.text)).toBe(escape.expected);
  });

  it.each(fixture.htmlToText)('reads $html as text', (html) => {
    expect(htmlToText(html.html)).toBe(html.expected);
  });
});
