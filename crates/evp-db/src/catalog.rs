// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Festivals, events, locations, shifts, and the worked example.
//!
//! Every statement in this module runs against a connection that has already
//! had `app.current_org_id` / `app.current_role` set with `SET LOCAL` — that
//! happens once, in [`crate::PgConnection`]-holding callers (`evp-api::org`),
//! not here. RLS is the enforcing layer (docs/03 §4); the explicit `org_id`
//! predicates below are belt-and-braces, matching docs/02 §4.
//!
//! Like `auth.rs`, every query is `sqlx::query`/`query_as` rather than the
//! `query!` macros — no committed `.sqlx` cache exists yet (see that module's
//! doc comment for the full reasoning).
//!
//! `tstzrange` values are never bound or decoded as a Rust range type.
//! Instead every statement below binds two `jiff_sqlx::Timestamp` parameters
//! and builds `tstzrange($a, $b)` in SQL, and reads `lower(period)` /
//! `upper(period)` back as two columns. `PgRange<T>`'s `Type`/`Encode`
//! support in `sqlx-postgres` is keyed to a fixed set of built-in range OIDs
//! by inner type, and threading a working impl through `jiff_sqlx::Timestamp`
//! is not worth it next to two extra bind parameters.

use jiff::Timestamp;
use jiff_sqlx::ToSqlx as _;
use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;

/// `event_status`, decoded as text for the same reason
/// [`crate::auth::Membership::role`] is: adding a status value must not turn
/// every row already in that state into a decode error.
pub type Status = String;

#[derive(Debug, Clone)]
pub struct Festival {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub slug: String,
    pub timezone: String,
    pub period_start: Timestamp,
    pub period_end: Timestamp,
    pub status: Status,
    pub event_count: i64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub version: i32,
}

#[derive(Debug, Clone)]
pub struct Event {
    pub id: Uuid,
    pub org_id: Uuid,
    pub festival_id: Option<Uuid>,
    pub name: String,
    pub slug: String,
    pub timezone: String,
    pub period_start: Timestamp,
    pub period_end: Timestamp,
    /// When the doors are open to the public, if that has been decided.
    ///
    /// Stated, never inferred: `None` means nobody has said, not "the same as
    /// `period`". The two are different facts — `period` is every hour the
    /// edition occupies, doors are the hours it is open — and only one of
    /// them is derivable from the shifts. Plenty of editions never publish a
    /// door time at all, which is why this stays optional rather than being
    /// filled in with a guess the coordinator would then have to notice and
    /// correct.
    pub public_period_start: Option<Timestamp>,
    pub public_period_end: Option<Timestamp>,
    pub status: Status,
    /// Index into the 64-colour event palette
    /// (`packages/shared/src/eventColors.ts`), so a festival's days are
    /// distinguishable wherever they are drawn together. Assigned on insert
    /// from whatever the event's siblings are not using.
    pub color: i16,
    /// The granularity of the availability picker for this edition, in
    /// minutes. Load-bearing beyond the picker: a shift pattern whose segments
    /// it does not divide cannot be attached to the event, because every shift
    /// generated from one would be unfillable (docs/04 §"Shift patterns").
    pub availability_step_minutes: i32,
    /// The division this event's locations inherit unless they name their own
    /// (ADR-0029). The last link in `shifts/generate`'s most-specific-first
    /// resolution chain.
    pub default_shift_pattern_id: Option<Uuid>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub version: i32,
}

/// What every mutating endpoint returns alongside its resource (ADR-0024):
/// the id of the `operations` row recording this request's inverse.
#[derive(Debug, Clone, Copy)]
pub struct OperationId(pub Uuid);

fn decode_festival(row: &sqlx::postgres::PgRow) -> Result<Festival, DbError> {
    Ok(Festival {
        id: row.try_get("id").map_err(DbError::Query)?,
        org_id: row.try_get("org_id").map_err(DbError::Query)?,
        name: row.try_get("name").map_err(DbError::Query)?,
        slug: row.try_get("slug").map_err(DbError::Query)?,
        timezone: row.try_get("timezone").map_err(DbError::Query)?,
        period_start: row
            .try_get::<jiff_sqlx::Timestamp, _>("period_start")
            .map_err(DbError::Query)?
            .to_jiff(),
        period_end: row
            .try_get::<jiff_sqlx::Timestamp, _>("period_end")
            .map_err(DbError::Query)?
            .to_jiff(),
        status: row.try_get("status").map_err(DbError::Query)?,
        event_count: row.try_get("event_count").map_err(DbError::Query)?,
        created_at: row
            .try_get::<jiff_sqlx::Timestamp, _>("created_at")
            .map_err(DbError::Query)?
            .to_jiff(),
        updated_at: row
            .try_get::<jiff_sqlx::Timestamp, _>("updated_at")
            .map_err(DbError::Query)?
            .to_jiff(),
        version: row.try_get("version").map_err(DbError::Query)?,
    })
}

