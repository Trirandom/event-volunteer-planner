// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The schedule grid: one row per slot to be staffed (docs/03 §3.4).
//!
//! Two of the six hard rules (docs/02 §5) live on this table and neither is
//! expressible here — `shifts_within_event` is a constraint trigger because
//! the bound it compares against is on another row, and `shifts_period_sane`
//! is a `CHECK`. This module's job is to let them fire, not to pre-empt them:
//! the only check it makes itself is the one the schema cannot make at all
//! ([`location_belongs_to`]).
//!
//! `tstzrange` is bound and read as two `timestamptz` parameters, for the
//! reason [`crate::catalog`]'s module documentation gives.

use jiff::Timestamp;
use jiff_sqlx::ToSqlx as _;
use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;
use crate::catalog::{Patch, Versioned};

#[derive(Debug, Clone)]
pub struct Shift {
    pub id: Uuid,
    pub org_id: Uuid,
    pub event_id: Uuid,
    pub location_id: Uuid,
    /// `NULL` means "inherit the location name" (docs/03 §3.4).
    pub title: Option<String>,
    pub period_start: Timestamp,
    pub period_end: Timestamp,
    pub required_count: i16,
    pub max_count: Option<i16>,
    pub notes: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub version: i32,
}

fn decode(row: &sqlx::postgres::PgRow) -> Result<Shift, DbError> {
    Ok(Shift {
        id: row.try_get("id").map_err(DbError::Query)?,
        org_id: row.try_get("org_id").map_err(DbError::Query)?,
        event_id: row.try_get("event_id").map_err(DbError::Query)?,
        location_id: row.try_get("location_id").map_err(DbError::Query)?,
        title: row.try_get("title").map_err(DbError::Query)?,
        period_start: row
            .try_get::<jiff_sqlx::Timestamp, _>("period_start")
            .map_err(DbError::Query)?
            .to_jiff(),
        period_end: row
            .try_get::<jiff_sqlx::Timestamp, _>("period_end")
            .map_err(DbError::Query)?
            .to_jiff(),
        required_count: row.try_get("required_count").map_err(DbError::Query)?,
        max_count: row.try_get("max_count").map_err(DbError::Query)?,
        notes: row.try_get("notes").map_err(DbError::Query)?,
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

/// Which shifts a listing asks for. `from`/`to` are a half-open window
/// (docs/04 §1) matched with `&&` against the shift's own range, so a shift
/// straddling the boundary is included — a board rendering one day must draw
/// the night shift that started the evening before.
#[derive(Debug, Clone, Copy, Default)]
pub struct ShiftFilter {
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    pub location_id: Option<Uuid>,
}

/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn list(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    filter: ShiftFilter,
) -> Result<Vec<Shift>, DbError> {
    let rows = sqlx::query(
        "SELECT id, org_id, event_id, location_id, title, \
                lower(period) AS period_start, upper(period) AS period_end, \
                required_count, max_count, notes, created_at, updated_at, version \
           FROM shifts \
          WHERE org_id = $1 AND event_id = $2 \
            AND ($3::uuid IS NULL OR location_id = $3) \
            AND ($4::timestamptz IS NULL OR upper(period) > $4) \
            AND ($5::timestamptz IS NULL OR lower(period) < $5) \
          ORDER BY lower(period), location_id",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(filter.location_id)
    .bind(filter.from.map(jiff_sqlx::ToSqlx::to_sqlx))
    .bind(filter.to.map(jiff_sqlx::ToSqlx::to_sqlx))
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    rows.iter().map(decode).collect()
}

/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn get(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    id: Uuid,
) -> Result<Option<Shift>, DbError> {
    let row = sqlx::query(
        "SELECT id, org_id, event_id, location_id, title, \
                lower(period) AS period_start, upper(period) AS period_end, \
                required_count, max_count, notes, created_at, updated_at, version \
           FROM shifts WHERE org_id = $1 AND event_id = $2 AND id = $3",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.as_ref().map(decode).transpose()
}

/// Does `location_id` belong to *this* event?
///
/// The check the schema is missing, for the same reason
/// [`crate::locations::parent_is_a_zone_of`] exists: `shifts`' foreign key is
/// `(location_id, org_id) REFERENCES locations(id, org_id)`, which stops a
/// cross-tenant location and nothing else. Within one organisation, a shift of
/// the Open Air could be filed under a post of Dub & 2step, and only the
/// within-event trigger would notice — and only if the two events' periods
/// happened not to overlap, which for a festival's own events they usually do.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn location_belongs_to(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    location_id: Uuid,
) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT EXISTS ( \
           SELECT 1 FROM locations WHERE org_id = $1 AND event_id = $2 AND id = $3 \
         ) AS present",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(location_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.try_get("present").map_err(DbError::Query)
}

/// Does this location already hold a shift overlapping `[start, end)`?
///
/// Backs the `overlaps_existing` skip on `shifts/generate` (docs/04): a
/// location whose day already has shifts is reported, not doubled. Half-open
/// on both sides — `tstzrange`'s default and the API's (docs/04 §1) — so two
/// abutting slots do not count as overlapping, which is the whole point of a
/// tiled pattern.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn overlaps_existing(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    location_id: Uuid,
    period: (Timestamp, Timestamp),
) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT EXISTS ( \
           SELECT 1 FROM shifts \
            WHERE org_id = $1 AND event_id = $2 AND location_id = $3 \
              AND period && tstzrange($4, $5) \
         ) AS present",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(location_id)
    .bind(period.0.to_sqlx())
    .bind(period.1.to_sqlx())
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.try_get("present").map_err(DbError::Query)
}

#[derive(Debug, Clone)]
pub struct NewShift {
    pub location_id: Uuid,
    pub title: Option<String>,
    pub period: (Timestamp, Timestamp),
    pub required_count: i16,
    pub max_count: Option<i16>,
    pub notes: Option<String>,
}

/// Creates one shift and records the operation whose inverse deletes it.
///
/// # Errors
///
/// [`DbError::Query`] on `shift_outside_event`, `shifts_period_sane`,
/// `shifts_period_valid`, or the `max_count >= required_count` check.
pub async fn create(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    actor_id: Uuid,
    input: &NewShift,
) -> Result<(Shift, crate::catalog::OperationId), DbError> {
    let row = sqlx::query(
        "INSERT INTO shifts \
           (id, org_id, event_id, location_id, title, period, required_count, max_count, notes) \
         VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7), $8, $9, $10) \
         RETURNING id, org_id, event_id, location_id, title, \
                   lower(period) AS period_start, upper(period) AS period_end, \
                   required_count, max_count, notes, created_at, updated_at, version",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(event_id)
    .bind(input.location_id)
    .bind(input.title.as_deref())
    .bind(input.period.0.to_sqlx())
    .bind(input.period.1.to_sqlx())
    .bind(input.required_count)
    .bind(input.max_count)
    .bind(input.notes.as_deref())
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let shift = decode(&row)?;

    let operation_id = crate::catalog::record_shift_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "shift.create",
        serde_json::json!({
            "location_id": shift.location_id,
            "period": { "start": shift.period_start.to_string(),
                        "end": shift.period_end.to_string() },
        }),
        serde_json::json!({ "command": "delete_shift", "shift_id": shift.id }),
        &[shift.id],
    )
    .await?;

    Ok((shift, operation_id))
}

/// Inserts a whole generation run as **one** operation (ADR-0024).
///
/// `days` is carried into the operation's summary, which is what the operation
/// log renders as "generated 2026-07-04 and 2026-07-05" rather than a row
/// count with no shape.
///
/// One `operations` row for the run rather than one per shift, because that is
/// what makes `Ctrl+Z` remove 240 shifts in a single action — which is the
/// behaviour docs/04 §"Generating shifts" specifies, and the reason a run is
/// worth calling an operation at all.
///
/// Inserted one statement at a time rather than as a multi-row `VALUES`: the
/// `shifts_within_event` trigger is `FOR EACH ROW` and fires either way, and a
/// per-row insert is what lets the caller keep the created rows in the order
/// it planned them. A generation run is a few hundred rows inside one
/// transaction, not a bulk load.
///
/// # Errors
///
/// [`DbError::Query`] on any constraint [`create`] can trip. The whole run
/// rolls back with the caller's transaction, so a refusal partway through
/// leaves no half-generated day.
pub async fn create_run(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    actor_id: Uuid,
    inputs: &[NewShift],
    days: &[String],
) -> Result<(Vec<Shift>, crate::catalog::OperationId), DbError> {
    let mut created = Vec::with_capacity(inputs.len());
    for input in inputs {
        let row = sqlx::query(
            "INSERT INTO shifts \
               (id, org_id, event_id, location_id, title, period, required_count, max_count, \
                notes) \
             VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7), $8, $9, $10) \
             RETURNING id, org_id, event_id, location_id, title, \
                       lower(period) AS period_start, upper(period) AS period_end, \
                       required_count, max_count, notes, created_at, updated_at, version",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(event_id)
        .bind(input.location_id)
        .bind(input.title.as_deref())
        .bind(input.period.0.to_sqlx())
        .bind(input.period.1.to_sqlx())
        .bind(input.required_count)
        .bind(input.max_count)
        .bind(input.notes.as_deref())
        .fetch_one(&mut *conn)
        .await
        .map_err(DbError::Query)?;
        created.push(decode(&row)?);
    }

    let entity_ids: Vec<Uuid> = created.iter().map(|shift| shift.id).collect();
    let operation_id = crate::catalog::record_shift_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "shift.generate",
        // Shaped here rather than passed in from the API layer: `operations`
        // is this crate's table, and a caller that could hand it an arbitrary
        // document could write a summary the undo path cannot read.
        serde_json::json!({ "days": days, "created": created.len() }),
        serde_json::json!({ "command": "delete_shifts", "shift_ids": entity_ids }),
        &entity_ids,
    )
    .await?;

    Ok((created, operation_id))
}

/// The fields `PATCH …/shifts/{id}` may change.
///
/// `location_id` is here and `event_id` is not: moving a shift from one post
/// to another within an event is ordinary bulk-editor work, and moving it to
/// another event is not a move, it is a different shift.
#[derive(Debug, Clone, Default)]
pub struct ShiftPatch {
    pub location_id: Option<Uuid>,
    pub title: Patch<String>,
    pub period: Option<(Timestamp, Timestamp)>,
    pub required_count: Option<i16>,
    pub max_count: Patch<i16>,
    pub notes: Patch<String>,
}

impl ShiftPatch {
    /// Does this patch ask for anything at all?
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.location_id.is_none()
            && !self.title.is_sent()
            && self.period.is_none()
            && self.required_count.is_none()
            && !self.max_count.is_sent()
            && !self.notes.is_sent()
    }
}

