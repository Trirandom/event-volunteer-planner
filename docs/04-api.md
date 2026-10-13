# 04 — API surface

REST over HTTPS, JSON in and out. The OpenAPI 3.1 document is to be generated
from the Rust handlers by `utoipa` and served at `/api/openapi.json`, and the
frontend's TypeScript client generated from it, so that hand-written request
or response types on the client are a build failure. **Not built yet:** today
the DTOs derive `ToSchema` but no document is assembled, and the admin's API
modules parse responses with hand-written valibot schemas.

This document is the specification. The endpoints that exist today are: the
password `auth/login`, `logout` and `me`; festivals, events, locations, shifts,
`shifts/generate` and shift patterns; participations and their availability;
assignment list, create and cancel; forms and form versions; the intake review
queue and `resolve`; a festival's submissions; SMS settings; the public form's
`GET` and submission; `meta`, `/healthz` and `/readyz`. Everything else below
is planned.

## 1. Conventions

| Aspect | Rule |
| --- | --- |
| Base path | `/api/v1` |
| Tenant scoping | Everything tenant-owned lives under `/orgs/{org_id}/…`. The org is never inferred from the session alone — a user in two organisations must say which one they mean. |
| Auth | `evp_session` cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`. **Sessions are for organisation members only**, via any configured OIDC provider or a magic link; provider tokens are never stored and never used as the session. The generic intake endpoint uses `X-API-Key`. The volunteer routes under `/public` are authorised by a capability token in `?t=`, which is not a session and never becomes one ([12 §7](12-security.md#7-capability-urls)). |
| CSRF | Double-submit: `X-CSRF-Token` header must match the `evp_csrf` cookie on every unsafe method (planned; today the `SameSite=Lax` cookie is the only defence). The `/public` routes carry no cookie, so they are not exposed to CSRF and require no token — they are rate limited per capability token and per IP instead. |
| IDs | UUIDv7 strings. |
| Times | RFC 3339 with offset, always UTC (`2026-07-04T18:00:00Z`). Ranges are `{"start": …, "end": …}`, half-open `[start, end)`. |
| Pagination | Keyset: `?limit=50&after=<opaque>`. Responses carry `{"data": [...], "next": "<opaque>"}`, with `next` null on the last page. No offset pagination. |
| Optimistic concurrency | `GET` returns `ETag`. `PATCH`/`PUT`/`DELETE` on versioned resources require `If-Match`; a mismatch is `409`. A missing `If-Match` is `428 Precondition Required`, not a silent overwrite. |
| Idempotency | `POST` accepts `Idempotency-Key`. Replays return the original response. Required for anything that sends email. |
| Errors | RFC 9457 `application/problem+json`. |
| Bulk | Two shapes, deliberately distinguished ([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)). **Per-item bulk** — a set of independent domain actions — evaluates each item separately inside one transaction, commits the successes, and returns a per-item outcome with `violations` for the failures. **Atomic replacement** — one document submitted whole (`PUT …/availability`, `…/mappings`, `…/questions`, `…/requirements`, `…/skills`) — is all-or-nothing, because there are no items, only a new value. |
| Undo | Every mutating request returns an `operation_id`, and is reversible through `POST …/operations/{id}/undo` until it is published or superseded ([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)). The ids and their inverses are recorded today; the undo route is not built yet. |

### Error format

```json
{
  "type": "https://evp.example/errors/constraint-violation",
  "title": "Assignment violates a hard constraint",
  "status": 422,
  "detail": "Marie Dupont is already assigned to Bar 1 from 18:00 to 22:00.",
  "instance": "/api/v1/orgs/018f.../assignments",
  "request_id": "01J8...",
  "violations": [
    {
      "code": "double_booked",
      "severity": "hard",
      "message": "Overlaps an existing assignment",
      "conflicting_assignment_id": "018f...",
      "conflicting_shift_id": "018f...",
      "overlap": { "start": "2026-07-04T18:00:00Z", "end": "2026-07-04T20:00:00Z" }
    }
  ]
}
```

`violations` is the load-bearing part: the planner board renders each entry
against the shift it concerns, so the coordinator sees *what* clashes and
*where*, not a modal saying "error".

Validation failures use `type: …/validation` and a `errors: {field: [msg]}` map.

**The envelope covers request bodies too.** A body that cannot be deserialised
is rejected before any handler runs, and those rejections are `problem+json`
like everything else — the API uses its own JSON extractor rather than the web
framework's, precisely so that the framework's plain-text rejection cannot
reach a client. `detail` is a fixed sentence in those cases and never repeats
the deserialiser's own message: that message is an implementation detail, it is
not a stable contract, and it quotes submitted values back — which on
`/auth/login` would mean quoting a password into a response body
([12 §5](12-security.md#5-not-leaking-things)). The real message is logged at
`debug` instead. Which fields an endpoint requires is answered by the generated
OpenAPI document, before the request is sent.

The `type` URIs currently issued:

| `type` | Status | Meaning |
| --- | --- | --- |
| `https://evp.example/errors/unauthenticated` | `401` | No session, or an expired one |
| `https://evp.example/errors/invalid-credentials` | `401` | Login failed. One `type` and one `detail` for all three causes, by design |
| `https://evp.example/errors/invalid-request` | `422` | The body parsed and is not usable: a missing field, a field of the wrong type, a semantic conflict |
| `https://evp.example/errors/not-found` | `404` | The resource does not exist, or exists in an organisation this caller is not a member of — indistinguishable by design |
| `https://evp.example/errors/forbidden` | `403` | Authenticated, a member of the organisation, but not of a role this route requires |
| `https://evp.example/errors/conflict` | `409` | The request conflicts with current state: a slug already in use, or an example requested for a non-empty org |
| `https://evp.example/errors/validation-failed` | `422` | A field failed a domain rule the JSON schema cannot express: an unknown IANA timezone, an empty or inverted period |
| `https://evp.example/errors/malformed-body` | `400` | The body could not be read as JSON at all |
| `https://evp.example/errors/unsupported-media-type` | `415` | The body was sent without `Content-Type: application/json` |
| `https://evp.example/errors/payload-too-large` | `413` | The body exceeds what the server will buffer |
| `https://evp.example/errors/rate-limited` | `429` | Too many attempts from one client address. `Retry-After` carries the wait in seconds and `detail` repeats it in words, because this is the one refusal whose remedy a person has to read |
| `https://evp.example/errors/internal` | `500` | Unexpected. Carries no `detail`; the cause is in the log under the `request_id` |

Clients branch on `type`, never on `title` or `detail`, which are prose and may
be reworded or translated.

## 2. Status codes

