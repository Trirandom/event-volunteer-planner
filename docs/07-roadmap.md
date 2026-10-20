# 07 — Roadmap

Sequenced so that the spreadsheet can be retired as early as possible, and so
that each milestone is independently useful. The ordering principle: build the
things that make the *next* thing easier to verify, and put the risky parts
first.

The milestones are being built out of order, driven by the first real festival
(Soundclash 26), so each one carries a **Status** line saying where it stands.

## M0 — Walking skeleton

**Goal: one request goes end to end through every layer.**

**Status: partial.** Built: workspace, Compose stack, migrations, RLS,
password sessions with the bootstrap owner
([ADR-0031](adr/0031-password-bootstrap-credential.md)), the Vue shell and
login, `GET /api/v1/meta` with the source links, and a key-guarded backoffice
for creating organisations and accounts and assigning members
([ADR-0045](adr/0045-platform-backoffice-behind-a-deployment-key.md)) — the
stop-gap for the two items below that a second organisation would otherwise
wait on. Not built: magic links, OIDC, invitations, `evp-cli create-org`, the
generated API client, CI.

- Cargo workspace, crate boundaries, Compose stack, migrations, CI (planned for GitHub Actions; the local `just check` / `just test` gates exist).
- `organizations`, `users`, `identities`, `memberships`, plus sessions —
  **for organisation members only** ([ADR-0008](adr/0008-no-volunteer-authentication-in-v1.md)).
- **Magic links** as the zero-dependency default, so a fresh clone works with
  no external account.
- **One generic OIDC client** (authorization code + PKCE) over providers
  declared in `providers.toml` — Google for this deployment, anything
  OIDC-compliant for anyone else
  ([ADR-0014](adr/0014-pluggable-oidc-providers.md),
  [ADR-0013](adr/0013-google-oidc-without-an-identity-provider.md)).
- Trusted/untrusted provider distinction, and the explicit account-linking
  endpoint that untrusted providers require.
- `evp-cli create-org --owner-email` — the first owner on a fresh install.
  Invitations need an existing owner, so without this a new deployment cannot
  be started at all.
- Invitation flow: an owner invites an address, the invitee signs in with
  Google, and the verified address matches them to the invite.
- RLS in place from the very first tenant table, with a test that checks it.
- A Vue shell with routing, the generated API client, and a login flow.
- `GET /api/v1/meta` plus the version and source links in both frontends —
  AGPL §13 binds the first deployment, so this is not deferrable.

Deliberately first: retrofitting tenant isolation onto an existing schema means
auditing every table and every query. Starting with it costs a day; adding it
in M4 costs a week and leaves doubt.

**Done when:** a fresh clone runs `docker compose up`, bootstraps an owner via
the CLI, and that owner signs in by magic link with no external service
configured. Then, with Dex declared in `providers.toml`, the same user signs in
by SSO; the OIDC negative cases and the trusted/untrusted linking matrix are
all refused correctly; a malformed provider config refuses to boot; and the
tenant-isolation suite passes.

## M1 — The pool, the form, and intake

**Status: partial.** Built: the first-party form — authoring, versions,
publish, the public route with rate limit, honeypot and proof-of-work captcha
([ADR-0043](adr/0043-form-captcha-is-a-self-hosted-proof-of-work.md)) — and
intake for it: immutable submissions, inline reconciliation
([ADR-0042](adr/0042-public-submissions-reconciled-inline.md)) and the review
queue. Not built: skills, the pool list, token links, `locked_fields`, replay,
CSV upload.

- Volunteers, skills, `volunteer_skills` with validity dates.
- Pool list with search and skill filters; volunteer detail form.
- **The intake pipeline**: immutable `submissions`, reconciliation ladder,
  review queue, replay, `locked_fields` so coordinator edits survive.
- **The first-party form**: `forms`, `form_versions`, `form_questions`, the
  nine non-availability question types (the picker needs an event, so it lands
  in M2), the authoring UI, and publish validation — including the two consent
  purposes ([ADR-0025](adr/0025-two-consents-processing-and-pool-retention.md)).
- **Token links and the public route**, with rate limiting, honeypot and
  timing floor.
- **CSV upload as migration tooling** — mapping and preview, used once for the
  existing spreadsheet. Deliberately not a polished surface.

The availability picker is **not** here: it needs an event's days and bounds,
so it lands in M2 with events. Everything else about the form ships now, which
means contact details and skills can be collected while event planning is still
being built.

Intake before any planning UI, for two reasons. It turns the existing
spreadsheet into real test data, so everything after is developed against
actual names, skill distributions and scale rather than fixtures that flatter
the design. And with volunteers having no login, this is the *only* way their
data enters the system — the front door, not a convenience.