fn decode_event(row: &sqlx::postgres::PgRow) -> Result<Event, DbError> {
    Ok(Event {
        id: row.try_get("id").map_err(DbError::Query)?,
        org_id: row.try_get("org_id").map_err(DbError::Query)?,
        festival_id: row.try_get("festival_id").map_err(DbError::Query)?,
        name: row.try_get("name").map_err(DbError::Query)?,
        slug: row.try_get("slug").map_err(DbError::Query)?,
        timezone: row.try_get("timezone").map_err(DbError::Query)?,
        period_start: row
            .try_get::<jiff_sqlx::Timestamp, _>("period_start")
            .map_err(DbError::Query)?
            .to_jiff(),
        period_end: row
            .try_get::<jiff_sqlx::Timestamp, _>("period_end")
            .map_err(DbError::Query)?
            .to_jiff(),
        public_period_start: row
            .try_get::<Option<jiff_sqlx::Timestamp>, _>("public_period_start")
            .map_err(DbError::Query)?
            .map(jiff_sqlx::Timestamp::to_jiff),
        public_period_end: row
            .try_get::<Option<jiff_sqlx::Timestamp>, _>("public_period_end")
            .map_err(DbError::Query)?
            .map(jiff_sqlx::Timestamp::to_jiff),
        status: row.try_get("status").map_err(DbError::Query)?,
        color: row.try_get("color").map_err(DbError::Query)?,
        availability_step_minutes: row
            .try_get("availability_step_minutes")
            .map_err(DbError::Query)?,
        default_shift_pattern_id: row
            .try_get("default_shift_pattern_id")
            .map_err(DbError::Query)?,
        created_at: row
            .try_get::<jiff_sqlx::Timestamp, _>("created_at")
            .map_err(DbError::Query)?
            .to_jiff(),
        updated_at: row
            .try_get::<jiff_sqlx::Timestamp, _>("updated_at")
            .map_err(DbError::Query)?
            .to_jiff(),
        version: row.try_get("version").map_err(DbError::Query)?,
    })
}

/// Every festival in the caller's organisation, optionally filtered by
/// status, newest first.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn list_festivals(
    conn: &mut PgConnection,
    org_id: Uuid,
    status: Option<&str>,
) -> Result<Vec<Festival>, DbError> {
    let rows = sqlx::query(
        "SELECT f.id, f.org_id, f.name, f.slug::text AS slug, f.timezone, \
                lower(f.period) AS period_start, upper(f.period) AS period_end, \
                f.status::text AS status, f.created_at, f.updated_at, f.version, \
                (SELECT count(*) FROM events e WHERE e.festival_id = f.id)::bigint AS event_count \
           FROM festivals f \
          WHERE f.org_id = $1 AND ($2::text IS NULL OR f.status::text = $2) \
          ORDER BY f.created_at DESC",
    )
    .bind(org_id)
    .bind(status)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    rows.iter().map(decode_festival).collect()
}

/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn get_festival(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
) -> Result<Option<Festival>, DbError> {
    let row = sqlx::query(
        "SELECT f.id, f.org_id, f.name, f.slug::text AS slug, f.timezone, \
                lower(f.period) AS period_start, upper(f.period) AS period_end, \
                f.status::text AS status, f.created_at, f.updated_at, f.version, \
                (SELECT count(*) FROM events e WHERE e.festival_id = f.id)::bigint AS event_count \
           FROM festivals f \
          WHERE f.org_id = $1 AND f.id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.as_ref().map(decode_festival).transpose()
}

/// Inserts the row only — no `operations` entry. [`create_festival`] is the
/// public entry point; this is split out because [`create_example`] needs the
/// insert without a *second* operation record for the same request.
async fn insert_festival(
    conn: &mut PgConnection,
    id: Uuid,
    org_id: Uuid,
    name: &str,
    slug: &str,
    timezone: &str,
    period: (Timestamp, Timestamp),
) -> Result<Festival, DbError> {
    let row = sqlx::query(
        "WITH inserted AS ( \
           INSERT INTO festivals (id, org_id, name, slug, timezone, period) \
           VALUES ($1, $2, $3, $4::citext, $5, tstzrange($6, $7)) \
           RETURNING * \
         ) \
         SELECT inserted.id, inserted.org_id, inserted.name, inserted.slug::text AS slug, \
                inserted.timezone, lower(inserted.period) AS period_start, \
                upper(inserted.period) AS period_end, inserted.status::text AS status, \
                inserted.created_at, inserted.updated_at, inserted.version, 0::bigint AS event_count \
         FROM inserted",
    )
    .bind(id)
        .bind(org_id)
        .bind(name)
        .bind(slug)
        .bind(timezone)
        .bind(period.0.to_sqlx())
        .bind(period.1.to_sqlx())
        .fetch_one(&mut *conn)
        .await
        .map_err(DbError::Query)?;
    decode_festival(&row)
}

/// Creates a festival and records the operation whose inverse deletes it
/// (ADR-0024). Deleting a fresh festival with no events is always safe, which
/// is what makes "delete this festival" a sound inverse for "create it".
///
/// # Errors
///
/// [`DbError::Query`] on a constraint violation (unknown timezone, empty or
/// inverted period, duplicate slug) or any other statement failure.
#[expect(
    clippy::too_many_arguments,
    reason = "mirrors the four request fields plus the actor/id the caller already resolved; splitting them into a struct here would only move the same seven values one level"
)]
pub async fn create_festival(
    conn: &mut PgConnection,
    id: Uuid,
    org_id: Uuid,
    actor_id: Uuid,
    name: &str,
    slug: &str,
    timezone: &str,
    period: (Timestamp, Timestamp),
) -> Result<(Festival, OperationId), DbError> {
    let festival = insert_festival(conn, id, org_id, name, slug, timezone, period).await?;

    let operation_id = record_operation(
        conn,
        org_id,
        None,
        actor_id,
        "festival.create",
        serde_json::json!({ "name": festival.name, "slug": festival.slug }),
        serde_json::json!({ "command": "delete_festival", "festival_id": festival.id }),
        &[festival.id],
    )
    .await?;

    Ok((festival, operation_id))
}