| Code | Used for |
| --- | --- |
| `200` / `201` / `204` | Success |
| `202` | Accepted for asynchronous handling: a public form submission, an erasure request, a magic link |
| `400` | Malformed JSON, bad query parameters |
| `401` | No session, or expired session. Not used for OIDC callback failures, which redirect. |
| `403` | Authenticated but not permitted (wrong role, or zone outside a zone lead's scope) |
| `404` | Not found **or** not visible to this tenant — the two are indistinguishable by design |
| `409` | `If-Match` mismatch, or a uniqueness collision |
| `413` | Request body larger than the server will buffer |
| `415` | Request body sent without `Content-Type: application/json`. Distinct from `400` and `422` on purpose: nothing is wrong with the body, and the caller fixes it by setting one header |
| `422` | Semantically invalid: hard constraint violation, unacknowledged soft warning, or a well-formed body missing a required field |
| `428` | Unsafe method on a versioned resource without `If-Match` |
| `429` | Rate limited (`Retry-After` set) |

`404`-for-forbidden across tenants is deliberate: distinguishing "does not
exist" from "exists but is not yours" leaks the existence of other tenants'
records.

## 3. Endpoints

### Authentication

Two methods, one session model ([ADR-0013](adr/0013-google-oidc-without-an-identity-provider.md)).

**OIDC single sign-on** — any configured provider
([ADR-0014](adr/0014-pluggable-oidc-providers.md)):

```
GET    /api/v1/auth/providers                             → what this deployment offers
GET    /api/v1/auth/oidc/{provider}/start   ?redirect_to=  → 302 to the provider
GET    /api/v1/auth/oidc/{provider}/callback ?code&state   → 302 to the app + Set-Cookie
```

`{provider}` is the `id` from `providers.toml` — `google`, `entra`, `keycloak`,
whatever the deployment declared. An unknown id is `404`, and the response is
identical to a disabled one, so the endpoint does not enumerate configuration.

`/auth/providers` is unauthenticated and returns only what a login page needs:

```json
{ "magic_link": true,
  "oidc": [ { "id": "google", "display_name": "Google" } ] }
```

No issuer, no client id, no claim map — the login page renders buttons from
this, so adding a provider needs no frontend change, and the response leaks
nothing about how the deployment is wired.

`start` generates a `state` and a PKCE `code_verifier`, stores both in a
short-lived signed cookie (not server-side — they are single-use and expire in
minutes), and redirects. `callback` verifies `state`, exchanges the code with
PKCE, validates the ID token against that provider's JWKS (`iss` matching the
discovery document exactly, plus `aud`, `exp`, `nonce`), then **discards the
token** and issues our own session.

`redirect_to` is validated against an allow-list of app-relative paths. An
open redirect on the login callback is the classic way this endpoint is abused.

Failure cases are `302` back to the login page with an error code, never a raw
`4xx` — the user is in a browser mid-redirect, not calling an API.

**Magic link** — the default method, and break-glass:

```
POST   /api/v1/auth/magic-link        { email }        → 202 (always, regardless of account existence)
POST   /api/v1/auth/callback          { token }        → 200 + Set-Cookie
```

**Password** — the bootstrap credential, and currently the only method
implemented ([ADR-0031](adr/0031-password-bootstrap-credential.md)):

```
POST   /api/v1/auth/login             { email, password } → 200 + Set-Cookie
```

`401` with `application/problem+json` and the same `detail` for an unknown
address, an account with no password identity, and a wrong password: any
difference between the three turns the endpoint into an account oracle. The
unknown-address path verifies against a dummy hash so that it costs the same as
the wrong-password path, because a timing difference is the same oracle by
another route.

Rate limited per client address: ten attempts back to back and one back every
fifteen seconds by default, then `429` with `Retry-After` until the quota
refills. That bounds the guessing and the *cost* — every attempt in flight is
an Argon2 verification holding ~19 MiB of the server's memory. The address is
taken from `X-Forwarded-For` by counting `EVP_TRUSTED_PROXY_HOPS` entries from
the right, so a caller cannot pick its own bucket by sending a header. There is
deliberately no second quota keyed on the submitted address, the way
`POST /auth/magic-link` has one: on a password login that is an account lockout
under another name — anybody who knows an address could hold its bucket empty —
and [ADR-0031](adr/0031-password-bootstrap-credential.md) rules lockout out.

This method exists so that a deployment has a way in before SMTP or an identity
provider is configured. It occupies the `'password'` slot in `identities`; the
two methods above land beside it on the same session model, and it becomes the
fallback rather than the front door. There is no registration, reset or
change-password endpoint — a second user arrives by invitation, and a forgotten
password by magic link.

**Session management** — shared by all three:

```
GET    /api/v1/auth/me                                 → session, user, identities, memberships
GET    /api/v1/auth/sessions                           → this user's active sessions
POST   /api/v1/auth/logout                             → 204   (unauthenticated and idempotent)
DELETE /api/v1/auth/sessions/{id}                      → 204   (revoke another device)
POST   /api/v1/auth/identities/{provider}/link          → 302, links that provider to the signed-in user
DELETE /api/v1/auth/identities/{provider}              → unlink; refused if it is the last one
```

`POST /auth/magic-link` returns `202` whether or not the address is known. A
different response for unknown addresses turns the endpoint into an account
enumeration oracle. It is rate limited per email *and* per IP.

Unlinking the last remaining identity is `409`: it would lock the user out of
their own account.

The explicit link endpoint is how an **untrusted** provider gets attached to an
existing account. A provider whose `trust_email_verified` is false never links
by email address on its own — the user must already be signed in by a trusted
method and link deliberately, which proves control of both sides. Without that
rule, any IdP allowing a user to set an arbitrary unverified address could
claim someone else's account.

### Organisations and members

```
GET    /api/v1/orgs                                    → orgs the caller belongs to
POST   /api/v1/orgs                   { name, slug, timezone }
GET    /api/v1/orgs/{org}
PATCH  /api/v1/orgs/{org}                              (owner)
GET    /api/v1/orgs/{org}/members
POST   /api/v1/orgs/{org}/invitations { email, role }  (owner)
DELETE /api/v1/orgs/{org}/invitations/{id}
PATCH  /api/v1/orgs/{org}/members/{id} { role }        (owner)
DELETE /api/v1/orgs/{org}/members/{id}                 (owner; never the last owner)
```

### SMS settings

One organisation's OVH SMS credentials (ADR-0034, docs/02 §"Async work").
Owner-only, like the rest of "Organisations and members" above, not
owner-and-coordinator like intake sources below: an OVH account is billed to
the organisation and can send to any number under its sender id.

```
GET    /api/v1/orgs/{org}/sms-settings                 (owner)
PUT    /api/v1/orgs/{org}/sms-settings                 (owner)
       { provider, service_name, sender, application_key,
         application_secret?, consumer_key? }
```

`GET` is `404` when nothing has been saved yet — the same "no row" answer
every other single-resource `GET` in this API gives, not a `200` of nulls.
Neither response ever carries `application_secret` or `consumer_key`: both
come back only as `has_application_secret` / `has_consumer_key` booleans,
the same write-only shape a webhook's signing secret already uses under
"Intake" below.

```
→ { provider, service_name, sender, application_key,
    has_application_secret, has_consumer_key, updated_at }
```

