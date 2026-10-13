// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/orgs/{org}/events/{event}/locations` — the zone/post tree
//! (docs/04 §"Events, locations, shifts").
//!
//! Every handler here resolves `{event}` before touching a location, and does
//! so through a query rather than trusting the path. That is not belt-and-
//! braces: `locations` is isolated by `org_id`, so a member of org B naming
//! their own org and an event of org A would otherwise see an empty tree and
//! be allowed to write into it — creating rows pointing at an event the
//! composite foreign key would then reject with a `500`, or worse, accept.
//! Resolving the event first turns all of that into the `404` docs/04 §2 says
//! a caller outside the tenant gets.

use axum::Router;
use axum::extract::{FromRef, Path};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::{get, patch};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::catalog::{DataPage, applied, check_step_divides, precondition_version};
use crate::error::ApiError;
use crate::extract::{JsonBody, Precondition, etag};
use crate::org::{Coordinator, OrgTx, ZoneLead};

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
{
    Router::new()
        .route(
            "/api/v1/orgs/{org}/events/{event}/locations",
            get(list_locations).post(create_location),
        )
        .route(
            "/api/v1/orgs/{org}/events/{event}/locations/{location}",
            patch(patch_location).delete(delete_location),
        )
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct LocationResponse {
    pub id: String,
    pub event_id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub name: String,
    /// The briefing text, when there is one. Skipped rather than sent as
    /// `null` for the same reason `colour` is: absent means "nobody has said",
    /// and a client that has to distinguish it from the empty string is a
    /// client that will get it wrong.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// A postal address a map or courier can resolve. Zones only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_address: Option<String>,
    /// Decimal degrees, WGS 84. Present together with `longitude`. Zones only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    /// The fewest volunteers this mission should be staffed with. Skipped
    /// when nobody has said, like `description` — and for the same reason a
    /// `0` is never sent in its place: zero is a floor someone chose.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(minimum = 0)]
    pub min_volunteers: Option<i16>,
    /// The most volunteers this mission may take; at least `min_volunteers`
    /// when both are present. Skipped when nobody has said.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(minimum = 1)]
    pub max_volunteers: Option<i16>,
    /// Whether the volunteer form offers this mission already ticked; `false`
    /// for a technical mission a volunteer must opt into. Zones only: absent
    /// on a post, which takes its zone's value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_by_default: Option<bool>,
    /// Whether this mission is for volunteers aged 18 or over. Shown on the
    /// form, never enforced there. Zones only, like `checked_by_default`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adults_only: Option<bool>,
    pub sort_order: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colour: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift_pattern_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub version: i32,
    /// The zone's posts. Present on zones in the tree response, absent on a
    /// post and on the single-location responses — a post has no children, and
    /// an empty array there would invite a client to look for them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posts: Option<Vec<LocationResponse>>,
}

fn render(location: evp_db::locations::Location) -> LocationResponse {
    // A post's columns hold the neutral values, not an answer of its own; to
    // send them would invite a client to show a post as "open to minors"
    // inside an adults-only zone.
    let zone_only = |value: bool| (location.kind == "zone").then_some(value);
    LocationResponse {
        checked_by_default: zone_only(location.checked_by_default),
        adults_only: zone_only(location.adults_only),
        id: location.id.to_string(),
        event_id: location.event_id.to_string(),
        parent_id: location.parent_id.map(|id| id.to_string()),
        kind: location.kind,
        name: location.name,
        description: location.description,
        address: location.address,
        exact_address: location.exact_address,
        latitude: location.latitude,
        longitude: location.longitude,
        min_volunteers: location.min_volunteers,
        max_volunteers: location.max_volunteers,
        sort_order: location.sort_order,
        colour: location.colour,
        shift_pattern_id: location.shift_pattern_id.map(|id| id.to_string()),
        created_at: location.created_at.to_string(),
        updated_at: location.updated_at.to_string(),
        version: location.version,
        posts: None,
    }
}

/// Folds the flat, already-ordered list into the two-level tree.
///
/// A post whose parent is not in the list is dropped rather than promoted to a
/// zone: it cannot exist — `locations_hierarchy` and the cascade see to that —
/// and inventing a place for it would hide a schema fault behind a plausible
/// board.
fn as_tree(locations: Vec<evp_db::locations::Location>) -> Vec<LocationResponse> {
    let mut zones: Vec<LocationResponse> = Vec::new();
    for location in locations {
        let parent_id = location.parent_id;
        let rendered = render(location);
        match parent_id {
            None => zones.push(LocationResponse {
                posts: Some(Vec::new()),
                ..rendered
            }),
            Some(parent_id) => {
                let parent_id = parent_id.to_string();
                if let Some(zone) = zones.iter_mut().find(|zone| zone.id == parent_id)
                    && let Some(posts) = zone.posts.as_mut()
                {
                    posts.push(rendered);
                }
            }
        }
    }
    zones
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateLocationRequest {
    /// `zone` or `post`.
    pub kind: String,
    pub name: String,
    /// What the job is. Blank and absent are the same request — see
    /// [`described`].
    #[serde(default)]
    pub description: Option<String>,
    /// Where to stand. Free text; the schema stores it as typed.
    #[serde(default)]
    pub address: Option<String>,
    /// A postal address a map or courier can resolve. Zones only — refused on
    /// a post, which routes through its zone.
    #[serde(default)]
    pub exact_address: Option<String>,
    /// Decimal degrees, WGS 84. Sent together with `longitude`, typically for
    /// a site with no postal address to give instead. Zones only.
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    /// The fewest volunteers this mission should be staffed with. Zones and
    /// posts alike; omitted or `null` means nobody has said.
    #[serde(default)]
    #[schema(minimum = 0)]
    pub min_volunteers: Option<i16>,
    /// The most volunteers this mission may take. At least 1, and at least
    /// `min_volunteers` when both are sent.
    #[serde(default)]
    #[schema(minimum = 1)]
    pub max_volunteers: Option<i16>,
    /// Whether the volunteer form offers this mission already ticked.
    /// Zones only; omitted means `true`, the common case.
    #[serde(default)]
    pub checked_by_default: Option<bool>,
    /// Whether this mission is for volunteers aged 18 or over. Zones only;
    /// omitted means `false`.
    #[serde(default)]
    pub adults_only: Option<bool>,
    /// Required for a post, refused for a zone (docs/03 §3.4: exactly two
    /// levels).
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub colour: Option<String>,
    #[serde(default)]
    pub shift_pattern_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchLocationRequest {
    #[serde(default)]
    pub name: Option<String>,
    /// `null` clears the briefing, a string replaces it, omitted leaves it.
    /// A string of spaces is `null` — [`described`] says why.
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<String>)]
    pub description: evp_db::catalog::Patch<String>,
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<String>)]
    pub address: evp_db::catalog::Patch<String>,
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<String>)]
    pub exact_address: evp_db::catalog::Patch<String>,
    /// Sent and cleared together with `longitude`; setting one without the
    /// other is rejected (`locations_latitude_longitude_together`).
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<f64>)]
    pub latitude: evp_db::catalog::Patch<f64>,
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<f64>)]
    pub longitude: evp_db::catalog::Patch<f64>,
    /// `null` clears the floor, a number replaces it, omitted leaves it. Sent
    /// alone, it is checked against the stored `max_volunteers`, not against
    /// nothing — a floor above the ceiling already there is refused.
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<i16>, minimum = 0)]
    pub min_volunteers: evp_db::catalog::Patch<i16>,
    /// The same tri-state for the ceiling, checked against the stored
    /// `min_volunteers` when sent alone.
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<i16>, minimum = 1)]
    pub max_volunteers: evp_db::catalog::Patch<i16>,
    /// Zones only. Two-state: there is no "nobody has said" to clear back to,
    /// so `null` is the same as omitted.
    #[serde(default)]
    pub checked_by_default: Option<bool>,
    /// Zones only, like `checked_by_default`.
    #[serde(default)]
    pub adults_only: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<String>)]
    pub colour: evp_db::catalog::Patch<String>,
    /// `null` drops back to the event's default division (ADR-0029).
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<String>)]
    pub shift_pattern_id: evp_db::catalog::Patch<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct LocationWritten {
    pub location: LocationResponse,
    pub operation_id: String,
}

