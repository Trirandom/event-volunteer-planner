// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `.../participations/{id}/availability` — the one write
//! [`crate::participations`] deliberately does not perform (docs/04
//! §"Participation and availability").
//!
//! Two provenances share `availability_windows` (docs/03 §3.5): a
//! coordinator's hand-entered window (`declared_by`) and a window derived
//! from a volunteer's form submission (`source_submission_id`). The CHECK
//! `availability_has_provenance` guarantees a row is exactly one or the
//! other, never both, never neither.
//!
//! [`replace_declared`] is the coordinator write docs/04 calls "a full
//! replace of that participation's windows". Read literally, "all windows"
//! would delete submission-derived rows too — which
//! `crates/evp-db/src/submissions.rs` and `PlanSubmissionsView.vue` read
//! verbatim as a record of what the volunteer actually submitted, and which
//! must never be rewritten by a coordinator's later edit. So the replace is
//! scoped to `declared_by IS NOT NULL` rows and only those: delete the
//! coordinator's own prior windows, insert the new set, leave every
//! submission-derived row untouched. Migration
//! `20260918141853_availability_windows_provenance_exclusion` is the other
//! half of making that safe — see its module comment for why the exclusion
//! constraint had to change to allow it.

use jiff::Timestamp;
use jiff_sqlx::ToSqlx as _;
use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;

/// One window, as stored — either provenance.
#[derive(Debug, Clone)]
pub struct Window {
    pub id: Uuid,
    /// `available` or `unavailable` (docs/03 §3.5).
    pub kind: String,
    pub start: Timestamp,
    pub end: Timestamp,
    pub note: Option<String>,
    /// `"declared"` for a coordinator's hand-entered window, `"submitted"`
    /// for one derived from a form submission. Text rather than a Rust enum,
    /// for the reason [`crate::auth::Membership::role`] gives for its own
    /// string fields: this crosses the API boundary as-is and a client
    /// branches on the string, never on a numeric discriminant.
    pub provenance: String,
}

fn decode(row: &sqlx::postgres::PgRow) -> Result<Window, DbError> {
    let is_declared: bool = row.try_get("is_declared").map_err(DbError::Query)?;
    Ok(Window {
        id: row.try_get("id").map_err(DbError::Query)?,
        kind: row.try_get("kind").map_err(DbError::Query)?,
        start: row
            .try_get::<jiff_sqlx::Timestamp, _>("window_start")
            .map_err(DbError::Query)?
            .to_jiff(),
        end: row
            .try_get::<jiff_sqlx::Timestamp, _>("window_end")
            .map_err(DbError::Query)?
            .to_jiff(),
        note: row.try_get("note").map_err(DbError::Query)?,
        provenance: if is_declared {
            "declared".to_owned()
        } else {
            "submitted".to_owned()
        },
    })
}

/// Does this participation exist in this org, under this event? Both `GET`
/// and `PUT` need the same answer for the same reason
/// [`crate::shifts::location_belongs_to`] does: a caller naming another
/// tenant's or another event's participation must see a `404`, not an empty
/// or partial result that reads as "nobody declared anything".
async fn participation_exists(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    participation_id: Uuid,
) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT EXISTS ( \
           SELECT 1 FROM participations WHERE org_id = $1 AND event_id = $2 AND id = $3 \
         ) AS present",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(participation_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.try_get("present").map_err(DbError::Query)
}