`PUT` accepts the same body a fresh save needs, except `application_secret`
and `consumer_key` are optional after the first save: omitted means "keep
whatever is already stored", never "clear it" — a coordinator rotating only
the sender name does not have to retype a secret they cannot see again to
retype. A first-time save with either omitted is `422`. A successful `PUT`
returns the same shape as `GET` plus `operation_id` (ADR-0024) — the
"inverse" this endpoint records is descriptive only and not replayable,
because the previous plaintext secret no longer exists once the write
commits, so `POST …/operations/{id}/undo` refuses it.

### Volunteer pool

```
GET    /api/v1/orgs/{org}/volunteers        ?q=&skill=&active=&limit=&after=
       # q matches display_name_norm (trigram); ordering is sort_name, then name
       # responses carry display_name plus first_name/last_name where known, so
       # the client can disambiguate two volunteers sharing a first name
POST   /api/v1/orgs/{org}/volunteers
GET    /api/v1/orgs/{org}/volunteers/{id}
PATCH  /api/v1/orgs/{org}/volunteers/{id}              (If-Match)
DELETE /api/v1/orgs/{org}/volunteers/{id}              (refuses if assignments exist)
POST   /api/v1/orgs/{org}/volunteers/{id}/anonymize    (GDPR erasure)
GET    /api/v1/orgs/{org}/volunteers/{id}/export       (GDPR portability, JSON)

GET    /api/v1/orgs/{org}/skills
POST   /api/v1/orgs/{org}/skills
PATCH  /api/v1/orgs/{org}/skills/{id}
DELETE /api/v1/orgs/{org}/skills/{id}                  (refuses if required by any shift)

PUT    /api/v1/orgs/{org}/volunteers/{id}/skills       (full replace: [{skill_id, level, valid_until}])
```

