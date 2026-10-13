# 16 — Internationalisation and time

Time handling in a scheduling application is not a formatting concern, it is a
correctness concern: an hour's error puts a volunteer at the wrong place, and
the bug surfaces twice a year on a Sunday morning. This document is the single
coherent strategy ([ADR-0019](adr/0019-time-discipline.md)).

## 1. Three independent axes

Most timezone bugs come from treating these as one thing. They are not, and
nothing in this codebase may assume they agree:

| Axis | Source | Example |
| --- | --- | --- |
| **Language** | The viewer's preference | `fr` |
| **Locale** | Formatting conventions | `fr-FR` → `04/07/2026`, `en-GB` → `04/07/2026`, `en-US` → `07/04/2026` |
| **Timezone** | **The event**, not the viewer | `Indian/Reunion` |

A coordinator in Paris planning a festival on Réunion sees Réunion times in
French. A British volunteer at the same event sees Réunion times in English.
**Nobody ever sees times in their own browser's timezone.** That single rule
prevents the entire class of "the schedule says 18:00 but the shift is at
20:00".

## 2. Storage

### The invariant

> **The database stores instants. The server's timezone is irrelevant and must
> never affect a result.**

Achieved with four rules:

1. **`timestamptz` everywhere.** Never `timestamp without time zone`. A
   `timestamptz` is an unambiguous instant; a bare `timestamp` is a string that
   looks like a time and means nothing without out-of-band context.
2. **`SET TIME ZONE 'UTC'` on every pooled connection**, in the after-connect
   hook. `timestamptz` values are stored as instants regardless, so this does
   not change what is stored — it makes text rendering, `now()` output and log
   lines deterministic instead of dependent on the container's `/etc/localtime`.
   A deployment moved between hosts must not read differently.
3. **Always send an explicit offset.** The application never sends a naive
   literal like `'2026-07-04 18:00'`, because PostgreSQL would interpret it in
   the session timezone. Parameters are bound as typed values, not formatted
   strings — which SQLx does anyway, so this is a rule about never
   hand-assembling SQL.
4. **`tstzrange` for periods**, never a pair of loose columns. Half-open
   `[start, end)`, so touching shifts do not overlap.

`DATE` is used only where there is genuinely no time component and no timezone
question: `valid_from` / `valid_until` on a skill. A date is not a timestamp
with the time removed.

### The event's timezone

