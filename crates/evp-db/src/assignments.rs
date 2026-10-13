// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The roster: which volunteer is on which shift (docs/03 §3.6).
//!
//! Three of the six hard rules (docs/02 §5) guard this table — nobody in two
//! places at once, nobody twice on one shift, nobody assigned who has declined
//! or withdrawn — and **this module implements none of them**. They are an
//! exclusion constraint, a partial unique index and a constraint trigger in
//! migration `…180100`, and the job here is to let them fire so the database
//! stays the single authority. A pre-flight `SELECT` for a clash would answer
//! a question another transaction can invalidate before the insert lands, and
//! would tempt a later reader into believing that check is what protects the
//! roster.
//!
//! `period` and `volunteer_id` are denormalised from the shift and the
//! participation. Nothing here may set `period`: the `assignments_period_sync`
//! trigger takes it from the shift on every insert and on every change of
//! `shift_id`, which is what makes it safe for an exclusion constraint to key
//! off it.
//!
//! Same statement conventions as [`crate::catalog`]: `sqlx::query` with bound
//! parameters, never a statement assembled with `format!`, and every
//! `tstzrange` read as two `timestamptz` columns.

use jiff::Timestamp;
use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;
use crate::catalog::{OperationId, Versioned};

#[derive(Debug, Clone)]
pub struct Assignment {
    pub id: Uuid,
    pub org_id: Uuid,
    pub event_id: Uuid,
    pub shift_id: Uuid,
    pub participation_id: Uuid,
    /// The same volunteer the participation names — a composite foreign key
    /// guarantees it (migration `…180000`), which is what lets the exclusion
    /// constraint key off this column instead of a join.
    pub volunteer_id: Uuid,
    pub period_start: Timestamp,
    pub period_end: Timestamp,
    /// `draft`, `published` or `cancelled`.
    pub status: String,
    pub assigned_at: Timestamp,
    pub version: i32,
}

fn decode(row: &sqlx::postgres::PgRow) -> Result<Assignment, DbError> {
    Ok(Assignment {
        id: row.try_get("id").map_err(DbError::Query)?,
        org_id: row.try_get("org_id").map_err(DbError::Query)?,
        event_id: row.try_get("event_id").map_err(DbError::Query)?,
        shift_id: row.try_get("shift_id").map_err(DbError::Query)?,
        participation_id: row.try_get("participation_id").map_err(DbError::Query)?,
        volunteer_id: row.try_get("volunteer_id").map_err(DbError::Query)?,
        period_start: row
            .try_get::<jiff_sqlx::Timestamp, _>("period_start")
            .map_err(DbError::Query)?
            .to_jiff(),
        period_end: row
            .try_get::<jiff_sqlx::Timestamp, _>("period_end")
            .map_err(DbError::Query)?
            .to_jiff(),
        status: row.try_get("status").map_err(DbError::Query)?,
        assigned_at: row
            .try_get::<jiff_sqlx::Timestamp, _>("assigned_at")
            .map_err(DbError::Query)?
            .to_jiff(),
        version: row.try_get("version").map_err(DbError::Query)?,
    })
}