/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn list_events(
    conn: &mut PgConnection,
    org_id: Uuid,
    status: Option<&str>,
    festival_id: Option<Uuid>,
) -> Result<Vec<Event>, DbError> {
    let rows = sqlx::query(
        "SELECT id, org_id, festival_id, name, slug::text AS slug, timezone, \
                lower(period) AS period_start, upper(period) AS period_end, \
                lower(public_period) AS public_period_start, \
                upper(public_period) AS public_period_end, \
                status::text AS status, color, availability_step_minutes, \
                   default_shift_pattern_id, created_at, updated_at, version \
           FROM events \
          WHERE org_id = $1 AND ($2::text IS NULL OR status::text = $2) \
            AND ($3::uuid IS NULL OR festival_id = $3) \
          ORDER BY created_at DESC",
    )
    .bind(org_id)
    .bind(status)
    .bind(festival_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    rows.iter().map(decode_event).collect()
}

/// Events belonging to one festival, in no particular guaranteed order beyond
/// creation time — used to inline `events` on `GET …/festivals/{festival}`.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn list_events_for_festival(
    conn: &mut PgConnection,
    org_id: Uuid,
    festival_id: Uuid,
) -> Result<Vec<Event>, DbError> {
    list_events(conn, org_id, None, Some(festival_id)).await
}

/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn get_event(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
) -> Result<Option<Event>, DbError> {
    let row = sqlx::query(
        "SELECT id, org_id, festival_id, name, slug::text AS slug, timezone, \
                lower(period) AS period_start, upper(period) AS period_end, \
                lower(public_period) AS public_period_start, \
                upper(public_period) AS public_period_end, \
                status::text AS status, color, availability_step_minutes, \
                   default_shift_pattern_id, created_at, updated_at, version \
           FROM events WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.as_ref().map(decode_event).transpose()
}

#[expect(
    clippy::too_many_arguments,
    reason = "mirrors the request fields the API layer already validated"
)]
async fn insert_event(
    conn: &mut PgConnection,
    id: Uuid,
    org_id: Uuid,
    festival_id: Option<Uuid>,
    name: &str,
    slug: &str,
    timezone: &str,
    period: (Timestamp, Timestamp),
) -> Result<Event, DbError> {
    let row = sqlx::query(
        // The colour is the lowest palette index this event's siblings are not
        // already using. Siblings, not "every event in the org": a festival's
        // days are what get drawn next to each other, and making the whole
        // organisation share one counter would have year three of a festival
        // start at colour 14 for no reason anyone could see. Standalone events
        // (`festival_id IS NULL`) are siblings of each other, which is what
        // `IS NOT DISTINCT FROM` says and `=` would not.
        //
        // Past 64 siblings the subquery finds nothing and everyone gets 0.
        // That is the honest answer — the palette is 64 colours because 64 is
        // as many as clear the contrast bar, and a 65th day genuinely cannot
        // have a colour of its own.
        "INSERT INTO events (id, org_id, festival_id, name, slug, timezone, period, color) \
         VALUES ($1, $2, $3, $4, $5::citext, $6, tstzrange($7, $8), \
                 coalesce((SELECT free.i FROM generate_series(0, 63) AS free(i) \
                            WHERE NOT EXISTS (SELECT 1 FROM events sibling \
                                               WHERE sibling.org_id = $2 \
                                                 AND sibling.festival_id IS NOT DISTINCT FROM $3 \
                                                 AND sibling.color = free.i) \
                            ORDER BY free.i LIMIT 1), 0)) \
         RETURNING id, org_id, festival_id, name, slug::text AS slug, timezone, \
                   lower(period) AS period_start, upper(period) AS period_end, \
                   lower(public_period) AS public_period_start, \
                   upper(public_period) AS public_period_end, \
                   status::text AS status, color, availability_step_minutes, \
                   default_shift_pattern_id, created_at, updated_at, version",
    )
    .bind(id)
    .bind(org_id)
    .bind(festival_id)
    .bind(name)
    .bind(slug)
    .bind(timezone)
    .bind(period.0.to_sqlx())
    .bind(period.1.to_sqlx())
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    decode_event(&row)
}