#[derive(Debug, Deserialize)]
struct EventScopedPath {
    event: Uuid,
}

#[derive(Debug, Deserialize)]
struct LocationPath {
    event: Uuid,
    location: Uuid,
}

fn map_write_error(error: evp_db::DbError) -> ApiError {
    match error.sqlstate().as_deref() {
        // locations_event_id_parent_id_name_key
        Some("23505") => ApiError::Conflict(
            "A location with this name already exists under that parent.".to_owned(),
        ),
        // Read by name, because this one *is* reachable by an honest caller:
        // `patch_location` compares a one-sided send against the stored other
        // side, and a concurrent PATCH to that other side between the read
        // and the UPDATE lands here. Answered with the same field-named 422
        // `validate_volunteer_bounds` gives, so a client renders one shape.
        Some("23514")
            if error.constraint().as_deref() == Some("locations_volunteer_bounds_ordered") =>
        {
            bounds_out_of_order()
        }
        // Refused up front by `form_flags_on_a_post`, so reaching here is a
        // concurrent writer or a caller that got past this module.
        Some("23514")
            if error.constraint().as_deref() == Some("locations_posts_have_no_form_flags") =>
        {
            form_flags_on_a_post()
        }
        // locations_hierarchy, locations_posts_have_no_map_data,
        // locations_latitude_longitude_together: `validate_parent` and
        // `validate_map_data` refuse the first two up front, and `described`
        // normalises the not-blank checks away, so reaching here means a
        // caller got past this module some other way.
        Some("23514") => ApiError::ValidationFailed(
            "A zone has no parent and a post must have one; exact_address, latitude and \
             longitude are zone-only; latitude and longitude must be sent together; and a \
             description, address or exact_address that is present must not be blank."
                .to_owned(),
        ),
        // An unknown shift_pattern_id, or a parent that vanished between the
        // check and the insert.
        Some("23503") => ApiError::ValidationFailed(
            "parent_id or shift_pattern_id does not name a row in this organisation.".to_owned(),
        ),
        _ => ApiError::Internal(error),
    }
}

