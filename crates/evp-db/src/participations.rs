// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Who has said they are coming to one edition, and when they can work
//! (docs/03 §3.5).
//!
//! Read-only, and deliberately: enrolling a volunteer and editing a status are
//! two documented writes (docs/04 §"Participation and availability") that
//! nothing in this slice performs. What it does perform is the assignation
//! board's one question — *who can I put in this slot?* — and that needs the
//! roster and its declared windows, nothing else.
//!
//! The third documented write, replacing a participation's declared
//! availability, lives in [`crate::availability`] rather than here — it is a
//! write, and everything in *this* module is a read.
//!
//! The windows come back on the participation rather than being fetched per
//! candidate. A board offering a dropdown per seat asks that question once per
//! seat and there are hundreds of seats on a festival day; a per-seat round
//! trip would be the spreadsheet's performance with a login on top.
//!
//! Same statement conventions as [`crate::catalog`]: `sqlx::query` rather than
//! the macros, and every `tstzrange` read as two `timestamptz` columns.

use jiff::Timestamp;
use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;

/// One declared window, exactly as the volunteer (or a coordinator on the
/// phone) gave it.
///
/// `kind` is `available` or `unavailable` and both are carried: a volunteer
/// who declared nothing is *unknown*, not available, and a board that
/// collapsed the two would tell a coordinator that half the pool is free
/// (docs/03 §3.5).
#[derive(Debug, Clone)]
pub struct Window {
    pub kind: String,
    pub start: Timestamp,
    pub end: Timestamp,
    /// `"declared"` for a coordinator's hand-entered window, `"submitted"`
    /// for one derived from a form submission (see [`crate::availability`]).
    /// Carried here, not just on the dedicated availability endpoints,
    /// because the migration that let the two provenances overlap in time
    /// (`20260918141853_availability_windows_provenance_exclusion`) means the
    /// board can now be shown both windows for the same instant, and it needs
    /// this to tell them apart — which one wins is a rendering decision for
    /// that caller, not this query.
    pub provenance: String,
}

#[derive(Debug, Clone)]
pub struct Participant {
    pub id: Uuid,
    pub volunteer_id: Uuid,
    /// The roster label, stored exactly as given and never parsed (ADR-0012).
    pub display_name: String,
    /// `invited`, `confirmed`, `declined` or `withdrawn`. Text rather than a
    /// Rust enum across this boundary, for the reason
    /// [`crate::auth::Membership::role`] gives.
    pub status: String,
    pub windows: Vec<Window>,
}

/// Everyone enrolled on one event, with what they said about their time.
///
/// Ordered by the normalised name, which is what a dropdown of six hundred
/// people has to be ordered by to be usable at all. `display_name_norm` rather
/// than `display_name`: the former is unaccented and case-folded in the
/// database (migration `…140000`), so "Élise" sorts with the Es rather than
/// after Z, without this query depending on a collation the test machine may
/// not have.
///
/// Includes declined and withdrawn participations. They cannot be assigned —
/// a constraint trigger refuses it (migration `…180100`) — and the board shows
/// them greyed rather than hiding them, because "why is Chloé not in the list?"
/// is a question a coordinator otherwise answers by opening the spreadsheet
/// this application replaced.
///
/// # Errors
///
/// [`DbError::Query`] if any statement fails.
pub async fn list(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
) -> Result<Vec<Participant>, DbError> {
    let rows = sqlx::query(
        "SELECT p.id, p.volunteer_id, v.display_name, p.status::text AS status \
           FROM participations p \
           JOIN volunteers v ON v.id = p.volunteer_id AND v.org_id = p.org_id \
          WHERE p.org_id = $1 AND p.event_id = $2 \
          ORDER BY v.display_name_norm ASC, p.id ASC",
    )
    .bind(org_id)
    .bind(event_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    // One statement for every window of the event, folded onto the rows above
    // in one pass. A query per participant would be six hundred round trips
    // for one page of a festival day.
    let windows = sqlx::query(
        "SELECT aw.participation_id, aw.kind::text AS kind, \
                lower(aw.period) AS window_start, upper(aw.period) AS window_end, \
                (aw.declared_by IS NOT NULL) AS is_declared \
           FROM availability_windows aw \
           JOIN participations p ON p.id = aw.participation_id AND p.org_id = aw.org_id \
          WHERE aw.org_id = $1 AND p.event_id = $2 \
          ORDER BY lower(aw.period) ASC",
    )
    .bind(org_id)
    .bind(event_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let mut by_participation: std::collections::HashMap<Uuid, Vec<Window>> =
        std::collections::HashMap::new();
    for row in &windows {
        let participation_id: Uuid = row.try_get("participation_id").map_err(DbError::Query)?;
        let is_declared: bool = row.try_get("is_declared").map_err(DbError::Query)?;
        by_participation
            .entry(participation_id)
            .or_default()
            .push(Window {
                kind: row.try_get("kind").map_err(DbError::Query)?,
                start: row
                    .try_get::<jiff_sqlx::Timestamp, _>("window_start")
                    .map_err(DbError::Query)?
                    .to_jiff(),
                end: row
                    .try_get::<jiff_sqlx::Timestamp, _>("window_end")
                    .map_err(DbError::Query)?
                    .to_jiff(),
                provenance: if is_declared {
                    "declared".to_owned()
                } else {
                    "submitted".to_owned()
                },
            });
    }

    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id").map_err(DbError::Query)?;
            Ok(Participant {
                id,
                volunteer_id: row.try_get("volunteer_id").map_err(DbError::Query)?,
                display_name: row.try_get("display_name").map_err(DbError::Query)?,
                status: row.try_get("status").map_err(DbError::Query)?,
                windows: by_participation.remove(&id).unwrap_or_default(),
            })
        })
        .collect()
}
