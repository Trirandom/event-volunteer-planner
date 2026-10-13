// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The zone/post tree an event is staffed against (docs/03 §3.4).
//!
//! Exactly two levels, enforced by `locations_hierarchy` in migration
//! `…101400`. What that `CHECK` cannot enforce — and what the composite
//! foreign key does not either, because it carries `org_id` and not `event_id`
//! — is that a post's zone belongs to the **same event**. [`parent_is_a_zone_of`]
//! is that missing half, and the API layer calls it before every write that
//! sets a `parent_id`.
//!
//! Same statement conventions as [`crate::catalog`].

use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;
use crate::catalog::{Patch, Versioned};

#[derive(Debug, Clone)]
pub struct Location {
    pub id: Uuid,
    pub org_id: Uuid,
    pub event_id: Uuid,
    /// `NULL` for a zone, the zone's id for a post.
    pub parent_id: Option<Uuid>,
    /// `zone` or `post`.
    pub kind: String,
    pub name: String,
    /// What the job is, in a coordinator's words. `None` when nothing has been
    /// said about it — never `Some("")`, which the schema refuses.
    pub description: Option<String>,
    /// Where to stand, as you would say it to someone who is lost. Free text,
    /// deliberately not a postal record (migration `…130000`).
    pub address: Option<String>,
    /// A postal address a map or courier can resolve on its own. Zones only
    /// (migration `…093312`); `None` on a post, and on a zone with no postal
    /// address to give (open ground during build/strike, where only
    /// [`Location::latitude`]/[`Location::longitude`] apply).
    pub exact_address: Option<String>,
    /// Decimal degrees, WGS 84. Set together with `longitude`, typically for
    /// a site with no postal address to give instead. Zones only.
    pub latitude: Option<f64>,
    /// Decimal degrees, WGS 84. Set together with `latitude`. Zones only.
    pub longitude: Option<f64>,
    /// The fewest volunteers this mission should be staffed with, and the
    /// most it may take (migration `…120000`). Each is `None` when nobody has
    /// said — neither zero nor "unbounded", which are both numbers a caller
    /// could mistake for a decision. Zones and posts alike, and a zone's are
    /// its own, never a sum over its posts.
    pub min_volunteers: Option<i16>,
    pub max_volunteers: Option<i16>,
    /// Whether the form's missions question offers this zone already ticked
    /// (migration `…093000`). Zones only: a post always reads `true` here and
    /// takes its zone's value when the missions are folded.
    pub checked_by_default: bool,
    /// Whether this zone is for volunteers aged 18 or over. Shown on the form,
    /// never enforced there. Zones only, like `checked_by_default`; a post
    /// always reads `false`.
    pub adults_only: bool,
    pub sort_order: i32,
    pub colour: Option<String>,
    /// This mission's own slot division, where it differs from the event's.
    /// `NULL` — the common case — inherits `events.default_shift_pattern_id`
    /// (ADR-0029).
    pub shift_pattern_id: Option<Uuid>,
    pub created_at: jiff::Timestamp,
    pub updated_at: jiff::Timestamp,
    pub version: i32,
}

