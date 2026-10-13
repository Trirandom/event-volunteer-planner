# 09 — The volunteer form

The first-party form volunteers fill in. Primary intake channel
([ADR-0010](adr/0010-first-party-form-as-primary-intake.md)); volunteers still
have no accounts ([ADR-0008](adr/0008-no-volunteer-authentication-in-v1.md)).

The reason it exists rather than a Google Form: **no general-purpose form tool
can ask for a time range.** Everything else here follows from having decided to
render our own questions anyway.

The previous form is the evidence. It asked availability **five separate
times** — once for montage/démontage, once for the Open Air, once per evening,
once for the Afterclash — because a single checkbox list covering the whole
festival would have been unusable. Each answer was a label like
`"Samedi 5 sept. - Open Air 10h/14h"`. Five questions, and still nobody could
say "14h–19h30". See [10 — Prior art](10-prior-art-spreadsheet.md).

## 1. Scope

**Eleven question types**, no branching, two locales. That is the whole
builder. `section` is a twelfth value in `form_question_kind` and is not one of
the eleven: it is layout, it takes no answer, and it feeds nothing. The
eleventh, `missions`, was added by
[ADR-0036](adr/0036-missions-question.md); documents written before it count
ten and mean the same set without it.

A form covers a **festival**, a standalone **event**, or neither
([ADR-0035](adr/0035-a-form-can-cover-a-festival.md)). A festival form asks
once about every event of the production — which is what the Soundclash form
needed five questions for.