**Done when:** a coordinator can build and publish a form, issue links, and
have responses land in the pool; the existing spreadsheet imports through a
mapping they configured; a second upload changes nothing; and a deliberately
broken mapping is fixed by replaying.

## M2 — Event structure

**Status: mostly built.** Events and festivals, the zone/post tree, shifts,
shift patterns and `shifts/generate`, the availability picker
([ADR-0039](adr/0039-availability-is-answered-per-day-yes-partly-no.md)) and
windows, and an editable shift board. Not built: skill requirements, event
duplication.

- Events with timezone and period; zone/post locations.
- Shifts, including bulk creation.
- **Shift patterns**: the org-level catalogue, the 2-hour default seeded with
  the organisation, the per-location override, and `shifts/generate` with its
  dry run — including the *artiste* case, `45 / 45 / 90 / 45 / 45`
  ([ADR-0029](adr/0029-shift-patterns-are-generators-not-constraints.md)).
  Here rather than later because every event laid out from M2 onwards is laid
  out with it, and retrofitting a generator after 2,000 hand-made shifts exist
  means nobody ever uses it.
- Skill requirements per shift.
- Event duplication, with correct local-time rebasing across DST.
- **The availability picker**: per-day range selection at the event's
  granularity, with suggested chips from `intake_slot_options`, keyboard and
  numeric entry, working at 400 px. The control the form decision rests on.
- Availability windows derived from it, with adjacent-range merging.
- A read-only timeline board: locations × time, shifts rendered, virtualised.

**Done when:** last year's event can be recreated and duplicated, including the
*artiste* post's uneven division; the board renders a full week at the target
scale of 500 volunteers' worth of shifts without jank; and a
volunteer can declare precise availability from a phone, by drag *and* by
typing, and have it stored as exact ranges.

## M3 — Assignment — the core

**Status: partial.** Built: participations, availability with provenance, the
hard constraints in the database with violation tests, assignment create and
cancel, and `operations` rows recording each write's inverse. Not built: the
soft-warning engine, `/check`, move, coverage, the audit log's writes, undo.

- Participations, wired to the availability collected in M2 (plus coordinator
  hand-entry, with provenance recorded).