/// `locations_posts_have_no_form_flags`, said before the round trip: a post
/// takes its zone's flags and has none of its own to set.
fn form_flags_on_a_post() -> ApiError {
    ApiError::ValidationFailed(
        "checked_by_default and adults_only are zone-only; a post takes its zone's values."
            .to_owned(),
    )
}

/// The per-field refusal for a ceiling below the floor, shared by the
/// up-front check and the constraint mapping so both say the same thing.
fn bounds_out_of_order() -> ApiError {
    ApiError::ValidationFields {
        detail: "max_volunteers must be at least min_volunteers.".to_owned(),
        errors: std::collections::BTreeMap::from([(
            "max_volunteers".to_owned(),
            vec!["must be at least min_volunteers".to_owned()],
        )]),
    }
}

/// The three rules of migration `…120000`, stated before the round trip with
/// the offending field named, over the bounds the row *will* have — for a
/// PATCH that is the sent side merged with the stored one, which is why this
/// takes resolved values rather than the request.
///
/// Mirrors the two unnamed column checks as well as
/// `locations_volunteer_bounds_ordered`: those would surface as a bare
/// `23514` with a constraint name no client should have to know, and a
/// negative floor is exactly the kind of typo a number input produces.
fn validate_volunteer_bounds(min: Option<i16>, max: Option<i16>) -> Result<(), ApiError> {
    if min.is_some_and(|min| min < 0) {
        return Err(ApiError::ValidationFields {
            detail: "min_volunteers cannot be negative.".to_owned(),
            errors: std::collections::BTreeMap::from([(
                "min_volunteers".to_owned(),
                vec!["must be at least 0".to_owned()],
            )]),
        });
    }
    // A ceiling of zero is refused rather than read as "closed": a mission
    // nobody may staff is a mission to delete.
    if max.is_some_and(|max| max < 1) {
        return Err(ApiError::ValidationFields {
            detail: "max_volunteers must be at least 1.".to_owned(),
            errors: std::collections::BTreeMap::from([(
                "max_volunteers".to_owned(),
                vec!["must be at least 1".to_owned()],
            )]),
        });
    }
    if let (Some(min), Some(max)) = (min, max)
        && max < min
    {
        return Err(bounds_out_of_order());
    }
    Ok(())
}