`anonymize` rather than `DELETE` for erasure: it nulls the personal fields, sets
`anonymized_at`, revokes that volunteer's form and calendar tokens, deletes
their `submission_payloads`, and rewrites `audit_log.actor_label` along with
`before`/`after` on any row whose `subject_volunteer_id` is theirs — keeping
referential integrity and roster history intact while leaving no personal values
behind ([15 §5](15-privacy-and-retention.md#5-the-one-month-sweep)). Actual
`DELETE` is reserved for records created in error that have no history.

### Import

There is no separate import API. Bulk loading — the initial migration of the
existing spreadsheet included — goes through the intake pipeline below as a
`csv_upload` source, so that one mechanism handles both migration and ongoing
form responses. They are the same problem: an external table of answers that
has to be mapped, reconciled and applied idempotently.

### Festivals

A festival groups several events a coordinator plans and staffs as one whole
(ADR-0032) — optional: most organisations run standalone events and never
create one.

```
GET    /api/v1/orgs/{org}/festivals                    ?status=
POST   /api/v1/orgs/{org}/festivals
       { name, slug, timezone, period: {start, end} }
GET    /api/v1/orgs/{org}/festivals/{festival}                    → Festival, with `events: [Event]` inlined
POST   /api/v1/orgs/{org}/festivals/example                       → loads the worked example (below); 409 if the org already has any festival
```

`POST /festivals` and `POST /events` both respond `201` with the resource
under a named key (`{ "festival": Festival, "operation_id" }` /
`{ "event": Event, "operation_id" }`) rather than the bare resource, so the
operation id sits beside what it describes.

**The worked example.** An org with nothing in it yet can load a real,
structurally complete scenario instead of building one by hand — Soundclash
26 as described in ADR-0032: one festival, six events (Open Air; Montage
Molo; Dub & 2step; Dnb & Dubstep; After; Démontage Molo), each with its own
locations and shifts — plus the edition's volunteers, with their
participations, availability windows and form answers, stored as `applied`
submissions so the submissions page has something real to show. No
assignments: placing people is the work the example is there to try.
Surfaced in the admin UI as an empty-state action, not only as an endpoint.
`POST …/events/example` is the same load, reachable from the events screen;
either route creates the one festival and its six events. Both are `409` when
the organisation is not empty (`festivals` non-empty for the first,
`events` non-empty for the second) and are therefore safe to click twice —
the second click is refused, not a duplicate.

```
POST   /api/v1/orgs/{org}/events/example                          → loads the same worked example; 409 if the org already has any event
```

Reading a festival or its events needs any role; creating one, or loading the
example, needs coordinator or owner (docs/04 §4) — the same line docs/04 §4
already draws at "Events: create, duplicate, archive".

### Events, locations, shifts

```
GET    /api/v1/orgs/{org}/events                       ?status=&festival=
POST   /api/v1/orgs/{org}/events
       { name, slug, timezone, period: {start, end}, festival_id? }
       -- festival_id is OMITTED for a standalone event, never sent as null.
GET    /api/v1/orgs/{org}/events/{event}
       -- `period` is the OPERATIONAL window, and `public_period` the hours
          the doors are open. The latter is set and cleared by a coordinator
          and is absent until somebody states it — never derived from
          `period` (ADR-0044) — so a client that ignores it reads what it
          always read.
PATCH  /api/v1/orgs/{org}/events/{event}               (If-Match)
       -- widening `period` is how the mission board makes room for a shift
          past closing time; it never moves `public_period`.
POST   /api/v1/orgs/{org}/events/{event}/duplicate     { name, new_start_date }
POST   /api/v1/orgs/{org}/events/{event}/archive
DELETE /api/v1/orgs/{org}/events/{event}                (owner; If-Match)

GET    /api/v1/orgs/{org}/events/{event}/locations     → the zone/post tree
POST   /api/v1/orgs/{org}/events/{event}/locations     { kind, name, parent_id?,
                                                         description?, address?,
                                                         exact_address?, latitude?,
                                                         longitude?, min_volunteers?,
                                                         max_volunteers?,
                                                         checked_by_default?,
                                                         adults_only? }
       -- `exact_address`/`latitude`/`longitude` are zone-only, refused on a
          post (a post is reached through its own zone); `latitude` and
          `longitude` must be sent together or not at all.
          `min_volunteers` (integer ≥ 0) and `max_volunteers` (integer ≥ 1)
          are allowed on zones and posts; `max_volunteers` must be at least
          `min_volunteers` when both are known. Each breach is a 422
          validation-failed problem whose `errors` map names the field
          (`max_volunteers` for an inverted pair). Unset bounds are omitted
          from responses, never sent as null or 0.
          `checked_by_default` (default true) and `adults_only` (default
          false) are zone-only (ADR-0041): refused on a post with a 422,
          present on every zone in responses, absent on posts, which take
          their zone's.
PATCH  /api/v1/orgs/{org}/events/{event}/locations/{id} (If-Match)
       -- `description`, `address` and `exact_address` are tri-state:
          omitted leaves the column, null clears it, a string replaces it. A
          blank or all-space string is read as null, because a form posts one
          for a field nobody filled and the schema refuses to store it.
          `latitude`/`longitude` are the same tri-state, sent and cleared
          together. `min_volunteers`/`max_volunteers` are tri-state each,
          independently; a side sent alone is checked against the *stored*
          other side, so raising the floor above an existing ceiling (or the
          reverse) is the same field-named 422 as on create.
          `checked_by_default`/`adults_only` are two-state: a boolean sets,
          omitted or null leaves. Refused on a post.
DELETE /api/v1/orgs/{org}/events/{event}/locations/{id}

GET    /api/v1/orgs/{org}/events/{event}/shifts        ?from=&to=&location=
POST   /api/v1/orgs/{org}/events/{event}/shifts
POST   /api/v1/orgs/{org}/events/{event}/shifts/generate
PATCH  /api/v1/orgs/{org}/events/{event}/shifts/{id}   (If-Match)
DELETE /api/v1/orgs/{org}/events/{event}/shifts/{id}   (refuses if assigned, unless ?force=true)
PUT    /api/v1/orgs/{org}/events/{event}/shifts/{id}/requirements  { [{skill_id, min_count}] }
```

### Shift patterns

How a working window is cut into slots. Organisation-scoped and reused across
events and editions ([ADR-0029](adr/0029-shift-patterns-are-generators-not-constraints.md)).

```
GET    /api/v1/orgs/{org}/shift-patterns               ?archived=
POST   /api/v1/orgs/{org}/shift-patterns
       { name, repeat: "tile"|"once", on_remainder?: "drop"|"truncate",
         segments: [{ kind: "shift"|"gap", duration_minutes, label? }] }
GET    /api/v1/orgs/{org}/shift-patterns/{id}
PUT    /api/v1/orgs/{org}/shift-patterns/{id}          (If-Match; full replace incl. segments)
DELETE /api/v1/orgs/{org}/shift-patterns/{id}          (archives if referenced, deletes if not)
```

Segments are ordered by their position in the array, so the client never sends
an index — `45, 45, 90, 45, 45` is five array entries and the API assigns the
positions. The segment list is an **atomic replacement**, not a per-item bulk:
it is one document, and half a pattern means nothing.

`PUT` on a pattern already attached to a location succeeds and changes nothing
about existing shifts. That is the whole point of
[ADR-0029](adr/0029-shift-patterns-are-generators-not-constraints.md) and the
response says so: `{ "affected_shifts": 0 }`, present precisely so nobody has to
wonder.

Attaching a pattern — through `PATCH …/events/{event}`
(`default_shift_pattern_id`) or `PATCH …/locations/{id}` (`shift_pattern_id`) —
is `422` when the event's `availability_step_minutes` does not divide every
segment duration, naming the step that would work:

```json
{ "type": "https://evp.example/errors/validation",
  "title": "Pattern is finer than the availability picker",
  "status": 422,
  "detail": "Segments of 45 min are not a multiple of the event's 30-minute availability step. Set the step to 15 minutes first.",
  "errors": { "shift_pattern_id": ["requires availability_step_minutes ≤ 15"] } }
```

### Generating shifts

```
POST   /api/v1/orgs/{org}/events/{event}/shifts/generate      (Idempotency-Key)
       { locations: uuid[],
         days: ["2026-07-04", …],           # local dates in the event timezone
         window: { start: "09:00", end: "14:00" },   # local wall-clock times
         pattern_id?: uuid,                 # else the location's, else the event's
         required_count: 1, max_count?: 2,
         dry_run?: false }
       → { operation_id,
           created: [{ shift_id, location_id, period, label? }],
           skipped: [{ location_id, day, reason, detail }],
           remainder_minutes: 60 }
```

Resolution is most-specific-first: the `pattern_id` argument, then
`locations.shift_pattern_id`, then `events.default_shift_pattern_id`. A location
with no pattern anywhere in that chain is `skipped` with `no_pattern` rather
than silently given two-hour slots.

Four things about the walk, each of which is a bug in the naive implementation:

- **It runs in wall-clock time**, in the event's zone, and resolves to instants
  only at the end ([ADR-0019](adr/0019-time-discipline.md)). A window crossing
  spring-forward therefore yields a shift that is genuinely shorter in real
  time, and the daily-hours rule agrees with it.
- **A segment landing on a nonexistent local time is refused**, not shifted by
  an hour. It appears in `skipped` with the offending local time.
- **`once` overrunning the window is `422`**, naming the local time the pattern
  would have ended at. The coordinator's window and their pattern disagree, and
  picking one of them silently is how a schedule becomes wrong.
- **`tile` leaving a remainder** reports `remainder_minutes` and then does what
  the pattern's `on_remainder` says — `drop` by default, `truncate` to emit a
  shorter final shift. It is never rounded up.

`dry_run: true` returns the same body, writes nothing, and is what the bulk
editor renders as a preview. `gap` segments consume window time and appear in
neither list; they are visible in the dry run only as the space between
`created` entries.

Generation is one **operation**, so the whole run has one inverse and `Ctrl+Z`
removes 240 shifts in one action ([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)).
Per-item, it follows the bulk convention: a location whose day already holds
overlapping shifts is reported in `skipped` with `overlaps_existing`, and the
rest are created.

`DELETE` on an event is **owner only** and is refused `409` once a roster
version has been published: at that point schedules have been emailed, and the
honest operation is `archive`, which keeps the history and the audit trail. It
exists for the event created by mistake, and it is the capability
[01 §3](01-product-spec.md#3-personas) reserves to owners.

`duplicate` rebases every shift by the delta between the old and new start
date, preserving local wall-clock times in the event timezone — so an 08:00
shift stays at 08:00 even if the copy crosses a DST boundary. Copying instants
and adding a fixed interval would shift it by an hour; this is a real bug that
the naive implementation will have, and it is called out here so it is not
written that way.

`PATCH …/shifts/{id}` changing `period` can fail `422` with a `double_booked`
violation naming every volunteer who would clash — see the propagation trigger
in [03 — Data model](03-data-model.md#36-assignments--where-the-invariants-live).

### Participation and availability

```
GET    /api/v1/orgs/{org}/events/{event}/participations     ?status=&skill=
POST   /api/v1/orgs/{org}/events/{event}/participations     { volunteer_ids[] }   (bulk enrol)
PATCH  /api/v1/orgs/{org}/events/{event}/participations/{id}
       # per-edition fields write participation_details; status writes the participation
DELETE /api/v1/orgs/{org}/events/{event}/participations/{id}
       # refused while the participation holds assignments — cancel them first

GET    /api/v1/orgs/{org}/events/{event}/participations/{id}/availability
PUT    /api/v1/orgs/{org}/events/{event}/participations/{id}/availability
       { windows: [{ kind, start, end, note }] }
```

The availability `PUT` is a full replace of that participation's
**coordinator-declared** windows, applied in one transaction: every existing
`declared_by`-provenance row is deleted and the submitted set is inserted in
its place, all stamped with the caller's own user id. Incremental add/remove of
overlapping windows is a source of inconsistency for no benefit; the UI edits a
list and saves it.

It is **not** a replace of every window on the participation. A window derived
from a volunteer's form submission (`source_submission_id`) is never touched by
this endpoint, under any circumstances — it is the record of what that person
actually submitted, and `GET .../festivals/{festival}/submissions` (and the
admin submissions view) must always keep showing exactly that, regardless of
what a coordinator later does here. A submitted window may overlap a declared
one in time; when it does, the declared window is the coordinator's override,
not a second contradictory fact, and the exclusion constraint that guards this
table is scoped by provenance for exactly this reason (docs/03 §3.5).

This endpoint requires **coordinator** or above — it is for a coordinator
entering availability by hand, over the phone or from a paper form. The normal
path is the intake pipeline, which derives the same windows from form answers
via slot options. Both record their provenance on `availability_windows`, so it
is always clear which is which; `GET` on this endpoint returns that provenance
(`declared` or `submitted`) on every window, alongside its `id`.

### Assignments — the core write path

```
GET    /api/v1/orgs/{org}/events/{event}/assignments    ?shift=&volunteer=&from=&to=
POST   /api/v1/orgs/{org}/events/{event}/assignments
       { shift_id, participation_id, acknowledge_warnings?: string[] }
PATCH  /api/v1/orgs/{org}/events/{event}/assignments/{id}
       { shift_id }                                     (If-Match — this is a move)
DELETE /api/v1/orgs/{org}/events/{event}/assignments/{id}  (If-Match — cancels, does not erase)

POST   /api/v1/orgs/{org}/events/{event}/assignments/check
       { shift_id, participation_id }
       → { violations: [...] }                          (read-only, no write)

POST   /api/v1/orgs/{org}/events/{event}/assignments/bulk
       { pairs: [{ shift_id, participation_id }], acknowledge_warnings?: string[] }
       → { operation_id, results: [{ shift_id, participation_id,
                                     outcome: "created"|"refused", violations[] }] }
POST   /api/v1/orgs/{org}/events/{event}/assignments/bulk-cancel
       { assignment_ids[] }                             → same shape
POST   /api/v1/orgs/{org}/events/{event}/days/{date}/copy
       { to_date, locations?: uuid[] }                  → same shape
POST   /api/v1/orgs/{org}/events/{event}/assignments/replace
       { from_participation_id, to_participation_id, scope }   → same shape
```

The bulk actions are **per-item**: each pair is evaluated on its own, the ones
that clash are reported with their `violations`, and the rest are created
([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)). Refusing twelve
assignments because the thirteenth volunteer just became busy is the behaviour
that sends a coordinator back to a spreadsheet — the clash is information, not a
failed batch. They back the selection model in
[14 §4](14-accessibility-and-interaction.md#4-mass-modification).

The two-phase interaction:

1. The board calls `/check` on hover or drag-over and renders the warnings
   inline before the drop.
2. `POST /assignments` re-evaluates server-side. **Hard** violations always
   `422`. **Soft** violations `422` unless every returned `code` is present in
   `acknowledge_warnings`, in which case the assignment is created and the
   acknowledged codes are stored on the row.

`/check` is advisory only and its result is never trusted for the write — the
authoritative evaluation happens inside the writing transaction. Checking
twice is not redundant: between hover and drop, another coordinator may have
taken the slot.

### Operations and undo

Every mutating request is one operation, and the operation carries its own
inverse ([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)).

```
GET  /api/v1/orgs/{org}/operations             ?limit=&event=
     → [{ id, kind, summary, actor, created_at, undoable, undone_at }]
POST /api/v1/orgs/{org}/operations/{id}/undo   (Idempotency-Key)
     → { operation_id }   — the undo is itself an operation, with undo_of set
```

Undo applies the stored inverse **through the same domain service** as the
original write, so it passes the constraint engine and cannot reinstate a state
that has since become impossible. Consequently it can fail, and the failure is
the ordinary one: `422` with `violations`.

It is refused `409` when

- a later operation has touched an overlapping set of entities — the world moved
  on, and silently reverting someone else's work is worse than refusing;
- the operation is already undone; or
- the change has been **published**. Publication has sent email, so the
  correction is a new change and a republish, and the UI says so before a
  publish rather than after a failed undo.

Because the stack is server state, `Ctrl+Z` works after a reload and from a
different machine, and an operation is visible to any coordinator in the
organisation rather than only to its author.

### Coverage and reporting

```
GET  /api/v1/orgs/{org}/events/{event}/coverage      ?from=&to=&zone=
     → [{ shift_id, location, period, required, filled, missing_skills[] }]
GET  /api/v1/orgs/{org}/events/{event}/coverage/summary
     → { total_shifts, understaffed, unstaffed, hours_planned, hours_filled }

GET  /api/v1/orgs/{org}/events/{event}/reports/meals        ?service=
GET  /api/v1/orgs/{org}/events/{event}/reports/tshirts
GET  /api/v1/orgs/{org}/events/{event}/reports/accreditation
GET  /api/v1/orgs/{org}/events/{event}/reports/workload     → hours per volunteer
GET  /api/v1/orgs/{org}/events/{event}/reports/non-responders → no submission yet
```

Meals, T-shirts and accreditation read `participation_details`, so a report run
after that event's data has been purged returns empty rather than stale
([ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)). Export the
paperwork during the event, which is when it is needed.

Each report supports `Accept: application/json`, `text/csv`, and
`application/pdf`. PDF is rendered synchronously for small reports and via the
outbox with a download link for large ones.

### Publishing

```
POST /api/v1/orgs/{org}/events/{event}/publish/preview
     → { changed: [{ participation_id, name, added[], removed[], moved[] }],
         unchanged_count }
POST /api/v1/orgs/{org}/events/{event}/publish
     { note?, channels: ["email","sms"], mode: "send" | "test" | "dry_run",
       test_recipient? }                           (Idempotency-Key required)
     → { roster_version, notified, skipped_opted_out, emptied, errors[] }
GET  /api/v1/orgs/{org}/events/{event}/roster-versions
GET  /api/v1/orgs/{org}/events/{event}/roster-versions/{v}/diff?against={v2}
```

`publish/preview` before `publish` means nobody sends 300 messages to find out
what they contained.

Three send modes, all carried over from the spreadsheet, which had learned to
need them:

- `dry_run` — resolve recipients and render every message, send nothing, return
  the log. Answers "who would get what".
- `test` — send the entire run to one address. Answers "does the rendered
  message look right", which a diff preview cannot.
- `send` — the real thing.

`emptied` in the response counts volunteers who previously had shifts and now
have none. They receive an explicit message rather than silence — the case most
likely to make someone turn up when they should not, or not turn up when they
should. `skipped_opted_out` counts volunteers with `notify_email` or
`notify_sms` false.

Adjacent shifts at the same post are merged into one line when a schedule is
rendered, for every channel and export.

Messages greet the volunteer with `coalesce(first_name, display_name)`, so
someone entered as `MARCHAND Aurel` is addressed as "Aurel" once a first name
is known, and by their full stored name until then
([ADR-0012](adr/0012-name-parts-asked-not-parsed.md)).

### The volunteer form

Authoring, versioning and distributing the first-party form
([09 — Volunteer form](09-volunteer-form.md)). A form is scoped to a festival,
a standalone event, or neither ([ADR-0035](adr/0035-a-form-can-cover-a-festival.md)).

```
GET    /api/v1/orgs/{org}/forms                        ?festival=&event=  → { data: [Form], next }
POST   /api/v1/orgs/{org}/forms                        { name, slug, festival_id? | event_id? }
       → 201 Form, with draft version 1 seeded (below)
GET    /api/v1/orgs/{org}/forms/{form}                 → Form
PATCH  /api/v1/orgs/{org}/forms/{form}                 (If-Match)
       { name?, public_open?, default_locale? }
DELETE /api/v1/orgs/{org}/forms/{form}                 (If-Match) → 200 { operation_id };
                                                         409 once any version is published

GET    /api/v1/orgs/{org}/forms/{form}/mission-options → { options: [MissionOption] }
POST   /api/v1/orgs/{org}/forms/{form}/versions        → 201 new draft, copied from live
                                                         (409 if a draft already exists, or
                                                          nothing is live to copy)
GET    /api/v1/orgs/{org}/forms/{form}/versions/{v}    → FormVersion
PUT    /api/v1/orgs/{org}/forms/{form}/versions/{v}    (If-Match)
       { privacy_notice_version?, questions: [QuestionInput] }  (drafts only; full replace)
POST   /api/v1/orgs/{org}/forms/{form}/versions/{v}/publish     (If-Match)
       → FormVersion, now live and immutable; 422 { problems: [PublishProblem] }
```

Shapes (JSON, `snake_case`, ids as strings, instants RFC 3339 UTC):

```ts
Form = {
  id, name, slug, festival_id: string | null, event_id: string | null,
  public_open: boolean, default_locale: 'fr' | 'en',
  live_version_id: string | null,
  versions: [{ id, version: number, published_at: string | null, question_count: number }],
  version: number                      // the form row's own concurrency token (ETag)
}
FormVersion = {
  id, form_id, version: number, published_at: string | null,
  privacy_notice_version: string | null,
  questions: [Question],
  etag_version: number                 // bumped by every PUT; the ETag of the draft
}
Localized = { fr: string, en?: string }
Option = { value: string, label: Localized, skill_id?: string,
           checked_by_default: boolean, adults_only: boolean }
  -- the two flags are `missions` only, read-only: stamped from the zones on
     every PUT and at publish, whatever the client sends (ADR-0041). An
     adults-only option is never checked_by_default. The public form serves
     them as well.
Question = {
  id, position: number,
  kind: 'short_text' | 'long_text' | 'email' | 'phone' | 'date'
      | 'single_choice' | 'multi_choice' | 'boolean'
      | 'availability' | 'missions' | 'consent' | 'section',
  target_path: TargetPath | null,       // null = custom question (ADR-0037)
  consent_purpose: 'processing' | 'pool_retention' | 'commitment' | null,
  label: Localized, help_text: Localized | null,
  options: Option[] | null,
  is_required: boolean, is_sensitive: boolean,
  builtin: boolean                      // derived: target_path is set, or kind is
                                        // availability | missions | consent
}
QuestionInput = Question without id / position / builtin   // order = array order
TargetPath = 'volunteer.first_name' | 'volunteer.last_name' | 'volunteer.email'
           | 'volunteer.phone' | 'volunteer.tshirt_size' | 'volunteer.dietary'
           | 'volunteer.notes'
MissionOption = { value: string, label: string, event_ids: string[],
                  checked_by_default: boolean, adults_only: boolean }
                                        // value = folded name key: trimmed and lowercased,
                                        // exactly as missionCatalog.ts folds (inner
                                        // whitespace is NOT collapsed)
                                        // adults_only if any of its zones is;
                                        // checked_by_default only if every zone is and
                                        // none is adults-only. A post counts as its zone.
PublishProblem = { position: number | null, code: string, message: string }
                                        // position: 0-based index into questions;
                                        // null for something missing from the whole form
```

Wire details:

- `{v}` accepts either the version's id or its number.
- A write responds with the `Form` or `FormVersion` itself plus a top-level
  `operation_id` — not wrapped. The `ETag` header carries `version` /
  `etag_version`.
- Question ids are **not stable across a `PUT`**: the list is replaced, so
  every save issues new ids. Clients key edits on their own keys.
- `privacy_notice_version` on `PUT`: omitted leaves it unchanged, `null`
  clears it.
- Publishing bumps the form's `ETag` too, because it sets `live_version_id`.
- `slug` is lowercase letters, digits and inner hyphens, at most 80
  characters; `name` must not be blank; sending both `festival_id` and
  `event_id` is `422`.
- `422` bodies are `application/problem+json` of type `…/validation-failed`
  with `problems: [PublishProblem]`. `PUT` codes: `duplicate_target`,
  `duplicate_availability`, `duplicate_missions`, `duplicate_consent_purpose`,
  `pool_retention_required`, `options_required`, `options_not_allowed`,
  `target_required`, `target_not_allowed`, `target_kind_mismatch` (an `email`
  question must target `volunteer.email` and only it; likewise `phone`),
  `consent_purpose_required`, `consent_purpose_not_allowed`,
  `label_missing_fr`, `scope_required`. `publish` adds
  `processing_consent_missing`, `processing_consent_optional`,
  `commitment_missing`, `commitment_optional`,
  `first_name_missing`, `first_name_optional`, `email_missing`,
  `email_optional`, `option_value_blank`, `duplicate_option_value`,
  `mission_option_unresolved`, `label_missing_locale`. An unknown `kind` or
  `target_path` never reaches validation: it is a `422` of type
  `…/invalid-request`.

**The seeded draft.** `POST …/forms` creates version 1 with, in order: a
`section` (welcome copy), `first_name` (required, locked required), `last_name`
(optional), `email` (required, locked required), `phone` (optional), then — for
a scoped form — `availability` (required) and `missions` (options from
`mission-options`), then the `commitment` (required, naming the organisation,
[ADR-0040](adr/0040-volunteer-commitment-question.md)) and the `processing`
consent (required). The coordinator edits from there. Built-ins can be
reordered and reworded; `first_name`, `email`, the `commitment` and the
`processing` consent cannot be removed or made optional.

A published version cannot be edited — `PUT` on it is `409`. That is the
mechanism, not a restriction: submissions reference the version they
answered, so freezing it is what makes editing a live form safe.

`PUT` refuses (`422`) what a constraint would refuse anyway, with the position
named: a duplicate `target_path`, a second `availability` or `missions`, a
second consent of one purpose, a required `pool_retention`, options on a kind
that takes none (or none on one that needs them), an `email`/`phone` with no
target, a label with no `fr`, and `availability`/`missions` on an unscoped form.

`publish` additionally validates the whole-set invariants no constraint can
express: **exactly one `processing` consent question and exactly one
`commitment` question, each marked required**;
required `volunteer.first_name` and `volunteer.email` questions
([ADR-0037](adr/0037-custom-answers-are-kept-per-participation.md)); every
option `value` unique within its question; every `missions` option still
resolving to at least one location in scope; and every label present in the
form's locales. It is `422` with the specific omissions otherwise. Publishing
sets `forms.live_version_id`; the previous live version stays, frozen, for the
submissions that answered it.

A `pool_retention` consent question is **optional and must not be required**
([ADR-0025](adr/0025-two-consents-processing-and-pool-retention.md)) — a form
with none simply collects no pool consent, so those volunteers are anonymised at
the event-purge boundary. "At most one `availability` question", "at most one
`missions` question" and "at most one consent per purpose" are partial unique
indexes rather than publish checks, so they hold across drafts too.

Every mutating route returns an `operation_id` and records its inverse
([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)), like the rest of
the planner. Undoing a publish is refused once the version has submissions.

Token links:

```
POST   /api/v1/orgs/{org}/forms/{form}/invites
       { volunteer_ids[] | participation_filter }      (Idempotency-Key)
       → { issued, skipped }   — tokens are emailed, never returned
GET    /api/v1/orgs/{org}/forms/{form}/invites         → status per volunteer, no tokens
POST   /api/v1/orgs/{org}/forms/{form}/invites/{id}/resend
DELETE /api/v1/orgs/{org}/forms/{form}/invites/{id}    → revokes
POST   /api/v1/orgs/{org}/forms/{form}/invites/rotate  → revokes and reissues all
```

Tokens are never returned by the API, only emailed. A coordinator who needs to
hand someone their link resends it. This keeps the token out of browser
history, screenshots and the audit log.

### Intake

Configuring a source, mapping its fields, and reviewing what arrives. Full
design in [08 — Volunteer intake](08-volunteer-intake.md).

```
GET    /api/v1/orgs/{org}/intake/sources                  ?event=&active=
POST   /api/v1/orgs/{org}/intake/sources
       { kind, name, event_id?, config }
       → for kind=api: { api_key }  — returned once, never again
       → for kind=webhook: { webhook_url, signing_secret }  — likewise
PATCH  /api/v1/orgs/{org}/intake/sources/{src}            (If-Match)
DELETE /api/v1/orgs/{org}/intake/sources/{src}            (keeps its submissions)
POST   /api/v1/orgs/{org}/intake/sources/{src}/rotate-secret
POST   /api/v1/orgs/{org}/intake/sources/{src}/poll       (google_sheet: poll now)
POST   /api/v1/orgs/{org}/intake/sources/{src}/test       (validate config, read headers only)
```

Field discovery and mapping:

```
GET    /api/v1/orgs/{org}/intake/sources/{src}/fields
       → [{ id, external_key, external_label, data_type, observed_values,
             is_present, mappings[] }]
GET    /api/v1/orgs/{org}/intake/sources/{src}/mappings
PUT    /api/v1/orgs/{org}/intake/sources/{src}/mappings
       { mappings: [...], value_mappings: [...] }         (full replace, transactional)
POST   /api/v1/orgs/{org}/intake/sources/{src}/mappings/preview
       { mappings, value_mappings, limit: 20 }
       → { rows: [{ external_id, raw, derived, errors[] }], unmapped_fields[] }
```

`mappings/preview` runs the candidate mapping over real stored submissions
without writing anything. It is the answer to "how do we know the mapping is
right" — the coordinator sees the derived record beside the raw answer, for
twenty actual rows, before saving.

It is explicitly **not** a licence to split names. The argument that a preview
makes mangled names acceptable is the one
[ADR-0011](adr/0011-single-display-name-not-first-last.md) records as its own
mistake: against the real pool a split is wrong for a *majority* of rows, and no
amount of previewing makes inventing a surname for a mononym correct. A combined
name column maps whole to `display_name`; parts are asked, never derived
([ADR-0012](adr/0012-name-parts-asked-not-parsed.md)). Where preview earns its
keep is value mappings, dates and phone formats.

Slot options — the checkbox-label-to-time-range catalogue:

```
GET    /api/v1/orgs/{org}/events/{event}/intake/slot-options
PUT    /api/v1/orgs/{org}/events/{event}/intake/slot-options
       { options: [{ label, start, end, sort_order }] }
GET    /api/v1/orgs/{org}/events/{event}/intake/slot-options/form-choices
       → { labels: [...] }    — paste straight into the form builder
```

Batches and submissions:

```
POST   /api/v1/orgs/{org}/intake/sources/{src}/batches    multipart: file
       → { batch_id, outcome, row_count, drift, unmapped_fields[] }
GET    /api/v1/orgs/{org}/intake/sources/{src}/batches
GET    /api/v1/orgs/{org}/intake/batches/{batch}
POST   /api/v1/orgs/{org}/intake/batches/{batch}/apply    (Idempotency-Key)
       → { created, updated, review, rejected }
POST   /api/v1/orgs/{org}/intake/batches/{batch}/replay
       → re-derives from stored raw payloads under the current mapping

GET    /api/v1/orgs/{org}/intake/submissions              ?state=&source=&event=
GET    /api/v1/orgs/{org}/intake/submissions/{sub}        → raw + derived + candidates
POST   /api/v1/orgs/{org}/intake/submissions/{sub}/resolve
       { action: "match", volunteer_id }
       | { action: "create_new" }
       | { action: "reject", reason }
       | { action: "reconcile" }   # run the ladder again: for one the timing
                                   # floor held, never compared with the pool
```

Built so far: `GET …/intake/submissions?state=needs_review` (the admin's
"Réponses à vérifier" page, under the submissions) and `…/resolve`, coordinator
or above. A resolution is an ADR-0024 operation; `409` when someone else
resolved it first. `create_new` on an address that already belongs to another
volunteer creates them without it (`email_withheld: true`, ADR-0028), and
`match` never moves an address off its owner.

A batch whose `outcome` is `held` or `refused` cannot be applied — `apply`
returns `422` naming the drift. Mapping the new fields (or marking them
`ignore`) re-evaluates the batch.

`replay` is the mapping-repair path, and the reason raw payloads are stored
immutably. It is idempotent by construction: it recomputes derived values for
submissions that already exist, so running it twice changes nothing the second
time.

### Public and unauthenticated

Outside the session model.

```
GET   /api/v1/meta                             # version, commit, source URL
GET   /api/v1/public/forms/{slug}              # ?t={token} — the form to render
POST  /api/v1/public/forms/{slug}/submissions  # ?t={token} — an answer

# the volunteer's own data, reached by their token link (ADR-0027)
GET   /api/v1/public/me                  ?t=   # what we hold, as the form shows it
PATCH /api/v1/public/me                  ?t=   # correct name parts, contact, size, dietary
PATCH /api/v1/public/me/preferences      ?t=   # notify_email, notify_sms, pool consent
POST  /api/v1/public/me/export           ?t=   # 202 — the full export is emailed
POST  /api/v1/public/me/erasure          ?t=   # 202 — sends a confirmation to the address on record
POST  /api/v1/public/erasure/confirm           # { token } — executes it

POST  /api/v1/intake/hooks/{source_id}         # HMAC-signed provider webhook
POST  /api/v1/intake/{source_id}/submissions   # generic, X-API-Key
GET   /calendar/{token}.ics                    # one participation's shifts
```

`/calendar/…` is the one route deliberately outside `/api/v1`: it is pasted into
calendar clients by hand and lives for years, so it gets a short, stable path
that no future API version renumbers.

`GET /api/v1/meta` is unauthenticated and uncacheable-by-default:

```json
{ "version": "0.4.1", "commit": "a1b2c3d", "source_url": "https://github.com/…" }
```

It exists to satisfy AGPL §13, which obliges a deployment to offer its source
to anyone interacting with it over a network — volunteers filling in the form
included, not just coordinators. `source_url` comes from `EVP_SOURCE_URL`, so a
modified deployment points at its own fork. Both frontends render it, and
removing those links puts the operator out of compliance.

`GET /public/forms/{slug}` returns the live version's questions, the events in
scope — for a festival form, every event of the festival in period order, each
with its name, days and `availability_step_minutes`
([ADR-0035](adr/0035-a-form-can-cover-a-festival.md)) — the suggested slot
chips, and the resolved locale. With a valid `?t=`, it also returns **prefill** values for
that volunteer and their previous answers; without one, it returns `404` if
`public_open` is false. A revoked token and an unknown slug return the same
generic response — neither confirms that the other exists.

`POST …/submissions` validates against the `form_version` the client claims to
have rendered; a stale version is `409` with the current form, so the volunteer
re-renders rather than submitting answers to questions that no longer exist. It
is rate limited per IP and per claimed email, applies the honeypot, the
proof-of-work captcha (`captcha` — served with the form, `422 …/captcha-failed`
when missing, wrong, expired or spent;
[ADR-0043](adr/0043-form-captcha-is-a-self-hosted-proof-of-work.md)) and the
timing checks from [09 §5](09-volunteer-form.md#5-anti-abuse-on-the-public-route), and
returns `202` — the submission is stored, then mapped and reconciled on the
same transaction
([ADR-0042](adr/0042-public-submissions-reconciled-inline.md)). A reconcile
that fails rolls back to its own savepoint and leaves the submission stored
and `received`, for `evp-cli reconcile` to retry.

With a token, identity is certain and the submission applies directly. Without
one, it enters the reconciliation ladder and, if ambiguous, the review queue.
The response does not reveal which happened, and never confirms whether an
email address is already known.

The webhook verifies its HMAC signature, persists the raw body, and returns
`202` — mapping happens in the worker, so a slow mapper never causes a provider
retry. An invalid signature is `401` with the body discarded.

The ICS feed is a capability URL: a high-entropy token, stored hashed,
delivered in the schedule email, revocable and rotatable by a coordinator. It is
keyed on a **participation**, so it exposes one volunteer's shifts at one event
and stops working when that event's data is purged
([ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)). It is not
authentication and is not treated as such — it grants read access to that one
calendar and nothing else.

### The volunteer's own data

There is no volunteer **session** — no password, no account lifecycle, nothing
to reset ([ADR-0008](adr/0008-no-volunteer-authentication-in-v1.md)). There
are, however, volunteer writes: they are scoped by a capability token to exactly
one volunteer's own record ([ADR-0027](adr/0027-volunteer-self-service-rights.md)),
because a data subject who cannot correct or erase their own data has rights
only in principle.

The `/public/me` routes are reachable with a valid `?t=` and nothing else. What
they may do, and may not:

- **Correction** is limited to the volunteer's own pool fields. It cannot touch
  `locked_fields` a coordinator has fixed by hand — the response says which
  fields were declined and invites a message to the organisation — and it cannot
  reach assignments, participation status, or anybody else's record.
- **Answers** to a live form still go through
  `POST /public/forms/{slug}/submissions`, which remains the normal way to give
  or revise availability. The `/me` routes exist because rights must work when
  no form is live, which is most of the year.
- **Erasure needs two proofs** ([ADR-0018](adr/0018-purpose-based-retention.md)):
  holding the link, and receiving mail at the address on record. `POST
  /me/erasure` only ever returns `202` and sends the confirmation; the
  confirmation link executes it. A forwarded link cannot delete anybody.
- **Withdrawal and opt-out need no confirmation.** Stopping processing is not
  destructive, so it is frictionless in a way deletion is not. Withdrawing pool
  consent runs the deletion the sweep would have performed.
- **The full export is emailed, not returned inline**, so one request on a
  forwarded link does not hand over a complete personal record. `GET /me`
  returns only what the prefilled form already showed.
- Rate limited per token *and* per IP, `Referrer-Policy: no-referrer`, and every
  action is written to `audit_log` with the token as the actor — so the log
  distinguishes a change the volunteer made from one a coordinator made for
  them. A revoked token and an unknown one return the same generic response.

What remains out of scope is anything a volunteer would *do* rather than
*tell*: claiming shifts, swapping them, confirming attendance. Those need an
identity stronger than a forwardable link, and they revisit ADR-0008 rather than
extending it.

## 4. Permissions

Enforced in the org extractor, before any handler runs.

| Endpoint group | owner | coordinator | zone_lead |
| --- | :-: | :-: | :-: |
| Org settings, members, invites | ✅ | — | — |
| Events: create, duplicate, archive | ✅ | ✅ | — |
| Locations, shifts | ✅ | ✅ | read |
| Shift patterns | ✅ | ✅ | read |
| Volunteer pool, skills | ✅ | ✅ | read |
| Assignments | ✅ | ✅ | own zones |
| Coverage, reports | ✅ | ✅ | own zones |
| Publish | ✅ | ✅ | — |
| Forms: author, publish, issue invites | ✅ | ✅ | — |
| Intake sources, secrets, mappings | ✅ | ✅ | — |
| Intake batches: upload, apply, replay | ✅ | ✅ | — |
| Intake review queue: resolve | ✅ | ✅ | — |
| Sensitive fields (`dietary`, `notes`) | ✅ | ✅ | — |
| Undo an operation | ✅ | ✅ | own zones |
| Delete an event | ✅ | — | — |
| Audit log | ✅ | read | — |

There is no volunteer role: volunteers do not authenticate
([ADR-0008](adr/0008-no-volunteer-authentication-in-v1.md)).

Zone leads are scoped by a `zone_lead_scopes(membership_id, location_id)`
table; their assignment writes are additionally filtered by an RLS policy, so
the scope holds even if a handler forgets to check it.

Sensitive-field redaction happens in the DTO serialiser, not the query, so
there is exactly one place where "who can see dietary requirements" is decided.

`participation_details.is_adult` is deliberately **not** in that set. Zone leads
assign within their zones, and a warning whose reason is hidden from the person
acting on it is theatre — so whoever can assign can see the declaration behind
`minor_night_shift` ([ADR-0023](adr/0023-adult-declaration-boolean.md)). It is
one boolean, event-tier, and purged with the edition.