/// Creates a standalone or festival-member event and records the operation
/// whose inverse deletes it.
///
/// # Errors
///
/// [`DbError::Query`] on a constraint violation (unknown timezone, empty or
/// inverted period, duplicate slug, or a `festival_id` from another
/// organisation) or any other statement failure.
#[expect(
    clippy::too_many_arguments,
    reason = "mirrors the five request fields plus the actor/id the caller already resolved"
)]
pub async fn create_event(
    conn: &mut PgConnection,
    id: Uuid,
    org_id: Uuid,
    actor_id: Uuid,
    festival_id: Option<Uuid>,
    name: &str,
    slug: &str,
    timezone: &str,
    period: (Timestamp, Timestamp),
) -> Result<(Event, OperationId), DbError> {
    let event = insert_event(conn, id, org_id, festival_id, name, slug, timezone, period).await?;

    let operation_id = record_operation(
        conn,
        org_id,
        Some(event.id),
        actor_id,
        "event.create",
        serde_json::json!({ "name": event.name, "slug": event.slug }),
        serde_json::json!({ "command": "delete_event", "event_id": event.id }),
        &[event.id],
    )
    .await?;

    Ok((event, operation_id))
}

/// What a versioned write did, when "it failed" is not precise enough to act
/// on.
///
/// `PATCH`/`DELETE` on a versioned resource has three outcomes a caller must
/// tell apart — `200`, `404` and `409` — and a bare `Option` collapses the last
/// two. Distinguishing them is what makes "somebody else changed this" a
/// different message from "this is gone" (docs/04 §2).
#[derive(Debug, Clone)]
pub enum Versioned<T> {
    /// The write applied; here is the row as it now stands.
    Applied(T),
    /// The row exists, at this version, which is not the one the caller
    /// asserted.
    Stale {
        /// The version the row is actually at, so the caller can say so.
        current: i32,
    },
    /// No such row in this organisation.
    Missing,
}

/// What a `PATCH` says about one **nullable** column.
///
/// `Option<Option<T>>` says the same thing and says it badly: which of the two
/// layers means "absent" is a coin flip at every call site, and clippy refuses
/// it outright. A nullable column genuinely has three cases, and collapsing
/// any two of them is how a PATCH silently clears a field the caller never
/// mentioned.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Patch<T> {
    /// The key was not in the body. Leave the column as it is.
    #[default]
    Unchanged,
    /// The key was sent as `null`. Set the column to `NULL`.
    Clear,
    /// The key was sent with a value.
    Set(T),
}

impl<T> Patch<T> {
    /// Does this patch touch the column at all? Binds the "was this key sent?"
    /// parameter the `CASE WHEN` in [`update_event`] keys off.
    #[must_use]
    pub fn is_sent(&self) -> bool {
        !matches!(self, Self::Unchanged)
    }

    /// The value to write, which is `NULL` both for `Clear` and — harmlessly,
    /// since the `CASE` never reaches it — for `Unchanged`.
    #[must_use]
    pub fn value(self) -> Option<T> {
        match self {
            Self::Set(value) => Some(value),
            Self::Unchanged | Self::Clear => None,
        }
    }
}

/// The fields `PATCH …/events/{event}` may change.
///
/// The non-nullable columns are plain `Option`s — absent means "leave it
/// alone", which is what makes this a PATCH — and the two nullable ones are
/// [`Patch`], which has the third case those cannot express.
#[derive(Debug, Clone, Default)]
pub struct EventPatch {
    pub name: Option<String>,
    pub slug: Option<String>,
    pub timezone: Option<String>,
    pub period: Option<(Timestamp, Timestamp)>,
    /// The door times. Nullable, so tri-state: a coordinator who has not
    /// decided yet and one who has decided there are none say the same thing,
    /// and neither is "leave what is there".
    pub public_period: Patch<(Timestamp, Timestamp)>,
    pub festival_id: Patch<Uuid>,
    pub default_shift_pattern_id: Patch<Uuid>,
    pub availability_step_minutes: Option<i32>,
    /// Palette index, range-checked by the column rather than here.
    pub color: Option<i16>,
}

impl EventPatch {
    /// Does this patch ask for anything at all?
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.slug.is_none()
            && self.timezone.is_none()
            && self.period.is_none()
            && !self.public_period.is_sent()
            && !self.festival_id.is_sent()
            && !self.default_shift_pattern_id.is_sent()
            && self.availability_step_minutes.is_none()
            && self.color.is_none()
    }
}