/// What a tri-state send leaves the column as, given what is stored.
fn patched<T: Copy>(sent: evp_db::catalog::Patch<T>, stored: Option<T>) -> Option<T> {
    use evp_db::catalog::Patch;
    match sent {
        Patch::Unchanged => stored,
        Patch::Clear => None,
        Patch::Set(value) => Some(value),
    }
}

/// Resolves `{event}` on the caller's transaction, so everything after it is
/// scoped to an event this tenant can actually see.
async fn resolve_event(
    org: &mut OrgTx,
    event_id: Uuid,
) -> Result<evp_db::catalog::Event, ApiError> {
    evp_db::catalog::get_event(&mut org.tx, org.org_id, event_id)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)
}

/// The pattern/step rule (docs/04 §"Shift patterns") at the location
/// attachment point. `None` is the common case and always fine: a location
/// with no pattern of its own inherits the event's, which was checked when it
/// was attached there.
async fn check_pattern(
    org: &mut OrgTx,
    event: &evp_db::catalog::Event,
    pattern_id: Option<Uuid>,
) -> Result<(), ApiError> {
    let Some(pattern_id) = pattern_id else {
        return Ok(());
    };
    let pattern = evp_db::patterns::get(&mut org.tx, org.org_id, pattern_id)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(|| {
            ApiError::ValidationFailed(
                "shift_pattern_id does not name a shift pattern in this organisation.".to_owned(),
            )
        })?;
    check_step_divides(
        event.availability_step_minutes,
        &pattern,
        "shift_pattern_id",
    )
}

/// Trimmed, and blank becomes "nothing said".
///
/// A form posts `""` for a field the coordinator left empty, and a form that
/// has been typed in and cleared again posts the same thing. Both mean the
/// briefing is gone, which is `NULL` — `locations_description_not_blank`
/// refuses the alternative, so normalising here is what turns a routine empty
/// field into a `200` instead of a `500`.
fn described(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

/// The same rule over a tri-state: a cleared field and a field of spaces both
/// say `NULL`, and only an unsent key leaves the column alone.
fn described_patch(value: evp_db::catalog::Patch<String>) -> evp_db::catalog::Patch<String> {
    use evp_db::catalog::Patch;
    match value {
        Patch::Unchanged => Patch::Unchanged,
        Patch::Clear => Patch::Clear,
        Patch::Set(text) => described(Some(text)).map_or(Patch::Clear, Patch::Set),
    }
}

fn parse_uuid(name: &str, value: &str) -> Result<Uuid, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::ValidationFailed(format!("{name} is not a UUID.")))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list_locations(
    ZoneLead(mut org): ZoneLead,
    Path(path): Path<EventScopedPath>,
) -> Result<axum::Json<DataPage<LocationResponse>>, ApiError> {
    resolve_event(&mut org, path.event).await?;
    let locations = evp_db::locations::list(&mut org.tx, org.org_id, path.event)
        .await
        .map_err(ApiError::from)?;
    org.commit().await?;

    Ok(axum::Json(DataPage {
        data: as_tree(locations),
        next: None,
    }))
}

