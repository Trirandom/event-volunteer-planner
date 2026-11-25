# ADR-0055 — A volunteer's schedule is grouped under its event and the night it belongs to

**Status:** Accepted · **Date:** 2026-11-25
**Amends:** docs/01 S10

## Context

The schedule email (`{{assignations}}`, ADR-0046/0054) printed one line per
merged shift, each naming its own calendar day:

```
samedi 5 septembre, 10:00–14:00 : Montage
samedi 5 septembre, 14:00–16:00 : Bar
samedi 5 septembre, 22:00 – dimanche 6 septembre, 01:00 : Démontage
```

Two things were wrong with it in the first real run (Soundclash 26):

1. The day is repeated on every line. Five shifts on one Saturday is five
   copies of "samedi 5 septembre", and the hours, which are what a volunteer
   is looking for, sit in the middle of each line.
2. A calendar day is not how anyone at a party thinks about the night. "Open
   Air" runs from 10:00 on Saturday to 01:00 on Sunday. A shift at 00:30 is
   "Saturday night" to everyone involved. Printing "dimanche 6 septembre"
   on it is exactly what sends someone to the site a day late. The name the
   coordinators gave the event ("Open Air") is what the volunteers know
   it by, and what the posters say.

## Decision

The schedule is a list of **groups**, each under a heading, each holding the
lines of one event on one *event day*:

```
Open Air – samedi 05/09
• 10:00–14:00 : Montage
• 14:00–16:00 : Bar
• 22:00–01:00 : Démontage
```

- **Heading:** the event's name, then the weekday and `dd/mm` of the event
  day (`Saturday 09/05` in English, which reads month first as its `en-US`
  times do). The year is in the subject and the festival already.
- **Event day:** the local date, in the event's time zone, on which the shift
  starts. A shift that starts **before 06:00** counts toward the day before.
  06:00 is the default of `events.night_ends_at`, the night window the soft
  warnings already use (ADR-0007). That column is not exposed by the API, and
  no screen edits it, so every event has 06:00 today. A fixed value
  reproduces the column exactly, and avoids an API field nobody can set yet.
- **Lines** inside a group carry only times and the mission. A shift lapping
  midnight is `22:00–01:00`: the heading already says which night it is, and
  naming the next day on the line is the confusion this ADR removes.
- **Order:** groups in the order of their first shift, and lines
  chronologically within a group. Two events on the same night are two
  groups.
- **Changes** (`{{changes}}`) stay a flat list, because each item stands
  alone. Each item is prefixed with its group heading:
  `Ajouté : Open Air – samedi 05/09, 22:00–01:00 : Démontage`.
- A line now carries its event's name. Like the mission, that is the name the
  volunteer read, so a snapshot keeps it. The digest still covers where and
  when only, so renaming an event re-sends nothing.

The server (`evp_domain::schedule`) and the admin preview
(`apps/admin/src/plan/emails.ts`) both implement this. As before,
`fixtures/schedule_render.json` holds the two to one output.

## Alternatives considered

- **Group by calendar day** ("samedi 5 septembre :" then the lines). This
  fixes the repetition but not the night. The 00:30 shift moves under a
  "dimanche" heading of its own, which is worse than today because it now
  looks like a separate day of work.
- **The heading date is always the event's start date.** This is right for a
  single night, but wrong for a three-day camping event, where the whole
  weekend would sit under Friday.
- **Read `events.night_ends_at` per event.** This would be more faithful once
  a coordinator can change it. It is left until the API exposes the column
  and a screen edits it. At that point the constant becomes the column, and
  the rule stays the same.
- **Keep the long date in the heading** (`samedi 5 septembre`). The user
  preferred `samedi 05/09`, because it is shorter and still unambiguous with
  the weekday.

## Consequences

- An event that starts between midnight and 06:00 heads its first early
  shifts with the previous day. No event in the worked example or in
  Soundclash does this, and the constant is where to change it if one does.
- `ScheduleLine` gains the event name on both sides. Nothing writes
  `schedule_snapshots` yet (publishing is not built), so no stored payload
  needs migrating.