/// Applies a patch to one event under optimistic concurrency, and records the
/// operation whose inverse restores the previous values.
///
/// `expected_version` is `None` for `If-Match: *`, which asserts only that the
/// row still exists.
///
/// The update is a single statement with `WHERE … AND version = $n`, rather
/// than a read followed by a write: the two would be a lost-update race even
/// inside one transaction under `READ COMMITTED`, which is exactly the race
/// the header is here to close.
///
/// **Widening the period does not touch the doors.** It used to: the first
/// time `period` grew, whatever it had been was kept as `public_period`. That
/// inferred a published fact from an editing accident — the period an event
/// happened to hold the first time somebody dragged a bar past the end of it
/// is not when the doors open, and because the rule only fired once, the
/// wrong answer was the permanent one. The two windows move independently
/// now, each because somebody said so.
///
/// # Errors
///
/// [`DbError::Query`] on a constraint violation (duplicate slug, unknown
/// timezone, a period that no longer covers the event's shifts, or one shrunk
/// back inside the published times) or any other statement failure.
pub async fn update_event(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
    id: Uuid,
    expected_version: Option<i32>,
    patch: &EventPatch,
) -> Result<Versioned<(Event, OperationId)>, DbError> {
    let Some(before) = get_event(conn, org_id, id).await? else {
        return Ok(Versioned::Missing);
    };
    if expected_version.is_some_and(|expected| expected != before.version) {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    // COALESCE on the scalar columns, and an explicit "was this key sent?"
    // boolean for the two nullable ones — COALESCE cannot express "set this to
    // NULL" and "leave it alone" with one parameter, because both arrive as
    // NULL.
    let row = sqlx::query(
        "UPDATE events SET \
           name     = coalesce($4, name), \
           slug     = coalesce($5::citext, slug), \
           timezone = coalesce($6, timezone), \
           period   = CASE WHEN $7::timestamptz IS NULL THEN period \
                           ELSE tstzrange($7, $8) END, \
           public_period = CASE WHEN NOT $14 THEN public_period \
                                WHEN $15::timestamptz IS NULL THEN NULL \
                                ELSE tstzrange($15, $16) END, \
           festival_id = CASE WHEN $9 THEN $10 ELSE festival_id END, \
           default_shift_pattern_id = CASE WHEN $11 THEN $12 ELSE default_shift_pattern_id END, \
           availability_step_minutes = coalesce($13, availability_step_minutes), \
           color = coalesce($17, color), \
           updated_at = now() \
         WHERE org_id = $1 AND id = $2 AND ($3::int IS NULL OR version = $3) \
         RETURNING id, org_id, festival_id, name, slug::text AS slug, timezone, \
                   lower(period) AS period_start, upper(period) AS period_end, \
                   lower(public_period) AS public_period_start, \
                   upper(public_period) AS public_period_end, \
                   status::text AS status, color, availability_step_minutes, \
                   default_shift_pattern_id, created_at, updated_at, version",
    )
    .bind(org_id)
    .bind(id)
    .bind(expected_version)
    .bind(patch.name.as_deref())
    .bind(patch.slug.as_deref())
    .bind(patch.timezone.as_deref())
    .bind(patch.period.map(|(start, _end)| start.to_sqlx()))
    .bind(patch.period.map(|(_start, end)| end.to_sqlx()))
    .bind(patch.festival_id.is_sent())
    .bind(patch.festival_id.value())
    .bind(patch.default_shift_pattern_id.is_sent())
    .bind(patch.default_shift_pattern_id.value())
    .bind(patch.availability_step_minutes)
    .bind(patch.public_period.is_sent())
    .bind(
        patch
            .public_period
            .value()
            .map(|(start, _end)| start.to_sqlx()),
    )
    .bind(
        patch
            .public_period
            .value()
            .map(|(_start, end)| end.to_sqlx()),
    )
    .bind(patch.color)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    // The row was there a statement ago and the version matched, so an empty
    // result means another transaction committed in between. Reported as
    // stale, which is what it is.
    let Some(row) = row else {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    };
    let event = decode_event(&row)?;

    let operation_id = record_operation(
        conn,
        org_id,
        Some(event.id),
        actor_id,
        "event.update",
        serde_json::json!({ "name": event.name, "slug": event.slug }),
        // The inverse restores what the row held before, field by field — not
        // a "re-apply the old row wholesale" command, which would also revert
        // anything a *later* operation changed. ADR-0024 refuses an undo that
        // overlaps a later operation; the inverse here is what it replays when
        // it does not.
        serde_json::json!({
            "command": "update_event",
            "event_id": event.id,
            "before": {
                "name": before.name,
                "slug": before.slug,
                "timezone": before.timezone,
                "period": { "start": before.period_start.to_string(),
                            "end": before.period_end.to_string() },
                // Carried even when it was null, because null is a value a
                // coordinator can set this column to — "there are no published
                // hours" is a decision, and an undo that could not put it back
                // would be an undo that invents door times.
                "public_period": before.public_period_start.map(|start| {
                    serde_json::json!({
                        "start": start.to_string(),
                        "end": before.public_period_end.map(|end| end.to_string()),
                    })
                }),
                "color": before.color,
                "festival_id": before.festival_id,
            },
        }),
        &[event.id],
    )
    .await?;

    Ok(Versioned::Applied((event, operation_id)))
}

/// Moves an event to `archived`, the honest alternative to deleting one whose
/// roster has been published (docs/04 §"Events, locations, shifts").
///
/// Takes no `If-Match`: it is not an edit of a field somebody else might be
/// editing, it is a state transition, and it is idempotent — archiving an
/// archived event changes nothing and answers `200`.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn archive_event(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
    id: Uuid,
) -> Result<Option<(Event, OperationId)>, DbError> {
    let Some(before) = get_event(conn, org_id, id).await? else {
        return Ok(None);
    };

    let row = sqlx::query(
        "UPDATE events SET status = 'archived', updated_at = now() \
         WHERE org_id = $1 AND id = $2 \
         RETURNING id, org_id, festival_id, name, slug::text AS slug, timezone, \
                   lower(period) AS period_start, upper(period) AS period_end, \
                   lower(public_period) AS public_period_start, \
                   upper(public_period) AS public_period_end, \
                   status::text AS status, color, availability_step_minutes, \
                   default_shift_pattern_id, created_at, updated_at, version",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let Some(row) = row else { return Ok(None) };
    let event = decode_event(&row)?;

    let operation_id = record_operation(
        conn,
        org_id,
        Some(event.id),
        actor_id,
        "event.archive",
        serde_json::json!({ "name": event.name }),
        serde_json::json!({
            "command": "set_event_status",
            "event_id": event.id,
            "status": before.status,
        }),
        &[event.id],
    )
    .await?;

    Ok(Some((event, operation_id)))
}

/// Deletes an event and everything `ON DELETE CASCADE` hangs off it —
/// locations, shifts, and the operations scoped to it.
///
/// Owner-only at the API layer (docs/04 §4). No `operations` row is written:
/// the cascade takes the event's own operations with it, so a record of "this
/// event was deleted" scoped to the deleted event would not survive its own
/// write. The `audit_log` entry is what outlives it, and that lands with M3.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn delete_event(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
    expected_version: Option<i32>,
) -> Result<Versioned<()>, DbError> {
    let Some(before) = get_event(conn, org_id, id).await? else {
        return Ok(Versioned::Missing);
    };
    if expected_version.is_some_and(|expected| expected != before.version) {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    let deleted = sqlx::query(
        "DELETE FROM events WHERE org_id = $1 AND id = $2 \
         AND ($3::int IS NULL OR version = $3)",
    )
    .bind(org_id)
    .bind(id)
    .bind(expected_version)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    if deleted.rows_affected() == 0 {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }
    Ok(Versioned::Applied(()))
}

/// Is there already any festival in this organisation? Backs the `409` on
/// `POST …/festivals/example`.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn org_has_any_festival(conn: &mut PgConnection, org_id: Uuid) -> Result<bool, DbError> {
    let row = sqlx::query("SELECT EXISTS (SELECT 1 FROM festivals WHERE org_id = $1) AS present")
        .bind(org_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(DbError::Query)?;
    row.try_get("present").map_err(DbError::Query)
}

/// Is there already any event in this organisation? Backs the `409` on
/// `POST …/events/example`.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn org_has_any_event(conn: &mut PgConnection, org_id: Uuid) -> Result<bool, DbError> {
    let row = sqlx::query("SELECT EXISTS (SELECT 1 FROM events WHERE org_id = $1) AS present")
        .bind(org_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(DbError::Query)?;
    row.try_get("present").map_err(DbError::Query)
}

/// Persists the whole worked example — one festival, its events, their
/// missions and their shifts, with every detail the dump carried — as one
/// operation.
///
/// Callers must have already checked [`org_has_any_festival`] and
/// [`org_has_any_event`]: this function does not re-check emptiness itself,
/// because the `409` decision belongs to the handler (it needs to distinguish
/// "org already has a festival" from "org already has a standalone event" in
/// its response, per the two separate endpoints in the API contract) and
/// re-checking here would just be the same query run twice inside one
/// transaction.
///
/// # Errors
///
/// [`DbError::Query`] if any statement fails. Every insert happens on the
/// caller's already-open transaction, so a failure partway through leaves
/// nothing committed.
pub async fn create_example(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
    fixture: &evp_domain::example::FestivalFixture,
) -> Result<(Festival, OperationId), DbError> {
    let festival_id = Uuid::now_v7();
    let festival = insert_festival(
        conn,
        festival_id,
        org_id,
        &fixture.name,
        &fixture.slug,
        &fixture.timezone,
        fixture.period,
    )
    .await?;

    let mut entity_ids = vec![festival.id];
    let mut events = std::collections::HashMap::with_capacity(fixture.events.len());

    for event_fixture in &fixture.events {
        let event_id = Uuid::now_v7();
        let event = insert_event(
            conn,
            event_id,
            org_id,
            Some(festival.id),
            &event_fixture.name,
            &event_fixture.slug,
            &fixture.timezone,
            event_fixture.period,
        )
        .await?;
        entity_ids.push(event.id);
        apply_example_event_details(conn, org_id, event.id, event_fixture).await?;

        // `evp_domain::example::build` already refused any index that names
        // nothing, so the errors below are unreachable from it. They are
        // errors rather than `continue`s because skipping one row would shift
        // every later index — an assignment would land on the wrong shift.
        let mut location_ids = Vec::with_capacity(event_fixture.locations.len());
        for location in &event_fixture.locations {
            let parent_id = match location.parent {
                Some(parent) => Some(*location_ids.get(parent).ok_or_else(|| {
                    dangling(format!("{}: no location {parent}", event_fixture.slug))
                })?),
                None => None,
            };
            let location_id = Uuid::now_v7();
            insert_example_location(conn, location_id, org_id, event.id, parent_id, location)
                .await?;
            entity_ids.push(location_id);
            location_ids.push(location_id);
        }

        let mut shift_ids = Vec::with_capacity(event_fixture.shifts.len());
        for shift_fixture in &event_fixture.shifts {
            let location_id = *location_ids.get(shift_fixture.location).ok_or_else(|| {
                dangling(format!(
                    "{}: no location {}",
                    event_fixture.slug, shift_fixture.location
                ))
            })?;
            let shift_id = Uuid::now_v7();
            insert_example_shift(conn, shift_id, org_id, event.id, location_id, shift_fixture)
                .await?;
            entity_ids.push(shift_id);
            shift_ids.push(shift_id);
        }

        events.insert(
            event_fixture.slug.clone(),
            crate::submissions::ExampleEvent {
                id: event.id,
                shift_ids,
            },
        );
    }

    // A draft form covering the whole festival, so the Formulaire page has
    // something to show and to publish.
    entity_ids.extend(crate::forms::create_example(conn, org_id, &festival).await?);

    crate::submissions::create_example_volunteers(
        conn,
        org_id,
        actor_id,
        fixture,
        &events,
        &mut entity_ids,
    )
    .await?;

    let operation_id = record_operation(
        conn,
        org_id,
        None,
        actor_id,
        "festival.create_example",
        serde_json::json!({
            "name": festival.name,
            "slug": festival.slug,
            "event_count": fixture.events.len(),
            "volunteer_count": fixture.volunteers.len(),
        }),
        serde_json::json!({ "command": "delete_festival", "festival_id": festival.id }),
        &entity_ids,
    )
    .await?;

    // event_count on the returned row was computed before the events above
    // were inserted; recomputed here so the handler's response is accurate
    // without a second round trip through `get_festival`.
    let mut festival = festival;
    festival.event_count = i64::try_from(fixture.events.len()).unwrap_or(i64::MAX);

    Ok((festival, operation_id))
}

/// A fixture index or slug that names nothing, found while loading it.
pub(crate) fn dangling(message: String) -> DbError {
    DbError::Fixture(evp_domain::example::ExampleError::DanglingReference(
        message,
    ))
}

/// Everything about a dumped event that [`insert_event`] does not take: the
/// door times, the palette colour it was dumped with (rather than the next
/// free one), and its scheduling rules.
async fn apply_example_event_details(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    event: &evp_domain::example::EventFixture,
) -> Result<(), DbError> {
    let (public_start, public_end) = event.public_period.map_or((None, None), |(start, end)| {
        (Some(start.to_sqlx()), Some(end.to_sqlx()))
    });
    sqlx::query(
        "UPDATE events SET \
           public_period = CASE WHEN $3::timestamptz IS NULL THEN NULL \
                                ELSE tstzrange($3, $4) END, \
           color = $5, max_hours_per_day = $6, min_rest_minutes = $7, \
           max_consecutive_days = $8, night_starts_at = $9::time, \
           night_ends_at = $10::time, availability_step_minutes = $11 \
         WHERE id = $1 AND org_id = $2",
    )
    .bind(event_id)
    .bind(org_id)
    .bind(public_start)
    .bind(public_end)
    .bind(event.color)
    .bind(event.max_hours_per_day)
    .bind(event.min_rest_minutes)
    .bind(event.max_consecutive_days)
    .bind(&event.night_starts_at)
    .bind(&event.night_ends_at)
    .bind(event.availability_step_minutes)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    Ok(())
}

async fn insert_example_location(
    conn: &mut PgConnection,
    id: Uuid,
    org_id: Uuid,
    event_id: Uuid,
    parent_id: Option<Uuid>,
    location: &evp_domain::example::LocationFixture,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO locations \
           (id, org_id, event_id, parent_id, kind, name, sort_order, colour, description, \
            address, exact_address, latitude, longitude, min_volunteers, max_volunteers) \
         VALUES ($1, $2, $3, $4, \
                 CASE WHEN $4::uuid IS NULL THEN 'zone' ELSE 'post' END::location_kind, \
                 $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
    )
    .bind(id)
    .bind(org_id)
    .bind(event_id)
    .bind(parent_id)
    .bind(&location.name)
    .bind(location.sort_order)
    .bind(&location.colour)
    .bind(&location.description)
    .bind(&location.address)
    .bind(&location.exact_address)
    .bind(location.latitude)
    .bind(location.longitude)
    .bind(location.min_volunteers)
    .bind(location.max_volunteers)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    Ok(())
}

async fn insert_example_shift(
    conn: &mut PgConnection,
    id: Uuid,
    org_id: Uuid,
    event_id: Uuid,
    location_id: Uuid,
    shift: &evp_domain::example::ShiftFixture,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO shifts \
           (id, org_id, event_id, location_id, period, title, required_count, max_count, notes) \
         VALUES ($1, $2, $3, $4, tstzrange($5, $6), $7, $8, $9, $10)",
    )
    .bind(id)
    .bind(org_id)
    .bind(event_id)
    .bind(location_id)
    .bind(shift.period.0.to_sqlx())
    .bind(shift.period.1.to_sqlx())
    .bind(&shift.title)
    .bind(shift.required_count)
    .bind(shift.max_count)
    .bind(&shift.notes)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    Ok(())
}