async fn create_location(
    Coordinator(mut org): Coordinator,
    Path(path): Path<EventScopedPath>,
    JsonBody(request): JsonBody<CreateLocationRequest>,
) -> Result<Response, ApiError> {
    let event = resolve_event(&mut org, path.event).await?;

    if !matches!(request.kind.as_str(), "zone" | "post") {
        return Err(ApiError::ValidationFailed(
            "kind must be \"zone\" or \"post\".".to_owned(),
        ));
    }
    if request.name.trim().is_empty() {
        return Err(ApiError::ValidationFailed(
            "A location needs a name.".to_owned(),
        ));
    }

    let parent_id = request
        .parent_id
        .as_deref()
        .map(|value| parse_uuid("parent_id", value))
        .transpose()?;
    validate_parent(&mut org, path.event, &request.kind, parent_id).await?;
    validate_map_data(
        &request.kind,
        request.exact_address.is_some(),
        request.latitude,
        request.longitude,
    )?;
    validate_volunteer_bounds(request.min_volunteers, request.max_volunteers)?;
    if request.kind == "post"
        && (request.checked_by_default.is_some() || request.adults_only.is_some())
    {
        return Err(form_flags_on_a_post());
    }

    let shift_pattern_id = request
        .shift_pattern_id
        .as_deref()
        .map(|value| parse_uuid("shift_pattern_id", value))
        .transpose()?;
    check_pattern(&mut org, &event, shift_pattern_id).await?;

    let (location, operation_id) = evp_db::locations::create(
        &mut org.tx,
        org.org_id,
        path.event,
        org.user_id,
        &evp_db::locations::NewLocation {
            kind: request.kind,
            name: request.name,
            description: described(request.description),
            address: described(request.address),
            exact_address: described(request.exact_address),
            latitude: request.latitude,
            longitude: request.longitude,
            min_volunteers: request.min_volunteers,
            max_volunteers: request.max_volunteers,
            checked_by_default: request.checked_by_default.unwrap_or(true),
            adults_only: request.adults_only.unwrap_or(false),
            parent_id,
            sort_order: request.sort_order.unwrap_or(0),
            colour: request.colour,
            shift_pattern_id,
        },
    )
    .await
    .map_err(map_write_error)?;
    let version = location.version;
    org.commit().await?;

    Ok((
        StatusCode::CREATED,
        [(header::ETAG, etag(version))],
        axum::Json(LocationWritten {
            location: render(location),
            operation_id: operation_id.0.to_string(),
        }),
    )
        .into_response())
}

/// The half of `locations_hierarchy` the schema can state, plus the half it
/// cannot.
///
/// The `CHECK` says a zone has no parent and a post has one. It says nothing
/// about *which* parent, because the composite foreign key carries `org_id`
/// and not `event_id` — see [`evp_db::locations::parent_is_a_zone_of`].
async fn validate_parent(
    org: &mut OrgTx,
    event_id: Uuid,
    kind: &str,
    parent_id: Option<Uuid>,
) -> Result<(), ApiError> {
    match (kind, parent_id) {
        ("zone", Some(_)) => Err(ApiError::ValidationFailed(
            "A zone is a top-level location and takes no parent_id; the tree is exactly two \
             levels (docs/03 §3.4)."
                .to_owned(),
        )),
        ("post", None) => Err(ApiError::ValidationFailed(
            "A post belongs to a zone; send parent_id.".to_owned(),
        )),
        ("post", Some(parent_id)) => {
            if evp_db::locations::parent_is_a_zone_of(&mut org.tx, org.org_id, event_id, parent_id)
                .await
                .map_err(ApiError::from)?
            {
                Ok(())
            } else {
                Err(ApiError::ValidationFailed(
                    "parent_id must name a zone of this event.".to_owned(),
                ))
            }
        }
        _ => Ok(()),
    }
}