/// The live roster of one event, in the order the shifts run.
///
/// Cancelled rows are **not** returned. They are kept — a cancellation is the
/// record that somebody was rostered here and is no longer, which is what an
/// audit of a published schedule is read against — but the board asks "who is
/// on this shift?", and a listing that answered with people who are not would
/// have to be filtered by every caller instead of once here.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn list(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
) -> Result<Vec<Assignment>, DbError> {
    let rows = sqlx::query(
        "SELECT id, org_id, event_id, shift_id, participation_id, volunteer_id, \
                lower(period) AS period_start, upper(period) AS period_end, \
                status::text AS status, assigned_at, version \
           FROM assignments \
          WHERE org_id = $1 AND event_id = $2 AND status <> 'cancelled' \
          ORDER BY lower(period), assigned_at, id",
    )
    .bind(org_id)
    .bind(event_id)
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
) -> Result<Option<Assignment>, DbError> {
    let row = sqlx::query(
        "SELECT id, org_id, event_id, shift_id, participation_id, volunteer_id, \
                lower(period) AS period_start, upper(period) AS period_end, \
                status::text AS status, assigned_at, version \
           FROM assignments WHERE org_id = $1 AND event_id = $2 AND id = $3",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.as_ref().map(decode).transpose()
}

#[derive(Debug, Clone)]
pub struct NewAssignment {
    pub shift_id: Uuid,
    pub participation_id: Uuid,
    /// Soft-constraint codes the coordinator accepted (ADR-0007). Stored as
    /// given: an override is only auditable if what was overridden is on the
    /// row.
    pub acknowledged_warnings: Vec<String>,
}

/// Rosters one volunteer onto one shift, and records the operation whose
/// inverse cancels it.
///
/// `Ok(None)` means no such participation in this organisation — the `SELECT`
/// feeding the insert matched nothing. A participation that exists but belongs
/// to a *different edition* is not this case: it is a foreign-key violation
/// raised by `assignments_participation_is_this_edition`, because which event
/// somebody signed up for is a fact the schema holds and not one this module
/// should re-decide.
///
/// `volunteer_id` and `period` are both read out of the rows they belong to
/// inside this one statement rather than passed in. The first is the
/// participation's, and letting a caller supply it would let a caller supply a
/// *different* one — which is exactly what the exclusion constraint would then
/// fail to catch. The period is the shift's, which the
/// `assignments_period_sync` trigger sets to the same value regardless: the
/// trigger is the authority, and reading it here as well is what makes the
/// statement say what it stores.
///
/// # Errors
///
/// [`DbError::Query`] on `23P01` (this volunteer already works something that
/// overlaps), `23505` (already on this shift), `23503` (no such shift, or a
/// participation for another edition) and the `withdrawn_participant` check.
pub async fn create(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    actor_id: Uuid,
    input: &NewAssignment,
) -> Result<Option<(Assignment, OperationId)>, DbError> {
    let row = sqlx::query(
        "INSERT INTO assignments \
           (id, org_id, event_id, shift_id, participation_id, volunteer_id, period, \
            assigned_by, acknowledged_warnings) \
         SELECT $1, $2, $3, $4, p.id, p.volunteer_id, \
                (SELECT s.period FROM shifts s WHERE s.id = $4 AND s.org_id = $2), \
                $6, $7 \
           FROM participations p \
          WHERE p.id = $5 AND p.org_id = $2 \
         RETURNING id, org_id, event_id, shift_id, participation_id, volunteer_id, \
                   lower(period) AS period_start, upper(period) AS period_end, \
                   status::text AS status, assigned_at, version",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(event_id)
    .bind(input.shift_id)
    .bind(input.participation_id)
    .bind(actor_id)
    .bind(&input.acknowledged_warnings)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let Some(row) = row else {
        return Ok(None);
    };
    let assignment = decode(&row)?;

    let operation_id = crate::catalog::record_shift_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "assignment.create",
        serde_json::json!({
            "shift_id": assignment.shift_id,
            "volunteer_id": assignment.volunteer_id,
        }),
        serde_json::json!({
            "command": "cancel_assignment",
            "assignment_id": assignment.id,
        }),
        &[assignment.id],
    )
    .await?;

    Ok(Some((assignment, operation_id)))
}

/// Takes one volunteer off one shift.
///
/// A cancellation, never a delete: docs/04 says so outright (`DELETE
/// …/assignments/{id}` "cancels, does not erase"), and it is what keeps "who
/// was on the door when it happened?" answerable after the roster has been
/// re-cut. The row leaves [`list`] and stops blocking the exclusion
/// constraint, which is the whole behavioural difference.
///
/// An already-cancelled row answers [`Versioned::Missing`]: it is not in the
/// live roster, so a caller holding its id is holding a board that has moved.
///
/// # Errors
///
/// [`DbError::Query`] if any statement fails.
pub async fn cancel(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    actor_id: Uuid,
    id: Uuid,
    expected_version: Option<i32>,
) -> Result<Versioned<OperationId>, DbError> {
    let Some(before) = get(conn, org_id, event_id, id).await? else {
        return Ok(Versioned::Missing);
    };
    if before.status == "cancelled" {
        return Ok(Versioned::Missing);
    }
    if expected_version.is_some_and(|expected| expected != before.version) {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    let cancelled = sqlx::query(
        "UPDATE assignments SET status = 'cancelled', cancelled_at = now(), updated_at = now() \
          WHERE org_id = $1 AND event_id = $2 AND id = $3 AND status <> 'cancelled' \
            AND ($4::int IS NULL OR version = $4)",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(id)
    .bind(expected_version)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    if cancelled.rows_affected() == 0 {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    let operation_id = crate::catalog::record_shift_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "assignment.cancel",
        serde_json::json!({
            "shift_id": before.shift_id,
            "volunteer_id": before.volunteer_id,
        }),
        // The inverse re-rosters the same person on the same shift rather than
        // reviving this row: the exclusion constraint may have handed the slot
        // to somebody else in between, and an undo that resurrected a row
        // would have to decide what to do about that silently.
        serde_json::json!({
            "command": "create_assignment",
            "shift_id": before.shift_id,
            "participation_id": before.participation_id,
        }),
        &[before.id],
    )
    .await?;

    Ok(Versioned::Applied(operation_id))
}
