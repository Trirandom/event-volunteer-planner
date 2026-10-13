// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The organisation's shift-pattern catalogue (docs/03 §3.4, ADR-0029).
//!
//! A pattern is a **generator**: it describes how a working window is cut into
//! slots, it is consulted when `shifts/generate` runs, and nothing reads it
//! again afterwards. That is why every write in here is free to change a
//! pattern an event already points at — there is no shift to invalidate,
//! because a generated shift carries its own period and no back-reference to
//! the division that produced it.
//!
//! The same statement conventions as [`crate::catalog`]: `sqlx::query` rather
//! than the macros (no committed `.sqlx` cache yet), explicit `org_id`
//! predicates as belt-and-braces beside the RLS policies that actually
//! enforce isolation.

use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;
use crate::catalog::Versioned;

/// One entry in a pattern's segment list. `position` is not here: it is the
/// index in [`ShiftPattern::segments`], assigned by the API from the order the
/// caller sent, and a field that could disagree with the array order is a
/// field that eventually does (docs/04 §"Shift patterns").
#[derive(Debug, Clone)]
pub struct Segment {
    /// `shift` or `gap`. A `gap` consumes window time and generates nothing.
    pub kind: String,
    pub duration_minutes: i32,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ShiftPattern {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    /// `tile` repeats the segment list across the window; `once` lays it down
    /// a single time.
    pub repeat: String,
    /// What a `tile` pattern does with the time left over: `drop` or
    /// `truncate`. Never rounded up.
    pub on_remainder: String,
    pub is_archived: bool,
    pub segments: Vec<Segment>,
    pub created_at: jiff::Timestamp,
    pub updated_at: jiff::Timestamp,
    pub version: i32,
}

impl ShiftPattern {
    /// The distinct `shift` and `gap` durations this pattern lays down.
    ///
    /// Backs the divisibility rule in docs/04 §"Shift patterns": an event whose
    /// availability step does not divide every one of these cannot use the
    /// pattern, because the picker could not express availability that lines up
    /// with the shifts it generates. `gap` segments count — they move the start
    /// of the next shift, so a step that does not divide a gap misaligns
    /// everything after it.
    #[must_use]
    pub fn durations(&self) -> Vec<i32> {
        let mut durations: Vec<i32> = self
            .segments
            .iter()
            .map(|segment| segment.duration_minutes)
            .collect();
        durations.sort_unstable();
        durations.dedup();
        durations
    }
}

fn decode_pattern(row: &sqlx::postgres::PgRow) -> Result<ShiftPattern, DbError> {
    Ok(ShiftPattern {
        id: row.try_get("id").map_err(DbError::Query)?,
        org_id: row.try_get("org_id").map_err(DbError::Query)?,
        name: row.try_get("name").map_err(DbError::Query)?,
        repeat: row.try_get("repeat").map_err(DbError::Query)?,
        on_remainder: row.try_get("on_remainder").map_err(DbError::Query)?,
        is_archived: row.try_get("is_archived").map_err(DbError::Query)?,
        segments: Vec::new(),
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

/// Loads the segments of several patterns in one statement, ordered by
/// `position`, and hands them back aligned to `patterns`.
///
/// One query for the whole page rather than one per pattern: a catalogue of
/// thirty divisions is one round trip, and the N+1 version of this is the
/// reason a list endpoint gets slow long before anybody profiles it.
async fn attach_segments(
    conn: &mut PgConnection,
    org_id: Uuid,
    patterns: &mut [ShiftPattern],
) -> Result<(), DbError> {
    if patterns.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = patterns.iter().map(|pattern| pattern.id).collect();
    let rows = sqlx::query(
        "SELECT pattern_id, kind::text AS kind, duration_minutes, label \
           FROM shift_pattern_segments \
          WHERE org_id = $1 AND pattern_id = ANY($2) \
          ORDER BY pattern_id, position",
    )
    .bind(org_id)
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    for row in &rows {
        let pattern_id: Uuid = row.try_get("pattern_id").map_err(DbError::Query)?;
        let segment = Segment {
            kind: row.try_get("kind").map_err(DbError::Query)?,
            duration_minutes: row.try_get("duration_minutes").map_err(DbError::Query)?,
            label: row.try_get("label").map_err(DbError::Query)?,
        };
        if let Some(pattern) = patterns.iter_mut().find(|pattern| pattern.id == pattern_id) {
            pattern.segments.push(segment);
        }
    }
    Ok(())
}

/// The two-hour division every organisation starts with (docs/07 M2,
/// ADR-0029).
///
/// Seeded with the organisation rather than created on demand, because
/// `shifts/generate` resolves a pattern most-specific-first and falls back to
/// the event's default: an org with an empty catalogue would have every
/// location `skipped` with `no_pattern` on its first generation run, which
/// reads as a broken feature rather than as an empty catalogue.
///
/// It lives here rather than beside the other `create_owner` statements
/// because it is a *pattern*, and because a seed nobody can reach from a test
/// is a seed nobody tests: `create_owner` commits its own transaction, this
/// does not.
///
/// A row like any other, not a special case in the generator — a coordinator
/// can rename it, edit it, or archive it once they have their own.
///
/// # Errors
///
/// [`DbError::Query`] if either statement fails.
pub async fn seed_default(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
) -> Result<ShiftPattern, DbError> {
    let (pattern, _operation_id) = create(
        conn,
        org_id,
        actor_id,
        &PatternInput {
            name: "Créneaux 2 h".to_owned(),
            repeat: "tile".to_owned(),
            on_remainder: "drop".to_owned(),
            segments: vec![Segment {
                kind: "shift".to_owned(),
                duration_minutes: 120,
                label: None,
            }],
        },
    )
    .await?;
    Ok(pattern)
}

/// The catalogue. `archived` is `false` by default — the picker that reads
/// this is offering a division to use now, and a list that mixes retired ones
/// in makes the coordinator do the filtering.
///
/// # Errors
///
/// [`DbError::Query`] if either statement fails.
pub async fn list(
    conn: &mut PgConnection,
    org_id: Uuid,
    include_archived: bool,
) -> Result<Vec<ShiftPattern>, DbError> {
    let rows = sqlx::query(
        "SELECT id, org_id, name, repeat::text AS repeat, on_remainder, is_archived, \
                created_at, updated_at, version \
           FROM shift_patterns \
          WHERE org_id = $1 AND ($2 OR NOT is_archived) \
          ORDER BY name",
    )
    .bind(org_id)
    .bind(include_archived)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let mut patterns: Vec<ShiftPattern> =
        rows.iter().map(decode_pattern).collect::<Result<_, _>>()?;
    attach_segments(conn, org_id, &mut patterns).await?;
    Ok(patterns)
}

/// # Errors
///
/// [`DbError::Query`] if either statement fails.
pub async fn get(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
) -> Result<Option<ShiftPattern>, DbError> {
    let row = sqlx::query(
        "SELECT id, org_id, name, repeat::text AS repeat, on_remainder, is_archived, \
                created_at, updated_at, version \
           FROM shift_patterns WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let Some(row) = row else { return Ok(None) };
    let mut patterns = vec![decode_pattern(&row)?];
    attach_segments(conn, org_id, &mut patterns).await?;
    Ok(patterns.into_iter().next())
}

/// What a caller is asking a pattern to become. The same document for `POST`
/// and `PUT`, because `PUT` is an atomic replacement of the whole pattern
/// including its segments (docs/04 §"Shift patterns") — there is no partial
/// shape to describe.
#[derive(Debug, Clone)]
pub struct PatternInput {
    pub name: String,
    pub repeat: String,
    pub on_remainder: String,
    pub segments: Vec<Segment>,
}

/// A pattern's segments as an inverse-command payload. `Segment` has no
/// `Serialize` (it is never sent to a client as-is), so this builds the array
/// by hand rather than deriving one just for this.
fn segments_json(segments: &[Segment]) -> serde_json::Value {
    serde_json::Value::Array(
        segments
            .iter()
            .map(|segment| {
                serde_json::json!({
                    "kind": segment.kind,
                    "duration_minutes": segment.duration_minutes,
                    "label": segment.label,
                })
            })
            .collect(),
    )
}

/// Replaces a pattern's segment list wholesale.
///
/// `DELETE` then `INSERT` rather than a diff: the constraint trigger on
/// `shift_pattern_segments` is `DEFERRABLE INITIALLY DEFERRED` precisely so the
/// pattern is judged once at `COMMIT`, which means the list may be empty
/// mid-transaction. A diff would be more code to produce the same rows.
async fn write_segments(
    conn: &mut PgConnection,
    org_id: Uuid,
    pattern_id: Uuid,
    segments: &[Segment],
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM shift_pattern_segments WHERE org_id = $1 AND pattern_id = $2")
        .bind(org_id)
        .bind(pattern_id)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;

    for (position, segment) in segments.iter().enumerate() {
        // The array index *is* the position (docs/04): a client never sends
        // one, so they cannot disagree.
        let position = i16::try_from(position).map_err(|_| {
            DbError::Query(sqlx::Error::Encode(
                "a shift pattern cannot have more than 32767 segments".into(),
            ))
        })?;
        sqlx::query(
            "INSERT INTO shift_pattern_segments \
               (pattern_id, org_id, position, kind, duration_minutes, label) \
             VALUES ($1, $2, $3, $4::pattern_segment_kind, $5, $6)",
        )
        .bind(pattern_id)
        .bind(org_id)
        .bind(position)
        .bind(&segment.kind)
        .bind(segment.duration_minutes)
        .bind(segment.label.as_deref())
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;
    }
    Ok(())
}

/// # Errors
///
/// [`DbError::Query`] on a duplicate name, an out-of-range duration, or a
/// segment list the `shift_pattern_segments_well_formed` trigger refuses.
pub async fn create(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
    input: &PatternInput,
) -> Result<(ShiftPattern, crate::catalog::OperationId), DbError> {
    let id = Uuid::now_v7();
    let row = sqlx::query(
        "INSERT INTO shift_patterns (id, org_id, name, repeat, on_remainder) \
         VALUES ($1, $2, $3, $4::pattern_repeat, $5) \
         RETURNING id, org_id, name, repeat::text AS repeat, on_remainder, is_archived, \
                   created_at, updated_at, version",
    )
    .bind(id)
    .bind(org_id)
    .bind(&input.name)
    .bind(&input.repeat)
    .bind(&input.on_remainder)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let mut pattern = decode_pattern(&row)?;
    write_segments(conn, org_id, pattern.id, &input.segments).await?;
    pattern.segments = input.segments.clone();

    let operation_id = crate::catalog::record_pattern_operation(
        conn,
        org_id,
        actor_id,
        "pattern.create",
        serde_json::json!({ "pattern_id": pattern.id, "name": pattern.name }),
        serde_json::json!({ "command": "delete_pattern", "pattern_id": pattern.id }),
        &[pattern.id],
    )
    .await?;

    Ok((pattern, operation_id))
}

/// Replaces a pattern under optimistic concurrency, segments included.
///
/// # Errors
///
/// [`DbError::Query`] on a duplicate name or a segment list the trigger
/// refuses.
pub async fn replace(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
    actor_id: Uuid,
    expected_version: Option<i32>,
    input: &PatternInput,
) -> Result<Versioned<(ShiftPattern, crate::catalog::OperationId)>, DbError> {
    let Some(before) = get(conn, org_id, id).await? else {
        return Ok(Versioned::Missing);
    };
    if expected_version.is_some_and(|expected| expected != before.version) {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    let row = sqlx::query(
        "UPDATE shift_patterns \
            SET name = $4, repeat = $5::pattern_repeat, on_remainder = $6, \
                updated_at = now(), version = version + 1 \
          WHERE org_id = $1 AND id = $2 AND ($3::int IS NULL OR version = $3) \
          RETURNING id, org_id, name, repeat::text AS repeat, on_remainder, is_archived, \
                    created_at, updated_at, version",
    )
    .bind(org_id)
    .bind(id)
    .bind(expected_version)
    .bind(&input.name)
    .bind(&input.repeat)
    .bind(&input.on_remainder)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let Some(row) = row else {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    };
    let mut pattern = decode_pattern(&row)?;
    write_segments(conn, org_id, pattern.id, &input.segments).await?;
    pattern.segments = input.segments.clone();

    let operation_id = crate::catalog::record_pattern_operation(
        conn,
        org_id,
        actor_id,
        "pattern.replace",
        serde_json::json!({ "pattern_id": pattern.id }),
        serde_json::json!({
            "command": "replace_pattern",
            "pattern_id": pattern.id,
            "name": before.name,
            "repeat": before.repeat,
            "on_remainder": before.on_remainder,
            "segments": segments_json(&before.segments),
        }),
        &[pattern.id],
    )
    .await?;

    Ok(Versioned::Applied((pattern, operation_id)))
}

/// How many shifts a pattern edit changed.
///
/// Always zero, and the point is that it is asked rather than assumed: it is
/// what `PUT …/shift-patterns/{id}` reports so nobody has to wonder whether
/// editing a division rewrote last week's schedule (ADR-0029, docs/04). It is
/// a query rather than a literal `0` because the claim it backs is about the
/// database, not about this function.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn shifts_affected_by(
    conn: &mut PgConnection,
    org_id: Uuid,
    pattern_id: Uuid,
) -> Result<i64, DbError> {
    let row = sqlx::query(
        "SELECT count(*)::bigint AS affected \
           FROM shifts s \
           JOIN locations l ON l.id = s.location_id AND l.org_id = s.org_id \
          WHERE s.org_id = $1 AND l.shift_pattern_id = $2",
    )
    .bind(org_id)
    .bind(pattern_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.try_get("affected").map_err(DbError::Query)
}

/// Does anything still point at this pattern?
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn is_referenced(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT EXISTS ( \
           SELECT 1 FROM events WHERE org_id = $1 AND default_shift_pattern_id = $2 \
           UNION ALL \
           SELECT 1 FROM locations WHERE org_id = $1 AND shift_pattern_id = $2 \
         ) AS referenced",
    )
    .bind(org_id)
    .bind(id)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.try_get("referenced").map_err(DbError::Query)
}

/// Archives a referenced pattern. The row stays, so last year's event still
/// names the division it was laid out with.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn archive(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
    actor_id: Uuid,
) -> Result<Option<(ShiftPattern, crate::catalog::OperationId)>, DbError> {
    let row = sqlx::query(
        "UPDATE shift_patterns SET is_archived = true, updated_at = now(), version = version + 1 \
          WHERE org_id = $1 AND id = $2 \
          RETURNING id, org_id, name, repeat::text AS repeat, on_remainder, is_archived, \
                    created_at, updated_at, version",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let Some(row) = row else { return Ok(None) };
    let mut patterns = vec![decode_pattern(&row)?];
    attach_segments(conn, org_id, &mut patterns).await?;
    let Some(pattern) = patterns.into_iter().next() else {
        return Ok(None);
    };

    let operation_id = crate::catalog::record_pattern_operation(
        conn,
        org_id,
        actor_id,
        "pattern.archive",
        serde_json::json!({ "pattern_id": pattern.id }),
        serde_json::json!({
            "command": "set_pattern_status",
            "pattern_id": pattern.id,
            "is_archived": false,
        }),
        &[pattern.id],
    )
    .await?;

    Ok(Some((pattern, operation_id)))
}

/// Deletes a pattern nothing references. Its segments go with it
/// (`ON DELETE CASCADE`).
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn delete(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
    actor_id: Uuid,
) -> Result<Option<crate::catalog::OperationId>, DbError> {
    let Some(before) = get(conn, org_id, id).await? else {
        return Ok(None);
    };

    let deleted = sqlx::query("DELETE FROM shift_patterns WHERE org_id = $1 AND id = $2")
        .bind(org_id)
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;
    if deleted.rows_affected() == 0 {
        return Ok(None);
    }

    let operation_id = crate::catalog::record_pattern_operation(
        conn,
        org_id,
        actor_id,
        "pattern.delete",
        serde_json::json!({ "pattern_id": before.id, "name": before.name }),
        serde_json::json!({
            "command": "create_pattern",
            "name": before.name,
            "repeat": before.repeat,
            "on_remainder": before.on_remainder,
            "segments": segments_json(&before.segments),
        }),
        &[before.id],
    )
    .await?;

    Ok(Some(operation_id))
}