/// The half of `locations_posts_have_no_map_data` and
/// `locations_latitude_longitude_together` the caller can be told about
/// before a round trip: a post routing question through its own zone has no
/// map fields of its own, and a pin needs both coordinates or neither.
fn validate_map_data(
    kind: &str,
    has_exact_address: bool,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(), ApiError> {
    if kind == "post" && (has_exact_address || latitude.is_some() || longitude.is_some()) {
        return Err(ApiError::ValidationFailed(
            "exact_address, latitude and longitude are zone-only; a post is reached through its \
             zone."
                .to_owned(),
        ));
    }
    if latitude.is_some() != longitude.is_some() {
        return Err(ApiError::ValidationFailed(
            "latitude and longitude must be sent together.".to_owned(),
        ));
    }
    Ok(())
}

async fn patch_location(
    Coordinator(mut org): Coordinator,
    Path(path): Path<LocationPath>,
    precondition: Precondition,
    JsonBody(request): JsonBody<PatchLocationRequest>,
) -> Result<Response, ApiError> {
    let event = resolve_event(&mut org, path.event).await?;

    let shift_pattern_id =
        crate::catalog::parse_patch_uuid("shift_pattern_id", request.shift_pattern_id)?;
    if let evp_db::catalog::Patch::Set(pattern_id) = shift_pattern_id {
        check_pattern(&mut org, &event, Some(pattern_id)).await?;
    }

    let touches_map_data = request.exact_address.is_sent()
        || request.latitude.is_sent()
        || request.longitude.is_sent();
    let touches_bounds = request.min_volunteers.is_sent() || request.max_volunteers.is_sent();
    let touches_form_flags = request.checked_by_default.is_some() || request.adults_only.is_some();
    // One read serves every check. It happens outside the `UPDATE`'s version
    // guard, so a stale `If-Match` still gets its `409` from `update` below —
    // this read only decides what is coherent, not what is current.
    let stored = if touches_map_data || touches_bounds || touches_form_flags {
        Some(
            evp_db::locations::get(&mut org.tx, org.org_id, path.event, path.location)
                .await
                .map_err(ApiError::from)?
                .ok_or(ApiError::NotFound)?,
        )
    } else {
        None
    };
    if touches_bounds && let Some(location) = &stored {
        validate_volunteer_bounds(
            patched(request.min_volunteers, location.min_volunteers),
            patched(request.max_volunteers, location.max_volunteers),
        )?;
    }
    if touches_form_flags
        && let Some(location) = &stored
        && location.kind == "post"
    {
        return Err(form_flags_on_a_post());
    }
    if touches_map_data && let Some(location) = &stored {
        if location.kind == "post" {
            return Err(ApiError::ValidationFailed(
                "exact_address, latitude and longitude are zone-only; a post is reached through \
                 its zone."
                    .to_owned(),
            ));
        }
        if request.latitude.is_sent() != request.longitude.is_sent() {
            return Err(ApiError::ValidationFailed(
                "latitude and longitude must be sent together.".to_owned(),
            ));
        }
    }

    let changes = evp_db::locations::LocationPatch {
        name: request.name,
        description: described_patch(request.description),
        address: described_patch(request.address),
        exact_address: described_patch(request.exact_address),
        latitude: request.latitude,
        longitude: request.longitude,
        min_volunteers: request.min_volunteers,
        max_volunteers: request.max_volunteers,
        checked_by_default: request.checked_by_default,
        adults_only: request.adults_only,
        sort_order: request.sort_order,
        colour: request.colour,
        shift_pattern_id,
    };
    if changes.is_empty() {
        return Err(ApiError::Invalid(
            "The request body changes nothing; send at least one field.".to_owned(),
        ));
    }

    let outcome = evp_db::locations::update(
        &mut org.tx,
        org.org_id,
        path.event,
        path.location,
        org.user_id,
        precondition_version(&precondition),
        &changes,
    )
    .await
    .map_err(map_write_error)?;

    let (location, operation_id) = applied(outcome, &precondition)?;
    let version = location.version;
    org.commit().await?;

    Ok((
        [(header::ETAG, etag(version))],
        axum::Json(LocationWritten {
            location: render(location),
            operation_id: operation_id.0.to_string(),
        }),
    )
        .into_response())
}

/// `DELETE …/locations/{id}`.
///
/// A zone takes its posts and every location takes its shifts, through the
/// cascade the schema declares. There is deliberately no "refuse if it holds
/// shifts" here: the shift-level endpoint has that guard, and a coordinator
/// removing a post that no longer exists at the event is removing its shifts
/// on purpose.
async fn delete_location(
    Coordinator(mut org): Coordinator,
    Path(path): Path<LocationPath>,
    precondition: Precondition,
) -> Result<StatusCode, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let outcome = evp_db::locations::delete(
        &mut org.tx,
        org.org_id,
        path.event,
        path.location,
        org.user_id,
        precondition_version(&precondition),
    )
    .await
    .map_err(map_write_error)?;

    applied(outcome, &precondition)?;
    org.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
