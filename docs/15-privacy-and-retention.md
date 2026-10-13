# 15 — Privacy and retention

Security controls are [12](12-security.md). This is what personal data is held,
why, for how long, and how a volunteer gets rid of it.

Two requirements drive the design:

1. **A volunteer can have their data removed at any time**, on request.
2. **Personal data is deleted one month after the event.**

## 1. The conflict, and how it resolves

Requirement 2 as stated contradicts a feature the design is built around: the
**reusable volunteer pool**. The whole reason `volunteers` and `participations`
are separate tables is that the pool carries across editions, so next year's
event starts from people who already helped
([03 §1](03-data-model.md#the-three-identity-concepts)). Purging all personal
data a month after each event destroys that, and the coordinator is back to
retyping three hundred people every year.

The resolution follows from the principle the regulation actually states, so
being correct costs nothing here: **purpose limitation**. Data collected to staff *this* event may
not be kept indefinitely against *some future* event without a lawful basis,
and for a volunteer the practical basis is **consent**.

So retention splits by purpose — and the purpose is a property of the **table**,
not of the column ([ADR-0021](adr/0021-retention-tier-follows-table.md),
[ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)). Every table in the
schema declares its tier once, in `retention_scope`
([03 §3.8](03-data-model.md#38-policy-and-delegation)), and the sweep reads that
declaration rather than carrying a list of its own:

| Tier | Purpose | Retention (default) | Members |
| --- | --- | --- | --- |
| **Event** | Staffing this event | **Rows deleted 30 days after the event ends.** Unconditional, automated, no opt-out | `participation_details`, `availability_windows`, `schedule_snapshots`, `calendar_feed_tokens`, `operations` |
| **Pool** | Being invited to, and equipped for, future events | Kept **only with explicit consent** — contact details, skills, T-shirt size, dietary requirements. Expires **18 months** after last contact. Without consent, anonymised at the 30-day boundary | `volunteers`, `volunteer_skills`, `form_invite_tokens` |
| **Accountability** | Who did what, and who was rostered where | Retained. Holds identifiers, timestamps and statuses — not personal content | `participations`, `assignments`, `roster_versions`, `submissions`, `submission_batches`, `audit_log` |
| **Ephemeral** | A short, specific job that is finished | Deleted on its own clock, independent of any event | `submission_payloads` (30 days), `outbox_messages`, `sessions`, `login_tokens` |

Two properties make this a mechanism rather than a classification exercise.

**The purge deletes rows; it never nulls columns.** If a column would have to be
nulled, it is on the wrong table, and moving it is the fix. That is why the
per-edition attributes — the T-shirt override, meal plan, accreditation code,
arrival and departure, notes, and the `is_adult` declaration — live on
`participation_details` rather than on `participations`: the participation row
itself has to survive, because assignments and published rosters hang off it.
One table, one tier ([ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)).

**A new table fails the build until it is classified.** A test enumerates
`pg_class` and asserts that every table has exactly one `retention_scope` row
with a reason. (Today every migration declares its row, but the test asserts
only the form tables; the schema-wide version is planned — §9.) The failure mode of a retention rule must not be silence, and a
forgotten column produces exactly that: data that is still there, with no error.

`tshirt_size` shows the split working: it exists on **both** `volunteers` and
`participation_details` — the stable value and a per-event override. Tier
follows table, so the override is deleted and the stable value persists, with no
special case anywhere.

Every period is **per-organisation configuration** with caps the schema
enforces: 30 days for event data (max 180), 18 months for the pool (max 36), 30
days for verbatim form payloads (max 180) and 30 days for the undo window (max
180). No deployment can configure indefinite retention
([ADR-0020](adr/0020-retention-periods-are-configuration.md),
[03 §3.8](03-data-model.md#38-policy-and-delegation)).

Why 18 months by default: for an annual event, 12 months expires right around
the next edition, so a slipped planning cycle silently drops the pool at the
moment it is needed. 18 spans edition to edition with slack and stays well
inside CNIL's three-year reference. An organisation with a shorter cycle should
set it lower.

The retained thing is therefore **the person, not the participation**. The
association runs one large event plus one or two smaller ones a year, and the
same T-shirt size and dietary requirement serve all of them —
re-asking three hundred people three times a year would mean more forms, worse
response rates, and *more* copies of the data in circulation rather than fewer.

This satisfies both requirements without losing the pool, and it turns the
form's "keep my details" checkbox into something with a real consequence.

It also corrects an earlier weakness: [01 §6](01-product-spec.md#6-privacy)
originally said volunteer records were "flagged for review 24 months after
their last participation". A review flag is not a lawful basis, and indefinite
retention pending someone noticing a flag is exactly what regulators object to.
See [ADR-0018](adr/0018-purpose-based-retention.md).

## 2. What the law actually says

Worth stating plainly, because this is open source and other operators will
read this document and may repeat it.

**GDPR specifies no numeric retention period.** Not one year, not two, not
anywhere. Article 5(1)(e) — storage limitation — requires that personal data be
kept "no longer than is necessary for the purposes for which the personal data
are processed", and leaves the period to the controller, who must choose it and
be able to justify it. Article 5(1)(c) adds minimisation: collect only what is
needed. Article 17 gives the right to erasure.

The numbers that circulate come from national guidance, not the regulation:

| Figure | What it actually is |
| --- | --- |
| ~3 years from last contact | CNIL's guidance for **prospecting** data — the closest analogue to keeping a volunteer's details to invite them next time |
| 13 months | CNIL's guidance on **cookies and consent validity**. A different regime; it does not govern database retention |
| 30 days | Not a retention rule — the deadline in Article 12(3) for **responding** to a data-subject request |

So the periods below are **this software's defaults and this deployment's
policy**, not legal requirements. Nothing here should be quoted as "GDPR
requires…", because it does not. Choose a period, write down why, and check it
against your own regulator's guidance.

The defaults are chosen to sit comfortably *inside* the range guidance
suggests, which is the position that needs the least defending.

## 3. What is held

| Data | Tier | Why it exists |
| --- | --- | --- |
| Name, email, phone | Pool | Contacting the volunteer |
| Skills, with validity dates | Pool | Assignment eligibility |
| Availability windows | Event | Scheduling |
| Assignments | Event | The roster |
| T-shirt size (`volunteers`) | **Pool** | Merch. Stable across a year |
| T-shirt size (`participation_details`) | Event | A per-event override, when this edition differs |
| Meal plan (`participation_details`) | Event | *Which catering option at this event* — a per-edition choice, unlike the dietary requirement below |
| **Dietary requirements** (`volunteers.dietary`) | **Pool** | Catering, at every event. **May reveal religion or health**, so it is special-category data and needs *explicit* consent (§4) |
| Coordinator notes (`volunteers.notes`) | **Pool** | Standing notes about a person. **Visible to the volunteer in their own data export** — write them accordingly |
| Per-event notes (`participation_details.notes`) | Event | Notes about this edition only |
| Accreditation code (`participation_details`) | Event | Site access |
| `is_adult` (`participation_details`) | Event | One boolean, «J'ai 18 ans ou plus», feeding the night-shift warning ([ADR-0023](adr/0023-adult-declaration-boolean.md)). Concerns a minor when false, so worth noting it is *asked per edition and purged with it*, and that no date of birth backs it |
| Raw form answers (`submission_payloads.raw`) | **Ephemeral** | Provenance and replay ([08](08-volunteer-intake.md)). **The largest concentration of personal data in the schema**, which is why it is a row of its own that expires by age rather than a column somebody has to remember to overwrite |
| ICS feed tokens (`calendar_feed_tokens`) | Event | Delivery of one participation's schedule |
| Form links (`form_invite_tokens`) | **Pool** | Delivery **and** the route by which a volunteer exercises their rights ([ADR-0027](adr/0027-volunteer-self-service-rights.md)), so it lives as long as the record it reaches |
| Audit log | Accountability | Who changed what. `before`/`after` are the one place in this tier holding personal values, and anonymisation redacts them by `subject_volunteer_id` |
| Sessions, identities | Members only | Authentication. Sessions are ephemeral and swept once expired or revoked |

Volunteers have no accounts, so there is no volunteer login data at all
([ADR-0008](adr/0008-no-volunteer-authentication-in-v1.md)) — one of the
quieter privacy benefits of that decision.

## 4. Consent

Two consent questions, and a consent question declares which one it is
([ADR-0025](adr/0025-two-consents-processing-and-pool-retention.md)). They are
different lawful bases with different consequences, so they are never one
control.

| Purpose | Required to submit | Covers |
| --- | :-: | --- |
| `processing` | **Yes** | Handling the answers to staff **this event**, and contacting the volunteer about it **by email and SMS** |
| `pool_retention` | No | Keeping the `volunteers` record — contact details, skills, T-shirt size and any dietary requirements — to invite them to **future** events |

The `processing` question is mandatory on every published version, unticked by
default, and records the privacy-notice version alongside the submission
([09 §8](09-volunteer-form.md#8-privacy)). It is what makes the schedule email
and the schedule SMS lawful, so it names both channels; turning a channel off
afterwards (`notify_email`, `notify_sms`) is a preference, not a withdrawal.

Pool retention is the **separate, independent, optional** one:

> ☐ Je souhaite faire partie de l'équipe pour les prochains événements.
> We keep your name, contact details, skills, T-shirt size and **any dietary
> requirements or allergies you have told us**, so we do not have to ask again.
> You can withdraw at any time; we delete everything after 18 months without
> contact.

Wording modelled on the previous form's «Je souhaite faire partie de l'équipe
de fly / affichage» ([10](10-prior-art-spreadsheet.md)) — a question the
association's volunteers already recognise, and one that reads as joining
something rather than as a data-handling formality.

Rules that keep this honest:

- Two consents, never bundled, and the schema enforces it: a `pool_retention`
  question cannot be marked required
  ([03 §3.11](03-data-model.md#311-the-first-party-form)). Refusing it must not
  prevent volunteering — a consent that costs you something is not freely given.
- Withdrawal is as easy as giving it (§5), and withdrawing pool consent triggers
  the same deletion the one-month sweep would have performed.
- Pool consent **expires**: 18 months (configurable) after the volunteer's last
  participation or contact, whichever is later. Expiry deletes; it does not flag
  for review.
- **What is kept is the person, not the participation.** The whole
  `volunteers` record and their skills — because those facts serve the two or
  three events a year equally. Everything in the event tier goes at 30 days
  regardless of consent, and the verbatim form answers go 30 days after they
  arrived, whether or not they were ever attached to an event.
- **A form with no pool-retention question collects no pool consent**, so
  everyone who answers it is anonymised at the event boundary. Silence is never
  consent, and the form editor says which consequence each consent question
  carries.
- **The question names the sensitive categories, and that is deliberate.**
  `dietary` is free text and may contain data revealing religion ("halal") or
  health ("coeliac", "nut allergy"). Article 9 prohibits processing
  special-category data unless an exception applies, and the one available here
  is 9(2)(a), **explicit** consent — a higher bar than the ordinary consent
  covering a name. Naming the data is what makes the consent explicit, and it
  costs one sentence.
- Consent is versioned. Changing the privacy notice does not retroactively
  cover data already collected.

```sql
-- on volunteers
pool_consent_at       timestamptz,   -- NULL: no consent, event-scoped only
pool_consent_version  text,
pool_consent_expires  timestamptz,   -- last contact + org policy, recomputed on contact
is_core_team          boolean NOT NULL DEFAULT false,  -- coordinator marker, see below
```

### On over-consent

A checkbox may well be ticked by two hundred people when only about twenty are
volunteers the coordinators actively want back. That is accepted rather than
gated, for two reasons.

**The 18-month expiry is the pruning mechanism.** Anyone who ticks the box and
is not contacted again drops off automatically, so over-consent self-corrects
without anybody auditing a list.

**Honouring consent conditionally would make the question dishonest.** Asking
"may we keep your details?" and then deleting them anyway because a coordinator
did not tick a second box is worse than simply keeping them for 18 months.

`is_core_team` therefore exists as a **coordinator convenience** — filter the
pool to the people you actually invite, and prune the rest deliberately — and
not as a precondition for consent to be respected. A coordinator may delete
anyone from the pool at any time.

## 5. The one-month sweep

Automated, not a procedure someone remembers.

**Trigger:** a scheduled job runs daily over every event whose `period` upper
bound is more than `event_data_days` in the past (default 30), **whatever its
`status`**. Status is deliberately not a condition: an event that has finished
is usually still `published`, because nobody archives it the day after, and
gating the sweep on `archived` would have exempted the normal case
([ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)). The period comes
from the organisation's policy, so the sweep's tests must cover a non-default
value — otherwise the configurability is untested and therefore untrue.

**What it does is uniform: it deletes rows from the event tier.** No column
lists, no redaction step, no per-table special cases. The scope comes from
`retention_scope` ([03 §3.8](03-data-model.md#38-policy-and-delegation)):

| Event-tier table | What goes with it |
| --- | --- |
| `participation_details` | Every per-edition attribute: meal plan, accreditation code, arrival and departure, per-event notes, the T-shirt override, and the `is_adult` declaration |
| `availability_windows` | What the volunteer said about this edition |
| `participation_missions` | Which missions they said they could do ([ADR-0036](adr/0036-missions-question.md)) |
| `participation_answers` | Answers to custom form questions — the fly team, the info meeting ([ADR-0037](adr/0037-custom-answers-are-kept-per-participation.md)) |
| `schedule_snapshots` | The schedules as they were sent, names included. Keeping them would be keeping copies of emails to prove they were sent |
| `calendar_feed_tokens` | The ICS feed for that participation stops working, which is correct once the event is over |
| `operations` | Undo payloads, which name entities and people |

**What deliberately survives** is the accountability tier: the `participations`
row itself, `assignments`, `roster_versions`, and the audit log. Those hold
identifiers, times and statuses — who was rostered where, and who put them
there. That history is the thing the spreadsheet never had
([01 §1](01-product-spec.md#1-why-this-exists)), and a retention rule that
destroyed it would be trading one failure for another. It stays meaningful
without being personal, because the volunteer it points at is either retained by
consent or anonymised by the next step.

**The sweep does not touch `volunteers` at all.** Stable person facts are
pool-tier ([ADR-0021](adr/0021-retention-tier-follows-table.md)); whether that
row survives is decided entirely by the consent check below.

**Then, for each volunteer with no remaining non-swept participation:**

- **With valid pool consent** — the `volunteers` row and their skills are kept
  intact: contact details, T-shirt size, dietary requirements, standing notes.
  Everything event-scoped has already gone. Their form link keeps working, which
  is deliberate: it is how they exercise their rights over the data being kept
  ([§6](#6-volunteer-rights-in-practice)). The row is deleted outright when
  `pool_consent_expires` passes, which is why that expiry sweep matters more
  than it looks — it is what eventually removes health-adjacent data.
- **Without** — `anonymize_volunteer()`: personal fields nulled,
  `anonymized_at` set, `display_name` replaced with a stable opaque label
  (`Bénévole #a1b2`), their form and calendar tokens revoked, their
  `submission_payloads` deleted, and `audit_log.actor_label` rewritten along
  with `before`/`after` on any row whose `subject_volunteer_id` is theirs. The
  row survives so that assignment history and roster versions stay
  referentially intact while containing no personal data.

### Two clocks that are not the event's

Not everything personal belongs to an event, and an event-scoped sweep would
never reach the things that do not:

- **Verbatim answers** (`submission_payloads`) are deleted
  `submission_raw_days` after **receipt**, default 30. A pool-recruitment
  submission belongs to no event at all, so under the old event-only rule its
  payload would have been kept forever. Replay is available for as long as the
  payload is, which is the window in which a mapping error is actually found
  ([08 §2](08-volunteer-intake.md#2-design-a-staged-replayable-pipeline)).
- **Expired sessions and consumed login tokens** are deleted daily. They carry
  an IP address and a user agent and have no purpose once spent. Nothing was
  removing them until every table had to declare a tier.
- **Delivered outbox messages** are deleted too. A rendered schedule email is a
  copy of someone's name, shifts and phone number sitting in a queue table long
  after it was sent; a parked failure is kept until an operator has dealt with
  it, which is the only reason to hold one at all.

**Verification is part of the mechanism.** Three assertions, all structural:
after a sweep, every event-tier table has **zero rows** for that event; every
accountability-tier row that referenced it still exists; and every table in the
schema has a tier. There is no data dictionary of personal columns to keep in
step — that approach was rejected precisely because its failure mode is
invisible, the symptom being data that is still there
([ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)).

The sweep writes a summary to `audit_log`, and a metric records the last
successful run so a stalled sweeper is alertable rather than discovered during
an audit.

## 6. Volunteer rights, in practice

Volunteers have no account, so each right needs a route that does not require
one. Every right below has an endpoint
([04](04-api.md#the-volunteers-own-data),
[ADR-0027](adr/0027-volunteer-self-service-rights.md)) — a right whose only
route is "ask a coordinator" resolves at the speed of somebody reading their
email, and a right with no route at all is a sentence in a document.

**The link lasts as long as the record.** A volunteer's `form_invite_token` is
pool-tier and survives with their `volunteers` row, is revoked when that row is
anonymised or deleted, and is individually revocable and rotatable wholesale.
This matters more than it looks: the previous design deleted these tokens at the
event boundary, which removed the self-service route from exactly the people
whose data is kept longest — the ones who consented to eighteen months.

All of them resolve within one month, which is the deadline Article 12(3)
sets for *responding* to a request — not to be confused with a retention period.

### Erasure — "delete my data", at any time

Two paths:

**Self-service, via their form token link.** The link they already have
([09 §4](09-volunteer-form.md#4-reaching-the-form)) carries a "delete my data"
action — `POST /api/v1/public/me/erasure`. Because a capability URL is
forwardable, deletion is **not** immediate: it returns `202`, sends a
confirmation to the address on record, and the confirmation link executes it.
Two independent proofs of control before an irreversible action — holding the
link, and receiving mail at the recorded address.

**By asking.** Any coordinator can run it from the volunteer's record. The
request and who actioned it are logged.

Erasure runs the same `anonymize_volunteer()` path as the sweep, immediately,
regardless of consent or of whether the event has finished.

**Limits, stated plainly:** the audit log is pseudonymised rather than deleted,
so accountability for who assigned whom survives without naming them; and a
roster already published and emailed cannot be recalled from recipients'
inboxes. Both are disclosed in the privacy notice rather than glossed.

### Access and portability

`GET /api/v1/orgs/{org}/volunteers/{id}/export` returns everything held about
one person as JSON, including any raw answers still within their replay window.
Self-service is `POST /api/v1/public/me/export`, which **emails** the export to
the address on record rather than returning it to the browser — one request on a
forwarded link should not hand over a complete personal record. `GET
/api/v1/public/me` returns inline only what the prefilled form already showed.

### Rectification

Two routes, because a form is not always live. Their token link reopens their
submission and resubmitting supersedes it
([08 §8](08-volunteer-intake.md#8-revisions-and-precedence)); outside a
campaign, `PATCH /api/v1/public/me` corrects the pool record directly — name
parts, contact details, size, dietary requirements. It stops at
`locked_fields`, the columns a coordinator has already corrected by hand, and
says which fields it declined rather than silently ignoring them. This is the
right the no-accounts decision would otherwise have made awkward, and the
capability link is what makes it self-service.

### Objection and withdrawal

Withdrawing pool consent, or setting `notify_email` / `notify_sms` to false, is
`PATCH /api/v1/public/me/preferences` on the same link and needs no
confirmation — stopping processing is not destructive, so it should be
frictionless in a way deletion should not. Withdrawing pool consent runs the
same deletion the sweep would have performed. It does not withdraw the
`processing` consent for an event that has already happened: the roster is
evidence that it did.

## 7. Minimisation

Rules that reduce what has to be protected in the first place, which is more
effective than protecting more:

- **Do not collect what is not used.** Every question that collects an answer
  must name the field it feeds; publishing is refused otherwise
  ([09 §1](09-volunteer-form.md#1-scope)). The exceptions collect nothing that
  needs a destination: `section` takes no answer, `availability` writes windows,
  and a `consent` answer is recorded against the notice version and the purpose
  it declares.
- **Store the answer, not the data you would derive it from.** Birthdate is
  not collected. The night-shift safeguard that once needed it now reads one
  boolean — «J'ai 18 ans ou plus» — on `participations`
  ([ADR-0022](adr/0022-no-birthdate-collected.md),
  [ADR-0023](adr/0023-adult-declaration-boolean.md)). Same safeguard, one bit
  instead of a strongly identifying date, event-tier instead of pool-tier, and
  re-asked each edition instead of retained. This is the clearest worked
  example of minimisation in the schema: the question was "what is this
  *for*?", and answering it produced a smaller field, not a deleted feature.
- Dietary requirements are free text because catering needs them, and are
  excluded from default exports and hidden from zone leads.
- Phone numbers are collected only where SMS is in use.
- Exports default to the minimum: a post roster needs names and times, not
  dietary notes.

## 8. Operator obligations

Things a self-hosting deployment must do, which software cannot do for it. Worth
listing because an association will not otherwise know:

- Publish a privacy notice, and version it. The application records which
  version each consent covered; it does not write the notice.
- Name a contact for data-subject requests.
- Keep the deployment's own record of processing activities, if applicable.
- **Backups are personal data too.** A volunteer erased in the database is still
  in last night's `pg_dump`. Backup retention should be short — 30 days is a
  reasonable default — and the restore procedure must re-run the retention sweep
  afterwards, or a restore silently resurrects erased people. This is the
  compliance failure most likely to be missed, so the restore runbook makes it
  step one.
- If SMS or mail goes through a third party, that processor is part of the
  operator's obligations.

## 9. Enforcement

Status as in [11 §7](11-engineering-standards.md#7-enforcement-summary). The
retention sweep, the rights routes and the exports do not exist yet, so most of
this table is the specification their tests will be written against.

| Rule | Gate | Stage | Status |
| --- | --- | --- | --- |
| Every table has a tier | A test enumerates `pg_class` and asserts exactly one `retention_scope` row, with a non-empty reason, for each. A new table fails the build ([ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)) | test | partial — every migration declares its row; the test covers the form tables only |
| The sweep empties the event tier | Test asserting **zero rows in every event-tier table** for a swept event. Not a per-column list: as columns are added to `participation_details` they are covered automatically | test | planned |
| The sweep preserves accountability | Test asserting the `participations` row, its `assignments` and its `roster_versions` still exist afterwards — the property the previous "no dependents survive" formulation would have violated | test | planned |
| The purge never nulls a column | Test asserting the sweep issues only `DELETE` against event-tier tables. A column that would need nulling is on the wrong table | test | planned |
| Payloads and sessions expire on their own clock | Test over a pool-level submission (no event) and an expired session: both gone without any event ending | test | planned |
| `volunteers` survives if and only if consent is valid | Test over the four cases: consented/expired × swept/not | test | planned |
| Anonymisation preserves integrity | Test that roster versions and audit entries survive it | test | planned |
| Erasure requires two proofs | Test that a token alone cannot delete, and that the confirmation link does | test | planned |
| Rights routes work outside a campaign | Test that export, correction, withdrawal and erasure succeed with no live form version | test | planned |
| A retained volunteer keeps a working link | Test that a consented volunteer's `form_invite_token` survives the event purge | test | planned |
| Sensitive fields excluded from exports | Snapshot test per export format | test | planned — no exports yet |
| Sensitive fields hidden from zone leads | Route × role matrix ([12 §4](12-security.md#4-authorisation-belongs-in-the-type-system)) | test | planned |
| No personal data in logs | Redacting `Debug` on `Email`/`Phone`; allowlisted log fields | check | planned — no `Email`/`Phone` types yet; log fields by review |
| Sweep is running | Metric on last successful run, alerted | ops | planned |