Each event stores an IANA name, foreign-keyed to a `timezones` table snapshotted
from `pg_timezone_names`, because a `CHECK` cannot validate it
([03 §3.4](03-data-model.md#34-events-locations-shifts)).

This is stored, not derived, and it is the authority for every display and every
"which day is this" decision for that event.

## 3. Instant versus wall-clock

The distinction that causes the remaining bugs once storage is right.

| Concept | Is | Used for |
| --- | --- | --- |
| **Instant** | A point on the timeline | Everything stored. "This shift starts at `2026-07-04T16:00:00Z`" |
| **Wall-clock** | A calendar date and clock reading, with no offset | Human intent. "08:00 on the 4th" |
| **Zoned** | Wall-clock + IANA zone, resolvable to an instant | The bridge |

**Store instants. Derive wall-clock for display. Operate in wall-clock for
patterns.** Concretely:

- **Event duplication** rebases in *wall-clock*: an 08:00 shift stays 08:00 next
  year, even if the copy lands on the other side of a DST transition. Copying
  instants and adding a fixed interval shifts it by an hour — a bug the naive
  implementation will have, so it is called out in
  [04](04-api.md#events-locations-shifts) and again here.
- **Bulk shift creation** ("every day 08:00–12:00 from the 4th to the 7th")
  generates wall-clock times per day, then resolves each to an instant. Not
  `start + n × 24h`.
- **Shift-pattern generation** walks its segments in wall-clock too — the
  *artiste* division is "09:00, then 45 minutes, then 45, then 90…", advanced on
  the local calendar and resolved at the end
  ([ADR-0029](adr/0029-shift-patterns-are-generators-not-constraints.md)). Walking
  it in instants produces slots that drift an hour on a transition day, and
  produces them silently, because every individual duration is still correct.
- **"Hours per day" and "consecutive days"** bucket by calendar day *in the
  event's timezone*. A shift spanning 22:00–02:00 is apportioned across two
  local days ([05 §5](05-scheduling-rules.md#5-timezones-and-days)).

**Never do calendar arithmetic on an instant.** "Add one day" is not "add 86 400
seconds" on 39 days of the year in the average zone.

### DST edge cases that must be handled, not discovered

Both are resolvable only against a real tzdb, which is why the library choice
below matters:

- **Spring forward** — 02:30 on the transition date does not exist. A shift
  entered there must be rejected with an explanation, not silently shifted.
- **Fall back** — 02:30 occurs twice. A shift entered there is ambiguous and is
  **rejected at the field**, naming both candidate instants so the person can
  choose one explicitly. Neither silently guessing nor silently taking the first
  occurrence is acceptable: the whole point of the input rules in §5 is that an
  ambiguous time is never coerced, and an hour's error puts a volunteer at the
  wrong post.
- A local day is 23 or 25 hours long on those dates, and the daily-hours cap
  must see the real length.

## 4. Libraries

**Rust: `jiff`.** Its `Zoned` type carries an instant *and* a zone, so
timezone-aware arithmetic is correct by default and DST gaps and folds are
explicit in the API rather than silently resolved. `chrono` + `chrono-tz` is the
conservative alternative and works, but makes the wall-clock/instant distinction
the developer's responsibility on every call. `time` alone is not adequate here
— it has no tzdb.

`jiff` is newer than the alternatives; that is a real risk and worth stating.
It is accepted because this application's core value is time arithmetic being
right, and a library whose types make the distinction unignorable is worth more
than one with a longer history.

**Frontend: `Temporal`**, with the polyfill until it is Baseline Widely
Available. `Temporal.ZonedDateTime` and `PlainDateTime` mirror the distinction
above.

**`Date` is banned** except as a transport for an instant. It has no timezone —
only UTC and "whatever the browser is set to" — so any date arithmetic through
it silently uses the viewer's zone, which is precisely the one zone this
application must never use.

## 5. Datetime input

The specific trap, since you asked about inputs.

**`<input type="datetime-local">` yields a naive wall-clock string** —
`"2026-07-04T08:00"` — with no offset. That is exactly the right shape for
entering a time in the event's timezone, and exactly the wrong thing to hand to
`new Date()`, which interprets it in the *browser's* zone.

```
// WRONG — reinterprets 08:00 Réunion as 08:00 Paris
const when = new Date(input.value);

// RIGHT — the string is wall-clock; the event supplies the zone
const when = Temporal.PlainDateTime
  .from(input.value)
  .toZonedDateTime(event.timeZone)
  .toInstant();
```

Rules for every time control:

- Every field displaying or accepting a time is **labelled with the timezone**,
  visibly — "08:00 (heure de La Réunion)". Not a tooltip.
- Inputs are constrained to the event period via `min` / `max`, and revalidated
  server-side.
- The availability picker works entirely in event wall-clock and converts once
  on submit ([09 §3](09-volunteer-form.md#3-the-availability-picker)).
- A time that does not exist or is ambiguous is rejected at the field with the
  reason, not coerced.
- Where the viewer's zone differs from the event's, the UI says so once,
  prominently — a coordinator travelling should not have to deduce it.

## 6. Localisation

### Catalogues

- `fr` and `en`, with `fr` as fallback and the default.
- **ICU MessageFormat** for anything with a count or a variable. Not string
  concatenation, ever: word order differs between languages and a sentence
  assembled from fragments is untranslatable.
- French pluralisation is not English pluralisation: **`0` is singular in
  French** — «0 bénévole», "0 volunteers". Hand-rolled `n > 1 ? 's' : ''` gets
  this wrong; ICU plural categories get it right.
- Keys are semantic (`planner.assign.refused.doubleBooked`), never the English
  text.
- No translated string is ever parsed or compared. Logic branches on codes.
- A missing key fails `vue-tsc` and `pnpm test`; missing translation in a non-default locale is
  a warning with fallback.

### Implementation

[ADR-0038](adr/0038-vue-i18n-with-icu-messageformat.md): vue-i18n holds the
locale, FormatJS renders ICU, and `@evp/shared/i18n` types every key against
the French catalogue. In practice:

- Strings live in `apps/<app>/src/i18n/{fr,en}/<area>.ts`, one file per area of
  the application, and are read through the app's `t`:
  `import { t } from '../i18n'`, then `t('missions.card.title')` in a template,
  a `computed` or a plain module. A key that does not exist does not compile.
- `en/<area>.ts` is declared `satisfies typeof fr`. That makes a missing or
  extra English key a type error. In practice, for the two languages shipped
  today, the "warning with fallback" above only arises at runtime from a
  catalogue that failed to load.
- Never call `t` at module top level: a constant filled at import time keeps
  the language it was imported in. Store the key and translate at call time.
- A time or date is formatted by `@evp/shared/intl`, in the event's zone, and
  passed to the message as a string. `{when, date}` fails the catalogue audit.
- The volunteer form reads `?lang=`, then the browser, then French (docs/09 §7).
  The coordinator application uses the header switcher's choice on this
  device, then the account's `locale`, then the browser, then French.
  Formatting follows the same language.
- The shared components' strings are in `packages/shared/src/i18n/messages.ts`
  and are mounted under `shared.*` by both applications.

### Inclusive French

The prior system wrote «Présent•e»
([10](10-prior-art-spreadsheet.md)), so the association already uses inclusive
forms. The `fr` catalogue follows that convention with the middle dot `·`
(U+00B7), consistently.

One caveat worth recording: middle-dot forms are read poorly by some screen
readers. Where a phrase can be written inclusively *without* the dot — «Bonjour
et bienvenue», a role noun rather than a gendered adjective — that is preferred,
and the dot is a fallback rather than the default. This is a real tension
between two kinds of inclusion, and the resolution is to prefer wording that
needs neither.

### Formatting

- Dates, times and numbers via `Intl` — locale from the viewer, **timezone from
  the event**. Never `toLocaleString()` with no explicit `timeZone`.
- Server-rendered output (emails, SMS, PDF) formats with the recipient's locale
  and the event's timezone. `volunteers.locale` is added for this, defaulting to
  the organisation's.
- **Name sorting uses `Intl.Collator`** for the locale, and an ICU collation in
  PostgreSQL — not byte order, which puts «Émilie» after «Zoé».
- Addresses, phone numbers and postcodes are stored as given and never
  reformatted.
- SMS transliterates to GSM-7 for cost, which strips French accents. That is
  acceptable for a schedule and would not be for a name in a legal document —
  the tradeoff is deliberate ([10 §4](10-prior-art-spreadsheet.md#newly-adopted)).

### Translated content in the database

Form question labels, help text and option labels are `jsonb` keyed by locale
([03 §3.11](03-data-model.md#311-the-first-party-form)). Publishing a form
version validates that every locale the form declares has every key.

Volunteer-supplied free text is stored as written and never machine-translated.

## 7. Enforcement

Status as in [11 §7](11-engineering-standards.md#7-enforcement-summary).

| Rule | Gate | Stage | Status |
| --- | --- | --- | --- |
| No `timestamp without time zone` | Schema assertion over `information_schema` | test | planned |
| Session timezone is UTC | Connection-hook test asserting `SHOW TimeZone` | test | partial — every pooled connection runs `SET TIME ZONE 'UTC'`; the assertion is planned |
| The process timezone is **not** pinned | The suite sets no `TZ` of its own, so the hostile run below actually exercises something. Tests that care about a zone name it explicitly ([13 §8](13-testing-and-tdd.md#8-determinism-and-the-flaky-test-policy)) | test | enforced |
| **Suite passes under a hostile server timezone** | `just test-tz` runs the whole suite a second time with `TZ=Pacific/Chatham` (+12:45, with DST) | test | partial — `just test-tz`, Rust suite only, run by hand |
| DST correctness | Named tests: duplication across a transition, a 23-hour day, a nonexistent local time, an ambiguous one | test | partial — generator tests for a nonexistent local time and a spring-forward window; duplication is not built |
| No `Date` arithmetic | ESLint `no-restricted-globals` / `no-restricted-syntax` on `Date` methods | check | enforced (`pnpm lint`) |
| No `toLocaleString` without `timeZone` | ESLint rule | check | enforced (`pnpm lint`) |
| No `now()` in business logic | Injected `Clock`; review | check | enforced by review |
| Catalogue completeness | Keys typed against `fr` and `en` declared `satisfies typeof fr` (`vue-tsc`); `auditCatalogues` re-checks parity and that every translation takes the same arguments (`i18n/catalogue.test.ts`) | check / test | enforced |
| No string concatenation for messages | Every message parsed as ICU by `auditCatalogues` | test | enforced |
| No untranslated UI text | `vue/no-bare-strings-in-template` over every `.vue` file | check | enforced (`pnpm lint`) |
| No ICU `date`/`time` in messages (viewer's zone) | `auditCatalogues` | test | enforced |

The `TZ=Pacific/Chatham` run is the one that matters most. A +12:45 offset with
its own DST rules breaks every implicit assumption that the server is in Europe,
and it costs one extra run of the suite to prove that the server's timezone is genuinely
irrelevant — which is the invariant in §2 and cannot be verified by inspection.