fn decode(row: &sqlx::postgres::PgRow) -> Result<Location, DbError> {
    Ok(Location {
        id: row.try_get("id").map_err(DbError::Query)?,
        org_id: row.try_get("org_id").map_err(DbError::Query)?,
        event_id: row.try_get("event_id").map_err(DbError::Query)?,
        parent_id: row.try_get("parent_id").map_err(DbError::Query)?,
        kind: row.try_get("kind").map_err(DbError::Query)?,
        name: row.try_get("name").map_err(DbError::Query)?,
        description: row.try_get("description").map_err(DbError::Query)?,
        address: row.try_get("address").map_err(DbError::Query)?,
        exact_address: row.try_get("exact_address").map_err(DbError::Query)?,
        latitude: row.try_get("latitude").map_err(DbError::Query)?,
        longitude: row.try_get("longitude").map_err(DbError::Query)?,
        min_volunteers: row.try_get("min_volunteers").map_err(DbError::Query)?,
        max_volunteers: row.try_get("max_volunteers").map_err(DbError::Query)?,
        checked_by_default: row.try_get("checked_by_default").map_err(DbError::Query)?,
        adults_only: row.try_get("adults_only").map_err(DbError::Query)?,
        sort_order: row.try_get("sort_order").map_err(DbError::Query)?,
        colour: row.try_get("colour").map_err(DbError::Query)?,
        shift_pattern_id: row.try_get("shift_pattern_id").map_err(DbError::Query)?,
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

/// Every location of one event, zones before their posts, each group in
/// `sort_order` then name.
///
/// Flat rather than nested: the nesting is two levels and the API assembles it
/// from this, which keeps the ordering decision in SQL — where `sort_order` is
/// — rather than split between a query and a fold.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn list(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
) -> Result<Vec<Location>, DbError> {
    let rows = sqlx::query(
        "SELECT id, org_id, event_id, parent_id, kind::text AS kind, name, description, address, \
                exact_address, latitude, longitude, min_volunteers, max_volunteers, \
                checked_by_default, adults_only, sort_order, colour, shift_pattern_id, created_at, updated_at, version \
           FROM locations \
          WHERE org_id = $1 AND event_id = $2 \
          ORDER BY (parent_id IS NOT NULL), sort_order, name",
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
) -> Result<Option<Location>, DbError> {
    let row = sqlx::query(
        "SELECT id, org_id, event_id, parent_id, kind::text AS kind, name, description, address, \
                exact_address, latitude, longitude, min_volunteers, max_volunteers, \
                checked_by_default, adults_only, sort_order, colour, shift_pattern_id, created_at, updated_at, version \
           FROM locations WHERE org_id = $1 AND event_id = $2 AND id = $3",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.as_ref().map(decode).transpose()
}

/// Is `parent_id` a zone of *this* event?
///
/// The check the schema is missing. `locations`' composite foreign key is
/// `(parent_id, org_id) REFERENCES locations(id, org_id)`, which stops a
/// cross-tenant parent and nothing else: within one organisation, a post of
/// the Open Air could be parented to a zone of Dub & 2step and every
/// constraint would be satisfied. The board would then render one event's post
/// inside another event's zone, and the coverage rollup would count it twice.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn parent_is_a_zone_of(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    parent_id: Uuid,
) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT EXISTS ( \
           SELECT 1 FROM locations \
            WHERE org_id = $1 AND event_id = $2 AND id = $3 AND kind = 'zone' \
         ) AS present",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(parent_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.try_get("present").map_err(DbError::Query)
}

/// What a caller is asking a new location to be.
#[derive(Debug, Clone)]
pub struct NewLocation {
    pub kind: String,
    pub name: String,
    /// Blank is not a third state: the caller normalises `""` to `None` before
    /// it gets here, and `locations_description_not_blank` refuses whatever
    /// does not.
    pub description: Option<String>,
    pub address: Option<String>,
    /// Zones only — `locations_posts_have_no_map_data` refuses it on a post.
    /// Blank is not a third state, same as `description`.
    pub exact_address: Option<String>,
    /// Zones only, and only together with `longitude`
    /// (`locations_latitude_longitude_together`).
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    /// Either, both or neither. `locations_volunteer_bounds_ordered` refuses a
    /// ceiling below the floor, and the column checks a negative floor or a
    /// ceiling of zero; the API says so first, with the field named.
    pub min_volunteers: Option<i16>,
    pub max_volunteers: Option<i16>,
    /// Zones only. `locations_posts_have_no_form_flags` refuses anything but
    /// `true` on a post, which takes its zone's value instead.
    pub checked_by_default: bool,
    /// Zones only. A post must send `false`, for the same reason.
    pub adults_only: bool,
    pub parent_id: Option<Uuid>,
    pub sort_order: i32,
    pub colour: Option<String>,
    pub shift_pattern_id: Option<Uuid>,
}

/// # Errors
///
/// [`DbError::Query`] on a duplicate name under the same parent, a
/// `locations_hierarchy` violation, or an unknown parent or pattern.
pub async fn create(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    actor_id: Uuid,
    input: &NewLocation,
) -> Result<(Location, crate::catalog::OperationId), DbError> {
    let row = sqlx::query(
        "INSERT INTO locations \
           (id, org_id, event_id, parent_id, kind, name, description, address, exact_address, \
            latitude, longitude, min_volunteers, max_volunteers, checked_by_default, \
            adults_only, sort_order, colour, shift_pattern_id) \
         VALUES ($1, $2, $3, $4, $5::location_kind, $6, $7, $8, $9, $10, $11, $12, $13, $14, \
                 $15, $16, $17, $18) \
         RETURNING id, org_id, event_id, parent_id, kind::text AS kind, name, description, \
                   address, exact_address, latitude, longitude, min_volunteers, \
                   max_volunteers, checked_by_default, adults_only, sort_order, colour, shift_pattern_id, created_at, updated_at, \
                   version",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(event_id)
    .bind(input.parent_id)
    .bind(&input.kind)
    .bind(&input.name)
    .bind(input.description.as_deref())
    .bind(input.address.as_deref())
    .bind(input.exact_address.as_deref())
    .bind(input.latitude)
    .bind(input.longitude)
    .bind(input.min_volunteers)
    .bind(input.max_volunteers)
    .bind(input.checked_by_default)
    .bind(input.adults_only)
    .bind(input.sort_order)
    .bind(input.colour.as_deref())
    .bind(input.shift_pattern_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let location = decode(&row)?;

    let operation_id = crate::catalog::record_shift_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "location.create",
        serde_json::json!({ "kind": location.kind, "name": location.name }),
        serde_json::json!({ "command": "delete_location", "location_id": location.id }),
        &[location.id],
    )
    .await?;

    Ok((location, operation_id))
}

/// The fields `PATCH …/locations/{id}` may change.
///
/// `kind` and `parent_id` are deliberately absent. Re-parenting a post or
/// turning a zone into one is a move of everything beneath it — shifts,
/// assignments and a zone lead's scope all hang off the tree — and an endpoint
/// that did it silently under a `PATCH` would be the quietest way to
/// reorganise an event by accident. Delete and recreate, or wait for a `move`
/// endpoint that says what it does.
#[derive(Debug, Clone, Default)]
pub struct LocationPatch {
    pub name: Option<String>,
    /// Tri-state, like `colour`: unsent leaves the briefing alone, `null`
    /// clears it, a string replaces it. Two of those three are things a
    /// coordinator does on purpose and `Option<String>` can only say one.
    pub description: Patch<String>,
    pub address: Patch<String>,
    pub exact_address: Patch<String>,
    /// Sent and read together — the API rejects a request that sets one
    /// without the other, since `locations_latitude_longitude_together`
    /// would otherwise turn a partial send into a `DbError::Query` instead of
    /// a clean `422`.
    pub latitude: Patch<f64>,
    pub longitude: Patch<f64>,
    /// Independently tri-state, unlike the coordinates: a floor and a ceiling
    /// are two statements, and clearing one says nothing about the other.
    /// The API compares a one-sided send against the stored other side, so
    /// `locations_volunteer_bounds_ordered` is only reached by a concurrent
    /// writer landing between that read and this `UPDATE`.
    pub min_volunteers: Patch<i16>,
    pub max_volunteers: Patch<i16>,
    /// Two-state, so plain `Option`: there is no "nobody has said" to clear
    /// back to. Zones only; the API refuses either on a post.
    pub checked_by_default: Option<bool>,
    pub adults_only: Option<bool>,
    pub sort_order: Option<i32>,
    pub colour: Patch<String>,
    pub shift_pattern_id: Patch<Uuid>,
}

impl LocationPatch {
    /// Does this patch ask for anything at all?
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && !self.description.is_sent()
            && !self.address.is_sent()
            && !self.exact_address.is_sent()
            && !self.latitude.is_sent()
            && !self.longitude.is_sent()
            && !self.min_volunteers.is_sent()
            && !self.max_volunteers.is_sent()
            && self.checked_by_default.is_none()
            && self.adults_only.is_none()
            && self.sort_order.is_none()
            && !self.colour.is_sent()
            && !self.shift_pattern_id.is_sent()
    }
}

/// # Errors
///
/// [`DbError::Query`] on a duplicate name under the same parent, or an unknown
/// pattern.
pub async fn update(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    id: Uuid,
    actor_id: Uuid,
    expected_version: Option<i32>,
    patch: &LocationPatch,
) -> Result<Versioned<(Location, crate::catalog::OperationId)>, DbError> {
    let Some(before) = get(conn, org_id, event_id, id).await? else {
        return Ok(Versioned::Missing);
    };
    if expected_version.is_some_and(|expected| expected != before.version) {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    let row = sqlx::query(
        "UPDATE locations SET \
           name        = coalesce($5, name), \
           description = CASE WHEN $6 THEN $7 ELSE description END, \
           address     = CASE WHEN $8 THEN $9 ELSE address END, \
           exact_address = CASE WHEN $10 THEN $11 ELSE exact_address END, \
           latitude    = CASE WHEN $12 THEN $13 ELSE latitude END, \
           longitude   = CASE WHEN $14 THEN $15 ELSE longitude END, \
           min_volunteers = CASE WHEN $16 THEN $17 ELSE min_volunteers END, \
           max_volunteers = CASE WHEN $18 THEN $19 ELSE max_volunteers END, \
           sort_order  = coalesce($20, sort_order), \
           colour      = CASE WHEN $21 THEN $22 ELSE colour END, \
           shift_pattern_id = CASE WHEN $23 THEN $24 ELSE shift_pattern_id END, \
           checked_by_default = coalesce($25, checked_by_default), \
           adults_only = coalesce($26, adults_only), \
           updated_at  = now() \
         WHERE org_id = $1 AND event_id = $2 AND id = $3 \
           AND ($4::int IS NULL OR version = $4) \
         RETURNING id, org_id, event_id, parent_id, kind::text AS kind, name, description, \
                   address, exact_address, latitude, longitude, min_volunteers, \
                   max_volunteers, checked_by_default, adults_only, sort_order, colour, shift_pattern_id, created_at, updated_at, \
                   version",
    )
    .bind(org_id)
    .bind(event_id)
    .bind(id)
    .bind(expected_version)
    .bind(patch.name.as_deref())
    .bind(patch.description.is_sent())
    .bind(patch.description.clone().value())
    .bind(patch.address.is_sent())
    .bind(patch.address.clone().value())
    .bind(patch.exact_address.is_sent())
    .bind(patch.exact_address.clone().value())
    .bind(patch.latitude.is_sent())
    .bind(patch.latitude.value())
    .bind(patch.longitude.is_sent())
    .bind(patch.longitude.value())
    .bind(patch.min_volunteers.is_sent())
    .bind(patch.min_volunteers.value())
    .bind(patch.max_volunteers.is_sent())
    .bind(patch.max_volunteers.value())
    .bind(patch.sort_order)
    .bind(patch.colour.is_sent())
    .bind(patch.colour.clone().value())
    .bind(patch.shift_pattern_id.is_sent())
    .bind(patch.shift_pattern_id.value())
    .bind(patch.checked_by_default)
    .bind(patch.adults_only)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let Some(row) = row else {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    };
    let location = decode(&row)?;

    let operation_id = crate::catalog::record_shift_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "location.update",
        serde_json::json!({ "location_id": location.id }),
        serde_json::json!({
            "command": "update_location",
            "location_id": location.id,
            "before": {
                "name": before.name,
                "description": before.description,
                "address": before.address,
                "exact_address": before.exact_address,
                "latitude": before.latitude,
                "longitude": before.longitude,
                "min_volunteers": before.min_volunteers,
                "max_volunteers": before.max_volunteers,
                "checked_by_default": before.checked_by_default,
                "adults_only": before.adults_only,
                "sort_order": before.sort_order,
                "colour": before.colour,
                "shift_pattern_id": before.shift_pattern_id,
            },
        }),
        &[location.id],
    )
    .await?;

    Ok(Versioned::Applied((location, operation_id)))
}

/// Deletes a location. A zone takes its posts, and any location takes its
/// shifts, through `ON DELETE CASCADE`.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn delete(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    id: Uuid,
    actor_id: Uuid,
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
        "DELETE FROM locations WHERE org_id = $1 AND event_id = $2 AND id = $3 \
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
        "location.delete",
        serde_json::json!({ "location_id": before.id }),
        serde_json::json!({
            "command": "create_location",
            "event_id": event_id,
            "kind": before.kind,
            "name": before.name,
            "description": before.description,
            "address": before.address,
            "exact_address": before.exact_address,
            "latitude": before.latitude,
            "longitude": before.longitude,
            "min_volunteers": before.min_volunteers,
            "max_volunteers": before.max_volunteers,
            "parent_id": before.parent_id,
            "sort_order": before.sort_order,
            "colour": before.colour,
            "shift_pattern_id": before.shift_pattern_id,
        }),
        &[before.id],
    )
    .await?;

    Ok(Versioned::Applied(operation_id))
}