/// Every window on one participation, both provenances, oldest first.
///
/// `Ok(None)` when the participation does not exist in this org+event —
/// [`crate::shifts::location_belongs_to`]'s reasoning applies here too.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn get(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    participation_id: Uuid,
) -> Result<Option<Vec<Window>>, DbError> {
    if !participation_exists(conn, org_id, event_id, participation_id).await? {
        return Ok(None);
    }

    let rows = sqlx::query(
        "SELECT id, kind::text AS kind, \
                lower(period) AS window_start, upper(period) AS window_end, \
                note, (declared_by IS NOT NULL) AS is_declared \
           FROM availability_windows \
          WHERE org_id = $1 AND participation_id = $2 \
          ORDER BY lower(period) ASC",
    )
    .bind(org_id)
    .bind(participation_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    rows.iter().map(decode).collect::<Result<_, _>>().map(Some)
}

/// One window as a coordinator submits it — never persisted directly, always
/// through [`replace_declared`], which is what stamps its provenance.
#[derive(Debug, Clone)]
pub struct NewWindow {
    pub kind: String,
    pub start: Timestamp,
    pub end: Timestamp,
    pub note: Option<String>,
}

/// Replaces every `declared_by`-provenance window of one participation with
/// `windows`, in one transaction, and records the operation whose inverse
/// restores the set being replaced (ADR-0024).
///
/// **Only** `declared_by IS NOT NULL` rows are touched — deleted and
/// reinserted. A `source_submission_id` row for the same participation is
/// never selected by the `DELETE` below and is not among `windows`, which
/// carries no provenance of its own: every inserted row is stamped
/// `declared_by = actor_id`. That is the whole of how this endpoint keeps a
/// volunteer's submitted answer intact regardless of what a coordinator does
/// here (see the module doc).
///
/// `Ok(None)` when the participation does not exist in this org+event — same
/// convention as [`get`].
///
/// # Errors
///
/// [`DbError::Query`] on `availability_period_valid` (an empty period slipped
/// past the API's own check) or on
/// `availability_windows_participation_id_provenance_period_excl` (two
/// windows in `windows` overlap, or one of them overlaps a declared window
/// this same call has already inserted — the exclusion constraint is checked
/// per row, inside this transaction, which is what makes it the backstop for
/// an in-request overlap too, not just a defence against a doubly-applied
/// request).
pub async fn replace_declared(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    participation_id: Uuid,
    actor_id: Uuid,
    windows: &[NewWindow],
) -> Result<Option<(Vec<Window>, crate::catalog::OperationId)>, DbError> {
    if !participation_exists(conn, org_id, event_id, participation_id).await? {
        return Ok(None);
    }

    // Captured before the DELETE below removes them — this row's values are
    // the only place they still exist once this transaction commits, and the
    // inverse needs them to put the previous declared set back exactly.
    let before_rows = sqlx::query(
        "SELECT kind::text AS kind, \
                lower(period) AS window_start, upper(period) AS window_end, note \
           FROM availability_windows \
          WHERE org_id = $1 AND participation_id = $2 AND declared_by IS NOT NULL \
          ORDER BY lower(period) ASC",
    )
    .bind(org_id)
    .bind(participation_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let mut before_windows = Vec::with_capacity(before_rows.len());
    for row in &before_rows {
        let kind: String = row.try_get("kind").map_err(DbError::Query)?;
        let start: jiff_sqlx::Timestamp = row.try_get("window_start").map_err(DbError::Query)?;
        let end: jiff_sqlx::Timestamp = row.try_get("window_end").map_err(DbError::Query)?;
        let note: Option<String> = row.try_get("note").map_err(DbError::Query)?;
        before_windows.push(serde_json::json!({
            "kind": kind,
            "start": start.to_jiff().to_string(),
            "end": end.to_jiff().to_string(),
            "note": note,
        }));
    }

    sqlx::query(
        "DELETE FROM availability_windows \
          WHERE org_id = $1 AND participation_id = $2 AND declared_by IS NOT NULL",
    )
    .bind(org_id)
    .bind(participation_id)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    // One statement per window rather than a multi-row `INSERT`, so the
    // exclusion constraint — `FOR EACH ROW`, in effect — refuses an
    // overlapping *pair within this same request* at the second row, the same
    // way `shifts::create_run` lets `shifts_within_event` catch a bad row in
    // a generation run rather than checking it in Rust first.
    let mut created = Vec::with_capacity(windows.len());
    for window in windows {
        let row = sqlx::query(
            "INSERT INTO availability_windows \
               (id, org_id, participation_id, kind, period, note, declared_by) \
             VALUES ($1, $2, $3, $4::availability_kind, tstzrange($5, $6), $7, $8) \
             RETURNING id, kind::text AS kind, \
                       lower(period) AS window_start, upper(period) AS window_end, \
                       note, (declared_by IS NOT NULL) AS is_declared",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(participation_id)
        .bind(&window.kind)
        .bind(window.start.to_sqlx())
        .bind(window.end.to_sqlx())
        .bind(window.note.as_deref())
        .bind(actor_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(DbError::Query)?;
        created.push(decode(&row)?);
    }

    let entity_ids: Vec<Uuid> = created.iter().map(|window| window.id).collect();
    let operation_id = crate::catalog::record_shift_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "availability.replace",
        serde_json::json!({
            "participation_id": participation_id,
            "windows": created.len(),
        }),
        // The inverse restores the declared set exactly as it stood before
        // this call — never touching whatever is or is not there from a
        // submission, which this operation never moved.
        serde_json::json!({
            "command": "replace_declared_availability",
            "participation_id": participation_id,
            "windows": before_windows,
        }),
        &entity_ids,
    )
    .await?;

    Ok(Some((created, operation_id)))
}