/// Records an operation against one event, for the sibling modules that write
/// event-scoped rows ([`crate::shifts`], and the location writes that follow).
///
/// Narrower than [`record_operation`] on purpose: `event_id` is required
/// rather than optional, so a caller outside this module cannot record an
/// org-wide operation, and there is still no way to write an `operations` row
/// without the write it describes being in the same transaction.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
#[expect(
    clippy::too_many_arguments,
    reason = "the operations row has six independent fields; a builder would be more code to describe the same six"
)]
pub(crate) async fn record_shift_operation(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    actor_id: Uuid,
    kind: &str,
    summary: serde_json::Value,
    inverse: serde_json::Value,
    entity_ids: &[Uuid],
) -> Result<OperationId, DbError> {
    record_operation(
        conn,
        org_id,
        Some(event_id),
        actor_id,
        kind,
        summary,
        inverse,
        entity_ids,
    )
    .await
}

/// Records an operation with no event (ADR-0024): shift patterns are
/// org-scoped, not event-scoped, so [`crate::patterns`] goes through this
/// rather than [`record_shift_operation`].
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub(crate) async fn record_pattern_operation(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
    kind: &str,
    summary: serde_json::Value,
    inverse: serde_json::Value,
    entity_ids: &[Uuid],
) -> Result<OperationId, DbError> {
    record_operation(
        conn, org_id, None, actor_id, kind, summary, inverse, entity_ids,
    )
    .await
}