/// # Errors
///
/// [`DbError::Query`] on any of the constraints [`create`] can trip — the
/// within-event trigger fires on `UPDATE OF period` as well as on insert.
pub async fn update(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    actor_id: Uuid,
    id: Uuid,
    expected_version: Option<i32>,
    patch: &ShiftPatch,
) -> Result<Versioned<(Shift, crate::catalog::OperationId)>, DbError> {
    let Some(before) = get(conn, org_id, event_id, id).await? else {
        return Ok(Versioned::Missing);
    };
    if expected_version.is_some_and(|expected| expected != before.version) {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    let row = sqlx::query(
        "UPDATE shifts SET \
           location_id    = coalesce($5, location_id), \
           title          = CASE WHEN $6 THEN $7 ELSE title END, \
           period         = CASE WHEN $8::timestamptz IS NULL THEN period \
                                 ELSE tstzrange($8, $9) END, \
           required_count = coalesce($10, required_count), \
           max_count      = CASE WHEN $11 THEN $12 ELSE max_count END, \
           notes          = CASE WHEN $13 THEN $14 ELSE notes END, \
           updated_at     = now() \
         WHERE org_id = $1 AND event_id = $2 AND id = $3 \
           AND ($4::int IS NULL OR version = $4) \
         RETURNING id, org_id, event_id, location_id, title, \
                   lower(period) AS period_start, upper(period) AS period_end, \
                   required_count, max_count, notes, created_at, updated_at, version",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(id)
    .bind(expected_version)
    .bind(patch.location_id)
    .bind(patch.title.is_sent())
    .bind(patch.title.clone().value())
    .bind(patch.period.map(|(start, _end)| start.to_sqlx()))
    .bind(patch.period.map(|(_start, end)| end.to_sqlx()))
    .bind(patch.required_count)
    .bind(patch.max_count.is_sent())
    .bind(patch.max_count.value())
    .bind(patch.notes.is_sent())
    .bind(patch.notes.clone().value())
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let Some(row) = row else {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    };
    let shift = decode(&row)?;

    let operation_id = crate::catalog::record_shift_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "shift.update",
        serde_json::json!({ "shift_id": shift.id }),
        serde_json::json!({
            "command": "update_shift",
            "shift_id": shift.id,
            "before": {
                "location_id": before.location_id,
                "title": before.title,
                "period": { "start": before.period_start.to_string(),
                            "end": before.period_end.to_string() },
                "required_count": before.required_count,
                "max_count": before.max_count,
            },
        }),
        &[shift.id],
    )
    .await?;

    Ok(Versioned::Applied((shift, operation_id)))
}

/// Deletes one shift.
///
/// docs/04 makes this "refuses if assigned, unless `?force=true`". That guard
/// is **not** here, because `assignments` does not exist until M3: a check
/// against a table that does not exist is a check that always passes, and
/// writing one now would mean the guard ships already believing it works.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn delete(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    actor_id: Uuid,
    id: Uuid,
    expected_version: Option<i32>,
) -> Result<Versioned<crate::catalog::OperationId>, DbError> {
    let Some(before) = get(conn, org_id, event_id, id).await? else {
        return Ok(Versioned::Missing);
    };
    if expected_version.is_some_and(|expected| expected != before.version) {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    let deleted = sqlx::query(
        "DELETE FROM shifts WHERE org_id = $1 AND event_id = $2 AND id = $3 \
         AND ($4::int IS NULL OR version = $4)",
    )
    .bind(org_id)
    .bind(event_id)
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

    let operation_id = crate::catalog::record_shift_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "shift.delete",
        serde_json::json!({ "shift_id": before.id }),
        // The inverse recreates it, which is why every field of the deleted
        // row travels in the payload: the operation is the only place the
        // values still exist once the transaction commits.
        serde_json::json!({
            "command": "create_shift",
            "event_id": event_id,
            "location_id": before.location_id,
            "title": before.title,
            "period": { "start": before.period_start.to_string(),
                        "end": before.period_end.to_string() },
            "required_count": before.required_count,
            "max_count": before.max_count,
            "notes": before.notes,
        }),
        &[before.id],
    )
    .await?;

    Ok(Versioned::Applied(operation_id))
}