| Type | Used for | Notes |
| --- | --- | --- |
| `short_text` | First name, last name | Two separate questions. The first-name one is worded "what should we call you", so a scene name lands there and becomes the greeting. Last name is optional — mononyms are real — but asked, because it is what tells two Camilles apart ([ADR-0012](adr/0012-name-parts-asked-not-parsed.md)). |
| `email` | Contact, and identity on the public route | Validated, normalised |
| `phone` | Contact | Loose validation — international formats, no false rejections |
| `date` | An arrival date, say | Generic. No longer used for a birthdate — that is not collected ([ADR-0022](adr/0022-no-birthdate-collected.md)) |
| `single_choice` | T-shirt size, meal plan | Renders as radio group or select by option count |
| `multi_choice` | Skills | Each option carries an optional `skill_id` |
| `boolean` | "I have a driving licence"; «J'ai 18 ans ou plus» → `participation.is_adult` | **A required boolean renders as an explicit two-option group, never a lone checkbox.** An unticked box cannot be distinguished from an unanswered one, which would silently disarm any rule reading it — see below |
| `long_text` | Dietary needs, free remarks | |
| `availability` | **The reason for this document.** §3 | One control covering every day of every event in scope, grouped by event, replacing the five separate questions the old form needed. At most one per form. |
| `missions` | «Postes possibles» | The scope's missions, folded by name, each ticked *possible* or not. Options frozen at publish; answers become `participation_missions` rows. Information for assigning, never a constraint. At most one per form ([ADR-0036](adr/0036-missions-question.md)) |
| `consent` | Privacy-notice acknowledgement. Two purposes, declared per question ([ADR-0025](adr/0025-two-consents-processing-and-pool-retention.md)) | **`processing`** — handling these answers to staff this event, and contacting the volunteer about it by email and SMS. Required, exactly one per published version, never pre-ticked, records the notice version. **`pool_retention`** — keeping the record for future events. Optional, at most one, and the schema *refuses* to let it be marked required, because refusing it must not prevent volunteering ([15 §4](15-privacy-and-retention.md#4-consent)). **`commitment`** — not a privacy consent but a declaration on the same control: the volunteer confirms they take part unpaid, on the organisation's behalf, within the missions entrusted to them. Required, exactly one per published version, worded with the organisation's name ([ADR-0040](adr/0040-volunteer-commitment-question.md)) |
| `section` | Headings and explanatory copy | Not a question; no answer |

### Built-in and custom questions

A question is **built-in** when its answer has a destination the planner
understands: a `target_path` naming a volunteer column, or a kind with its own
table (`availability`, `missions`, `consent`). Everything else is a **custom**
question — no `target_path` — and its answer is kept in
`participation_answers`, pinned to the question, for as long as the event's
data is kept ([ADR-0037](adr/0037-custom-answers-are-kept-per-participation.md)).

| Built-in | Target | Required |
| --- | --- | --- |
| First name ("what should we call you") | `volunteer.first_name` | **Always** |
| Last name | `volunteer.last_name` | Optional by default; the coordinator may require it |
| Email | `volunteer.email` | **Always** — the public route reconciles on it |
| Phone | `volunteer.phone` | Coordinator's choice |
| T-shirt size | `volunteer.tshirt_size` | Coordinator's choice (`single_choice`, fixed sizes) |
| Dietary requirements | `volunteer.dietary` | Coordinator's choice; always sensitive |
| Remarks | `volunteer.notes` | Coordinator's choice |
| Availability, missions | own tables | Coordinator's choice |
| Processing consent | the submission | **Always** |
| Volunteer commitment | the submission | **Always** ([ADR-0040](adr/0040-volunteer-commitment-question.md)) |
| Pool-retention consent | `volunteers.pool_consent_*` | **Never** |

New forms start with first name, last name, email, phone, availability,
missions, the volunteer commitment and the processing consent; the editor offers the rest from a palette.
Custom questions — the fly team, experience level, the info meeting, the
WhatsApp group — are any of `short_text`, `long_text`, `single_choice`,
`multi_choice`, `boolean` or `date`, may be marked **sensitive**, and are
filterable on the submissions page.

**Explicitly not in v1:** conditional logic, page breaks, file upload, payment,
computed fields, question-level permissions, arbitrary regex validation. Each
is how a form builder becomes a product of its own. If branching is genuinely
needed later, the honest answer is a second form and a second link.

### The age question

«J'ai 18 ans ou plus» is an ordinary `boolean` question, but it is the one whose
presence changes what the planner enforces, so it is worth stating separately.

- Mapped to `participation.is_adult`, it arms the `minor_night_shift` soft rule
  ([05 §3](05-scheduling-rules.md#on-minor_night_shift)). Leave the question out
  and the rule is inert — and says so, rather than appearing to work.
- **Mark it required.** An optional age question yields `NULL` for whoever
  skipped it, and `NULL` does not warn. Required is what makes the safeguard
  cover everyone.
- It must therefore be answerable as *no*: two radio buttons in a labelled
  group, «Oui» / «Non», neither preselected. A checkbox is a consent control,
  not a question — see [14 §5](14-accessibility-and-interaction.md#5-the-volunteer-form)
  for the group-labelling requirement.
- No birthdate is asked, here or anywhere
  ([ADR-0022](adr/0022-no-birthdate-collected.md)). The form asks the question
  the schedule needs answered and stores that answer
  ([ADR-0023](adr/0023-adult-declaration-boolean.md)).

### Why the name is two questions

Asking `first_name` and `last_name` separately is the whole reason the parts
are trustworthy. Nothing splits a combined field — that was shown to be wrong
for a majority of the real pool
([10 §4](10-prior-art-spreadsheet.md#reversed-names-are-not-first--last)) — so
the parts exist only where a volunteer actually supplied them.

It buys three things: a greeting that reads correctly ("Bonjour Camille", not
"Bonjour MARCHAND Aurel"), a surname to disambiguate the candidate panel, and a
corroborating field that makes fuzzy identity matching land more often
([08 §6](08-volunteer-intake.md#6-identity-reconciliation)).

`display_name` is still stored verbatim, defaulting to the two parts joined,
because a scene name or a four-token name has to survive intact.

## 2. Versioning replaces drift detection

Every published form is an immutable **version**. Editing a live form creates a
new version; existing submissions stay attached to the version they answered.

This is the part that makes owning the form worth it beyond the picker. The
external-source problem — a coordinator inserts a question and the next import
writes phone numbers into `notes`
([08 §7](08-volunteer-intake.md#7-schema-drift)) — does not have a safe
solution, only detection. Here it does not arise:

- A submission records `form_version_id`. Its answers are interpreted against
  that version's questions, forever.
- Adding, removing or reordering questions cannot retroactively change what an
  earlier answer meant.
- Removing a question does not destroy answers already given to it. They stay
  in the submission's payload, viewable against their own version, for as long
  as that payload is retained — 30 days by default, after which
  `submissions.raw_keys` still records that the question was answered
  ([03 §3.10](03-data-model.md#310-intake)). Deleting a question is never what
  destroys an answer.
- A token link points at a form, not a version, so a volunteer reopening it
  gets the current questions with their previous answers prefilled where the
  question still exists.

Draft edits are free; publishing is what freezes a version. A version with
submissions can never be edited, only superseded.

## 3. The availability picker

> **Amended by [ADR-0039](adr/0039-availability-is-answered-per-day-yes-partly-no.md)
> (proposed):** each day row is answered «Oui» / «En partie» / «Non»; chips and
> typed ranges live behind «En partie», day rows start at the event's opening
> time, and the drag track is dropped. The model and rules below are otherwise
> unchanged.

The control the whole decision rests on. It has to be precise, fast for the
common case, usable on a phone, and operable from a keyboard.

### Model

One group per event in scope, in period order, headed by the event's name — a
festival form shows «Montage», «Open Air», «Dub & 2step»… as sections of one
control. Within a group, one row per event day, in the **event's** timezone. Within a row the volunteer
declares zero or more time ranges. Each becomes an `availability_windows` row
of kind `available`, with exact bounds — no label resolution, no slot options.

```
Saturday 4 July          08:00 ─────────────────────────── 02:00
  suggested:  [ Morning ] [ Afternoon ] [ Evening ] [ All day ]
  selected:   ▓▓▓▓▓▓▓▓▓▓▓▓▓ 14:00 – 19:30        [edit] [×]
                                    [+ add another range]
  [ ] I am not available at all on this day
```

Three input paths, all producing the same thing:

1. **Suggested chips** — tapping a preset. These come from
   `intake_slot_options`, which survives ADR-0010 as an *optional convenience*:
   most volunteers want "Saturday afternoon" and should not have to drag
   anything. Tapping a chip inserts its exact range, which is then adjustable.
2. **Drag on the day track** — pointer selection for a precise range.
3. **Numeric entry** — two time inputs, `HH:MM`. This is the accessible path
   and, on a phone, often the fastest one. It is not a fallback; it is a
   first-class input.

### Rules

- Granularity is 30 minutes by default, per-event configurable
  (`events.availability_step_minutes`). Finer than that is false precision
  against shifts that are rarely defined to the quarter-hour — but an event
  whose missions *are* cut finer forces the step down, because the step has to
  divide every segment of every shift pattern the event uses. An event with the
  `45 / 45 / 90 / 45 / 45` *artiste* division runs at 15 minutes, or it asks
  volunteers a question they cannot answer about shifts they will be assigned to
  ([ADR-0029](adr/0029-shift-patterns-are-generators-not-constraints.md)).
- Ranges are clamped to *their own* event's `period` — the operational window,
  not the public hours, which are shown as context
  ([ADR-0044](adr/0044-event-period-is-operational-doors-are-stated.md)).
  A day row for the event's last day ends when the event ends.
- A festival submission becomes one participation per event with at least one
  `available` range ([ADR-0035](adr/0035-a-form-can-cover-a-festival.md)).
- Overlapping ranges within a day are merged on input, so the volunteer cannot
  create the state the exclusion constraint would reject — which now rejects
  overlap between an `available` and an `unavailable` window too, since that is
  a contradiction rather than a preference
  ([03 §3.5](03-data-model.md#35-participation-and-availability)). Ticking "not
  available at all" for a day therefore clears that day's ranges, visibly,
  rather than silently conflicting with them.
- Adjacent ranges are merged too: 08:00–12:00 plus 12:00–18:00 becomes one
  08:00–18:00 window. This matters because `outside_availability` tests
  containment, and a shift running 11:00–13:00 would otherwise match neither
  half.
- Days that cross midnight belong to the day they start on. A row can run to
  02:00 the following morning, which is how festival nights actually work.
- "Not available at all on this day" writes an explicit `unavailable` window
  covering the day, which is different from — and more useful than — declaring
  nothing.

### Precision is not certainty

A volunteer who drags 14:00–19:30 has said something much more specific than
one who taps "Afternoon", but neither has signed a contract.
`outside_availability` therefore stays a **soft** rule
([05](05-scheduling-rules.md)), for the same reason it always was. What changes
is that the warning is now worth reading: it fires on a real mismatch rather
than on the coarseness of the question.

### Accessibility and mobile

The picker is the highest-risk control in the application, for the same reason
the planner board is: it is spatial, and spatial controls exclude people.

- Every drag action has a keyboard equivalent. The day track is a slider pair;
  the numeric inputs are always present, never revealed behind a mode switch.
- Screen readers get the selection announced as text ("Saturday 4 July,
  available 14:00 to 19:30"), not as a graphic.
- Target size is at least 44 px on touch. The day track is tall enough to drag
  on a phone without a stylus.
- It must work at 400 px wide, which is the width most of these will be filled
  in at. The day track collapses to a single-column stack of ranges plus the
  numeric inputs; the drag track is an enhancement, not the mechanism.
- No colour-only meaning; selected ranges carry a label and a border.

## 4. Reaching the form

Two routes, neither of which is authentication.

### Token link — known volunteers

An unguessable per-volunteer capability URL, emailed to people already in the
pool. The same primitive as the ICS feed: high-entropy token, stored hashed,
revocable.

```
https://evp.example/f/{form_slug}?t={token}
```

- **Identity is certain**, so the reconciliation ladder is skipped entirely and
  the submission is applied directly. `match_kind = 'token'`.
- The form is **prefilled** with what is already known — name, phone, size,
  last edition's skills — so the common case is confirming and adding
  availability.
- It is **reusable and revisable**. Reopening it shows the previous answers;
  submitting again supersedes them ([08 §8](08-volunteer-intake.md#8-revisions-and-precedence)).
  This is the "let volunteers change their own submission" capability, and it
  costs nothing extra.
- **Long-lived — it lasts as long as the record it reaches**, not the campaign
  and certainly not fifteen minutes, because it is not a login and not a
  password-equivalent. It is pool-tier: it survives the event purge and is
  revoked when the volunteer's record is anonymised or deleted
  ([ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)). Revocable per
  volunteer, and rotated wholesale if a coordinator forwards a link to the
  wrong person.
- Optionally prefilled from the previous edition's participation, coordinator-
  enabled per campaign.

The link also carries the volunteer's **data rights**, which is why its lifetime
matters ([ADR-0027](adr/0027-volunteer-self-service-rights.md)): see what is
held, correct the pool record, change notification preferences, withdraw pool
consent, request an export, or ask for erasure. Those work whether or not a form
version is currently live — most of the year, none is.

A token grants read and write of exactly one volunteer's own record, and
destructive actions need a second proof: erasure is confirmed by mail to the
address on record, so a forwarded link cannot delete anybody
([15 §6](15-privacy-and-retention.md#6-volunteer-rights-in-practice)). Nothing
else in the system is reachable with it.

### Public link — new volunteers

```
https://evp.example/f/{form_slug}
```

For people not yet in the pool. No prefill. Identity is *claimed* by email and
goes through the reconciliation ladder
([08 §6](08-volunteer-intake.md#6-identity-reconciliation)) into the review
queue.

A coordinator can close the public route while leaving token links working —
the usual state once recruitment is over but the campaign is still running.

## 5. Anti-abuse on the public route

This is the first unauthenticated write endpoint in the system, so it is worth
being explicit.

| Measure | |
| --- | --- |
| Rate limit | Per IP and per claimed email, via `tower_governor` |
| Honeypot | A hidden field; any value submitted rejects silently |
| Timing floor | Submissions completed in under ~3 seconds are held for review |
| Invisible captcha | A self-hosted proof of work, always on: the browser solves a signed SHA-256 puzzle in the background while the volunteer types, and each solution is good for one submission ([ADR-0043](adr/0043-form-captcha-is-a-self-hosted-proof-of-work.md)). No third-party script, nothing to click. |
| Payload caps | Body size, field lengths, and a maximum number of availability ranges |
| No enumeration | An unknown form slug and a revoked token return the same generic page |

A public submission is reconciled as it is stored
([ADR-0042](adr/0042-public-submissions-reconciled-inline.md)). Someone the
pool has never seen becomes a volunteer straight away, so the defences above
are what keep spam out. Whatever gets past them is a volunteer row a
coordinator deletes. What still waits for a coordinator: a submission held
by the timing floor, a name too close to an existing volunteer's to decide,
and an address that already belongs to someone else. The response is `202`
in every case, so the route never says which happened. *(Until ADR-0042 this
section said a public submission never reaches the pool unresolved. That
needs the review queue, which is not built yet.)*

## 6. Rendering it

A **separate frontend bundle**, not a route inside the coordinator SPA.

```
apps/
  admin/   # the coordinator application: session cookie, full feature set
  form/    # the public form: no session, no admin code, minimal bundle
```

Reasons, in order of weight:

1. **Security context.** The public form must not ship the coordinator
   application's code, its API client, or its routes.
2. **Bundle size.** It is loaded once, on a phone, possibly on event-site
   mobile data, by someone with no reason to be patient.
3. **Cache and deploy independence.** The form is stable; the admin app is not.

The form's footer carries the running version and a source link, from
`GET /api/v1/meta`. Volunteers interacting with a deployment are network users
under AGPL §13 exactly as coordinators are, so this is a requirement rather
than a courtesy.

Both are Vite builds served by Caddy as static assets, so this is two entry
points rather than two projects. Shared design primitives live in a small
common package; the availability picker lives in `form/` because nothing else
uses it.

Server-rendering the form was considered and rejected: the picker needs
client-side geometry and interaction regardless, so SSR would add a Node
process in production to save one small request.

## 7. Localisation

Question labels, help text and option labels are stored per locale:

```json
{ "fr": "Quels créneaux peux-tu assurer ?",
  "en": "Which time slots can you cover?" }
```

`fr` and `en` in v1, `fr` as the fallback. The locale comes from the URL
(`?lang=`), then `Accept-Language`, then the organisation default. Times,
dates and weekday names are formatted in the **event's** timezone and the
**viewer's** locale — a distinction that is easy to conflate and produces
schedules an hour out when it is.

The picker's numeric inputs accept both `14:30` and `14h30`, because the second
is what French volunteers will type.

## 8. Privacy

The form collects dietary requirements, which can imply religion or health, and
is therefore the most sensitive point of the system.

- A `processing` consent question is mandatory on every published form:
  unticked by default, linked to a privacy notice, and the notice's version is
  recorded with the submission. The optional `pool_retention` question is
  separate, never bundled, and never required.
- Sensitive answers are stored like any other but are excluded from default
  exports and hidden from zone leads
  ([04 §4](04-api.md#4-permissions)).
- Raw answers are the largest verbatim record of what someone typed. They are
  stored as their own row and **deleted 30 days after they arrive**, not merely
  when someone is erased ([03 §3.10](03-data-model.md#310-intake),
  [ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)). Erasing a
  volunteer deletes theirs immediately.
- The form states plainly who receives the data and for how long it is kept.
  This is a paragraph of copy, not engineering, and it is the part most likely
  to be skipped.

## 9. What can go wrong

| Case | Expected behaviour |
| --- | --- |
| Volunteer submits twice via the public link | Second submission supersedes the first once reconciled to the same identity |
| Volunteer submits publicly, then via a token link | Token submission is authoritative; the public one is superseded |
| Token link forwarded to someone else | They can overwrite that volunteer's answers. Accepted risk, as with the ICS URL. Mitigated by revocation and by the audit trail. |
| Coordinator edits the form mid-campaign | New version; existing submissions keep their own. Prefill covers surviving questions only. |
| A question is deleted after answers exist | Answers persist in `raw` and stay viewable against their version. Nothing is destroyed. |
| Availability submitted before shifts are planned | Fine, and normal — availability is independent of shifts |
| Volunteer picks a range outside the event | Clamped client-side, revalidated and rejected server-side |
| Two ranges on one day that overlap | Merged on input; the exclusion constraint is a backstop, not the UX |
| Event timezone differs from the volunteer's | All times shown and entered in the event timezone, labelled as such |
| Volunteer submits on an address that already belongs to someone else | Refused with an explanation, not queued: one address identifies at most one volunteer ([ADR-0028](adr/0028-one-volunteer-one-email.md)). The message says the address is in use, never whose it is. |
| Volunteer has no email address | Public route requires one. A coordinator enters them by hand instead, and maintains their record — no link means no self-service. |
| Volunteer opens their link months later, outside any campaign | The form has nothing live to answer, so the page shows what is held plus the rights actions. Correction, export, withdrawal and erasure all still work. |