- The constraint engine in `evp-domain`, fully unit-tested.
- Hard constraints live in the database, with tests that attempt each violation.
- `POST /assignments`, `/check`, move and cancel.
- Drag-and-drop on the board, plus the full keyboard equivalent.
- Inline warnings with explicit acknowledgement, including `minor_night_shift`
  and the "unarmed" state it reports when no form question feeds it
  ([05 §3](05-scheduling-rules.md#on-minor_night_shift)).
- Coverage view and the persistent gap count.
- Audit log, `operations`, and optimistic concurrency with a usable conflict UI.
  Per-item bulk assignment and its inverse land here rather than in M6, because
  an operation that cannot describe its own inverse is cheaper to fix now than
  to retrofit across every mutating endpoint
  ([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)).

This is the largest milestone and the one that carries the product. The
temptation to split it is resisted deliberately: an assignment path without the
constraint engine is a worse spreadsheet, and shipping that would set
expectations badly.

**Done when:** a full event can be staffed in the tool, the concurrency test
passes, and no sequence of UI actions can produce a double-booking.

## M4 — Output

**Status: not started**, beyond a dry-run preview of the schedule email and the
per-org OVH SMS settings ([ADR-0034](adr/0034-per-org-ovh-sms-credentials.md)).

- Roster versions, publish preview with a real diff, publish.
- Schedule **emails and SMS**, sent only to volunteers whose schedule changed,
  describing what changed. GSM-7 transliteration for SMS cost.
- The "you no longer have any shifts" message, and per-volunteer opt-outs.
- `dry_run` and `test` send modes alongside the diff preview.
- Adjacent same-post shifts merged into one line in every rendered schedule.
- PDF and CSV: per-post rosters, per-volunteer cards, accreditation, meal
  counts, workload.
- Per-participation ICS feeds with rotatable tokens — one volunteer's shifts at
  one event, which is what a calendar subscription is for.

**Done when:** publishing an event produces the paperwork the event actually
runs on, and republishing after a single change emails exactly one person.

**At this point the spreadsheet can be retired** — and not before. Retirement
requires *parity* with what it already does, not just the new guarantee:
per-cell eligibility, coverage pivots, per-volunteer email and SMS with change
detection, ICS, and the PDF planning export. The checklist is
[10 §1](10-prior-art-spreadsheet.md#1-what-it-actually-does).

## M5 — Second locale and form polish

**Status: partial.** Both frontends' UI is in `fr` and `en`; the captcha is
done. Emails and exports do not exist yet; prefill and response analytics are
not built.

- `en` alongside `fr`, end to end: form, emails, exports.
- ~~Optional captcha (Turnstile/hCaptcha), per organisation, off by default.~~ Replaced by an always-on, self-hosted proof of work ([ADR-0043](adr/0043-form-captcha-is-a-self-hosted-proof-of-work.md)).
- Prefill from the previous edition's participation.
- Form response analytics for coordinators: who has not answered yet, and a
  one-click reminder to exactly those people.

The reminder feature is small and disproportionately useful: chasing
non-responders is most of the coordination effort the spreadsheet imposed.

## M6 — Operational polish

**Status: not started**, apart from the `retention_scope` registry rows that
every migration already declares, the `just test-tz` run, and the backup
sidecar in `compose.prod.yaml`.

- Zone leads with scoped permissions.
- Per-organisation rule policies (`org_rule_policies`), including promoting
  soft rules to hard.
- GDPR: the `retention_scope` registry and its completeness gate, the
  **automated retention sweep** with its emptiness test, both age-based clocks,
  and the volunteer rights routes — see what is held, correct it, export it,
  withdraw consent, erase with mail confirmation
  ([15](15-privacy-and-retention.md),
  [ADR-0027](adr/0027-volunteer-self-service-rights.md)).
- Accessibility: the full keyboard layer, bulk selection, the command palette,
  the undo *affordance* over the operation log built in M3, and the axe +
  keyboard-only gates ([14](14-accessibility-and-interaction.md)).
- The hostile-timezone run in CI (locally it is `just test-tz` already).
- Backup automation and a rehearsed restore.
- Prometheus metrics and a small operations dashboard.

## Later, if the need is demonstrated

Ordered by how likely they are to be genuinely wanted:

| Candidate | Trigger to build it |
| --- | --- |
| SSE live updates on the board | Coordinators actually collide often enough to complain about conflict prompts |
| On-site check-in | Someone asks who is physically present, and a printed list stops being enough |
| Google Sheets polling, Typeform webhooks | An organisation insists on its own form. Specified in [08 §3](08-volunteer-intake.md#3-sources); the source abstraction keeps it cheap. Accepts coarse availability as the price. |
| Form branching and conditional logic | Question sets genuinely diverge by volunteer type. The honest interim answer is a second form and a second link. |
| Volunteer accounts | Needed for anything a volunteer must *do* rather than *tell*: swapping shifts, confirming attendance. Revisits [ADR-0008](adr/0008-no-volunteer-authentication-in-v1.md). |
| Volunteer self-signup, with approval | A move away from the coordinator-only model — a product change, not a feature. Requires accounts. |
| Suggestion list for a single shift | Coordinators say ranking is not enough, never as a bulk auto-fill |
| Native mobile app | ICS plus responsive web demonstrably falls short on site |

Each of these is cheap to add on top of the architecture above, and expensive
to add speculatively now. The one that would change the architecture is volunteer accounts, and
self-signup on top of them: it introduces an untrusted write path and turns the
signup-opening moment into a genuine concurrency problem. That is the reason
the assignment endpoints are already written to be safe under concurrency
rather than assuming a single coordinator, and the reason
`volunteers.user_id` stays in the schema.

## Risks

| Risk | Mitigation |
| --- | --- |
| Timeline board is harder than estimated | Prototype it in M2 as read-only, before the assignment logic depends on it |
| Spreadsheet data is messier than expected | Migration lands in M1; the mapping preview and review queue make the mess visible early, and replay makes mistakes cheap to undo |
| Coordinators edit a live form mid-campaign | Versioning, not drift detection: submissions pin to the version they answered. Safe by construction |
| The availability picker is hard to get right on mobile | It is the M2 deliverable with the most risk. Numeric entry is the mechanism and drag is the enhancement, so a failed drag interaction still leaves a working form |
| Public form attracts spam | Rate limit, honeypot, timing floor and an always-on proof-of-work captcha ([ADR-0043](adr/0043-form-captcha-is-a-self-hosted-proof-of-work.md)). Unambiguous submissions join the pool inline; ambiguous ones are held for a coordinator ([ADR-0042](adr/0042-public-submissions-reconciled-inline.md)) |
| Volunteers forward their personal link | Accepted risk, as with the ICS URL. Revocable per volunteer, rotatable wholesale, and every submission is audited |
| Rust slows iteration on UI-adjacent work | Keep the API thin and the domain pure; most iteration happens in Vue |
| The replacement ships without something the spreadsheet already did | M4 is gated on the parity checklist in [10 §1](10-prior-art-spreadsheet.md#1-what-it-actually-does), not on the new features alone |
| Timezone handling gets subtly wrong | Explicit DST tests from M2, event-timezone rendering as a rule from day one |
| Scope creeps toward auto-assignment | Stated as a non-goal in [05](05-scheduling-rules.md), with the reasoning recorded |