/// Records an operation on a form (ADR-0024), for [`crate::forms`].
///
/// `event_id` is the form's own event scope when it has one, so an
/// event-scoped form's history goes with its event; a festival or pool form
/// has none and its operations are org-wide, like a shift pattern's.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
#[expect(
    clippy::too_many_arguments,
    reason = "the operations row has six independent fields; a builder would be more code to describe the same six"
)]
pub(crate) async fn record_form_operation(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Option<Uuid>,
    actor_id: Uuid,
    kind: &str,
    summary: serde_json::Value,
    inverse: serde_json::Value,
    entity_ids: &[Uuid],
) -> Result<OperationId, DbError> {
    record_operation(
        conn, org_id, event_id, actor_id, kind, summary, inverse, entity_ids,
    )
    .await
}

/// Writes one `operations` row (ADR-0024). Not `pub`: every mutating
/// operation in this module goes through [`create_festival`],
/// [`create_event`] or [`create_example`], which call this once each — a
/// separate public entry point would let a future caller record an operation
/// without the write it describes actually being in the same transaction.
#[expect(
    clippy::too_many_arguments,
    reason = "the operations row has six independent fields; a builder would be more code to describe the same six"
)]
async fn record_operation(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Option<Uuid>,
    actor_id: Uuid,
    kind: &str,
    summary: serde_json::Value,
    inverse: serde_json::Value,
    entity_ids: &[Uuid],
) -> Result<OperationId, DbError> {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO operations (id, org_id, event_id, actor_id, kind, summary, inverse, entity_ids) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(id)
    .bind(org_id)
    .bind(event_id)
    .bind(actor_id)
    .bind(kind)
    .bind(&summary)
    .bind(&inverse)
    .bind(entity_ids)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    Ok(OperationId(id))
}
