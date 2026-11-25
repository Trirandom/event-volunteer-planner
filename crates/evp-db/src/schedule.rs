// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Who a schedule email run writes to, with each person's live lines
//! (docs/04 §Publishing, ADR-0054).
//!
//! The same reading the emails page makes from the board (`recipientsOf` in
//! `apps/admin/src/plan/emails.ts`): everybody `invited` or `confirmed` on a
//! day in scope, once, however many days that is, with or without a shift.
//! Lines are named by the shift's zone, because that is what the volunteer
//! reads on the board's row (ADR-0052), and carry the day's own timezone,
//! since a festival can span two.
//!
//! Lines come back unmerged and in no promised order. Merging is
//! `evp_domain::schedule::plan::classify`'s job, and doing it here as well
//! would be a second definition of "touching".

use std::collections::BTreeMap;

use evp_domain::schedule::lines::ScheduleLine;
use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;

/// One person a run writes to.
#[derive(Debug, Clone)]
pub struct Person {
    pub volunteer_id: Uuid,
    pub first_name: Option<String>,
    pub display_name: String,
    /// `None` for an anonymised volunteer as well as one who never gave one.
    pub email: Option<String>,
    pub notify_email: bool,
    pub lines: Vec<ScheduleLine>,
}

/// Everybody a run over `event_ids` writes to, ordered by name.
///
/// # Errors
///
/// [`DbError::Query`] if either statement fails.
pub async fn run(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_ids: &[Uuid],
) -> Result<Vec<Person>, DbError> {
    if event_ids.is_empty() {
        return Ok(Vec::new());
    }

    let people = sqlx::query(
        "SELECT DISTINCT ON (v.display_name_norm, v.id) \
                v.id, v.first_name, v.display_name, v.email::text AS email, v.notify_email \
           FROM participations p \
           JOIN volunteers v ON v.id = p.volunteer_id AND v.org_id = p.org_id \
          WHERE p.org_id = $1 AND p.event_id = ANY($2) \
            AND p.status IN ('invited', 'confirmed') \
          ORDER BY v.display_name_norm, v.id",
    )
    .bind(org_id)
    .bind(event_ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    // One statement for every placement in scope: a query per person would be
    // a few hundred round trips for one festival.
    let placements = sqlx::query(
        "SELECT a.volunteer_id, s.event_id, s.location_id, l.name AS mission, e.timezone, \
                lower(s.period) AS line_start, upper(s.period) AS line_end \
           FROM assignments a \
           JOIN shifts s ON s.id = a.shift_id AND s.org_id = a.org_id \
           JOIN locations l ON l.id = s.location_id AND l.org_id = s.org_id \
           JOIN events e ON e.id = s.event_id AND e.org_id = s.org_id \
          WHERE a.org_id = $1 AND a.event_id = ANY($2) AND a.status <> 'cancelled' \
          ORDER BY lower(s.period), s.id",
    )
    .bind(org_id)
    .bind(event_ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let mut lines: BTreeMap<Uuid, Vec<ScheduleLine>> = BTreeMap::new();
    for row in &placements {
        let volunteer_id: Uuid = row.try_get("volunteer_id").map_err(DbError::Query)?;
        lines.entry(volunteer_id).or_default().push(ScheduleLine {
            event_id: row.try_get("event_id").map_err(DbError::Query)?,
            location_id: row.try_get("location_id").map_err(DbError::Query)?,
            mission: row.try_get("mission").map_err(DbError::Query)?,
            timezone: row.try_get("timezone").map_err(DbError::Query)?,
            start: row
                .try_get::<jiff_sqlx::Timestamp, _>("line_start")
                .map_err(DbError::Query)?
                .to_jiff(),
            end: row
                .try_get::<jiff_sqlx::Timestamp, _>("line_end")
                .map_err(DbError::Query)?
                .to_jiff(),
        });
    }

    people
        .iter()
        .map(|row| {
            let volunteer_id: Uuid = row.try_get("id").map_err(DbError::Query)?;
            Ok(Person {
                volunteer_id,
                first_name: row.try_get("first_name").map_err(DbError::Query)?,
                display_name: row.try_get("display_name").map_err(DbError::Query)?,
                email: row.try_get("email").map_err(DbError::Query)?,
                notify_email: row.try_get("notify_email").map_err(DbError::Query)?,
                lines: lines.remove(&volunteer_id).unwrap_or_default(),
            })
        })
        .collect()
}

/// The organisation's name, which signs the message and names its sender.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn organization_name(
    conn: &mut PgConnection,
    org_id: Uuid,
) -> Result<Option<String>, DbError> {
    sqlx::query_scalar("SELECT name FROM organizations WHERE id = $1")
        .bind(org_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(DbError::Query)
}
