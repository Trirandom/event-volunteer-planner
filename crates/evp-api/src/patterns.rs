// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/orgs/{org}/shift-patterns` — the organisation's catalogue of ways to cut
//! a working window into slots (docs/04 §"Shift patterns", ADR-0029).
//!
//! Three shapes here differ from the rest of the API and each is deliberate:
//!
//! * **`PUT`, not `PATCH`.** A pattern's segment list is one document, and
//!   half an *artiste* pattern is not a pattern — so it is an atomic
//!   replacement rather than a per-item bulk (ADR-0024).
//! * **No position on the wire.** Segments are ordered by their place in the
//!   array and the API assigns positions, so a client cannot send a list whose
//!   `position` fields disagree with its own order.
//! * **`DELETE` is two operations.** A pattern nothing points at is deleted; a
//!   pattern an event or location still names is archived, because last year's
//!   schedule was laid out with it and the row is what records that.

use axum::Router;
use axum::extract::{FromRef, Path, Query};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::error::ApiError;
use crate::extract::{JsonBody, Precondition, etag};
use crate::org::{Coordinator, ZoneLead};

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
{
    Router::new()
        .route(
            "/api/v1/orgs/{org}/shift-patterns",
            get(list_patterns).post(create_pattern),
        )
        .route(
            "/api/v1/orgs/{org}/shift-patterns/{pattern}",
            get(get_pattern).put(replace_pattern).delete(delete_pattern),
        )
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct SegmentInput {
    /// `shift` or `gap`. Defaults to `shift`: a caller listing durations is
    /// describing shifts, and a gap is the deliberate case.
    #[serde(default = "default_segment_kind")]
    pub kind: String,
    pub duration_minutes: i32,
    #[serde(default)]
    pub label: Option<String>,
}

fn default_segment_kind() -> String {
    "shift".to_owned()
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SegmentResponse {
    pub kind: String,
    pub duration_minutes: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ShiftPatternResponse {
    pub id: String,
    pub name: String,
    pub repeat: String,
    pub on_remainder: String,
    pub is_archived: bool,
    pub segments: Vec<SegmentResponse>,
    pub created_at: String,
    pub updated_at: String,
    pub version: i32,
}

fn render(pattern: evp_db::patterns::ShiftPattern) -> ShiftPatternResponse {
    ShiftPatternResponse {
        id: pattern.id.to_string(),
        name: pattern.name,
        repeat: pattern.repeat,
        on_remainder: pattern.on_remainder,
        is_archived: pattern.is_archived,
        segments: pattern
            .segments
            .into_iter()
            .map(|segment| SegmentResponse {
                kind: segment.kind,
                duration_minutes: segment.duration_minutes,
                label: segment.label,
            })
            .collect(),
        created_at: pattern.created_at.to_string(),
        updated_at: pattern.updated_at.to_string(),
        version: pattern.version,
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatternRequest {
    pub name: String,
    #[serde(default = "default_repeat")]
    pub repeat: String,
    #[serde(default = "default_on_remainder")]
    pub on_remainder: String,
    pub segments: Vec<SegmentInput>,
}

fn default_repeat() -> String {
    "tile".to_owned()
}

fn default_on_remainder() -> String {
    "drop".to_owned()
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PatternCreated {
    pub shift_pattern: ShiftPatternResponse,
    pub operation_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PatternReplaced {
    pub shift_pattern: ShiftPatternResponse,
    /// How many existing shifts this edit changed. Always zero, and present
    /// precisely so nobody has to wonder (ADR-0029, docs/04 §"Shift patterns").
    pub affected_shifts: i64,
    pub operation_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PatternArchived {
    pub shift_pattern: ShiftPatternResponse,
    pub operation_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ArchivedFilter {
    #[serde(default)]
    pub archived: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct PatternPath {
    pattern: String,
}

/// Validates the document a caller sent and converts it to what `evp-db`
/// writes.
///
/// The segment-list rules are checked here *as well as* by the
/// `shift_pattern_segments_well_formed` trigger. That is not redundancy for
/// its own sake: the trigger is `DEFERRABLE INITIALLY DEFERRED`, so it fires at
/// `COMMIT` and its message names a pattern id, whereas a coordinator editing
/// a segment list needs to be told which rule they broke while the form is
/// still open. The trigger remains the authority — a caller reaching the
/// database by another route is still refused.
fn validate(request: PatternRequest) -> Result<evp_db::patterns::PatternInput, ApiError> {
    if !matches!(request.repeat.as_str(), "tile" | "once") {
        return Err(ApiError::ValidationFields {
            detail: "repeat must be \"tile\" or \"once\".".to_owned(),
            errors: field("repeat", "must be one of tile, once"),
        });
    }
    if !matches!(request.on_remainder.as_str(), "drop" | "truncate") {
        return Err(ApiError::ValidationFields {
            detail: "on_remainder must be \"drop\" or \"truncate\".".to_owned(),
            errors: field("on_remainder", "must be one of drop, truncate"),
        });
    }
    if request.name.trim().is_empty() {
        return Err(ApiError::ValidationFields {
            detail: "A pattern needs a name.".to_owned(),
            errors: field("name", "must not be empty"),
        });
    }

    let mut segments = Vec::with_capacity(request.segments.len());
    for (index, segment) in request.segments.into_iter().enumerate() {
        if !matches!(segment.kind.as_str(), "shift" | "gap") {
            return Err(ApiError::ValidationFields {
                detail: "A segment is either a \"shift\" or a \"gap\".".to_owned(),
                errors: field(
                    &format!("segments[{index}].kind"),
                    "must be one of shift, gap",
                ),
            });
        }
        // Mirrors `duration_minutes int NOT NULL CHECK (BETWEEN 5 AND 1440)`.
        if !(5..=1440).contains(&segment.duration_minutes) {
            return Err(ApiError::ValidationFields {
                detail: "A segment lasts between 5 minutes and 24 hours.".to_owned(),
                errors: field(
                    &format!("segments[{index}].duration_minutes"),
                    "must be between 5 and 1440",
                ),
            });
        }
        segments.push(evp_db::patterns::Segment {
            kind: segment.kind,
            duration_minutes: segment.duration_minutes,
            label: segment.label,
        });
    }

    // A pattern whose segments are all gaps generates nothing, and a pattern
    // asked to tile a window with nothing in it never terminates in the
    // obvious implementation of the generator.
    if !segments.iter().any(|segment| segment.kind == "shift") {
        return Err(ApiError::ValidationFields {
            detail: "A pattern needs at least one shift segment; one made only of gaps \
                     generates no shifts at all."
                .to_owned(),
            errors: field(
                "segments",
                "must contain at least one segment of kind shift",
            ),
        });
    }

    Ok(evp_db::patterns::PatternInput {
        name: request.name,
        repeat: request.repeat,
        on_remainder: request.on_remainder,
        segments,
    })
}

fn field(name: &str, message: &str) -> std::collections::BTreeMap<String, Vec<String>> {
    std::collections::BTreeMap::from([(name.to_owned(), vec![message.to_owned()])])
}

/// Translates the constraints this module can provoke. Anything else stays an
/// internal error rather than being reported to the caller as their mistake.
fn map_write_error(error: evp_db::DbError) -> ApiError {
    match error.sqlstate().as_deref() {
        Some("23505") => ApiError::Conflict(
            "A shift pattern with this name already exists in this organisation.".to_owned(),
        ),
        // The deferred well-formedness trigger, raised at COMMIT. `validate`
        // catches both of its cases first, so reaching here means a caller got
        // past this module some other way.
        Some("23514") => {
            ApiError::ValidationFailed("The segment list is not a usable pattern.".to_owned())
        }
        _ => ApiError::Internal(error),
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

async fn list_patterns(
    ZoneLead(mut org): ZoneLead,
    Query(filter): Query<ArchivedFilter>,
) -> Result<axum::Json<crate::catalog::DataPage<ShiftPatternResponse>>, ApiError> {
    let patterns =
        evp_db::patterns::list(&mut org.tx, org.org_id, filter.archived.unwrap_or(false))
            .await
            .map_err(ApiError::from)?;
    org.commit().await?;

    Ok(axum::Json(crate::catalog::DataPage {
        data: patterns.into_iter().map(render).collect(),
        next: None,
    }))
}

async fn get_pattern(
    ZoneLead(mut org): ZoneLead,
    Path(path): Path<PatternPath>,
) -> Result<Response, ApiError> {
    let id = parse_uuid("pattern", &path.pattern)?;
    let pattern = evp_db::patterns::get(&mut org.tx, org.org_id, id)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)?;
    org.commit().await?;

    let version = pattern.version;
    Ok(([(header::ETAG, etag(version))], axum::Json(render(pattern))).into_response())
}

async fn create_pattern(
    Coordinator(mut org): Coordinator,
    JsonBody(request): JsonBody<PatternRequest>,
) -> Result<Response, ApiError> {
    let input = validate(request)?;
    let (pattern, operation_id) =
        evp_db::patterns::create(&mut org.tx, org.org_id, org.user_id, &input)
            .await
            .map_err(map_write_error)?;
    let version = pattern.version;
    // The well-formedness trigger is DEFERRABLE INITIALLY DEFERRED, so it
    // fires here and not at the INSERT — which means a commit failure is a
    // caller's malformed pattern, not an internal fault.
    org.tx
        .commit()
        .await
        .map_err(evp_db::DbError::Query)
        .map_err(map_write_error)?;

    Ok((
        StatusCode::CREATED,
        [(header::ETAG, etag(version))],
        axum::Json(PatternCreated {
            shift_pattern: render(pattern),
            operation_id: operation_id.0.to_string(),
        }),
    )
        .into_response())
}

async fn replace_pattern(
    Coordinator(mut org): Coordinator,
    Path(path): Path<PatternPath>,
    precondition: Precondition,
    JsonBody(request): JsonBody<PatternRequest>,
) -> Result<Response, ApiError> {
    let id = parse_uuid("pattern", &path.pattern)?;
    let input = validate(request)?;

    let outcome = evp_db::patterns::replace(
        &mut org.tx,
        org.org_id,
        id,
        org.user_id,
        crate::catalog::precondition_version(&precondition),
        &input,
    )
    .await
    .map_err(map_write_error)?;
    let (pattern, operation_id) = crate::catalog::applied(outcome, &precondition)?;

    // Asked rather than assumed: the claim this number backs is about the
    // database, not about this handler (ADR-0029).
    let affected_shifts = evp_db::patterns::shifts_affected_by(&mut org.tx, org.org_id, pattern.id)
        .await
        .map_err(ApiError::from)?;

    let version = pattern.version;
    org.tx
        .commit()
        .await
        .map_err(evp_db::DbError::Query)
        .map_err(map_write_error)?;

    Ok((
        [(header::ETAG, etag(version))],
        axum::Json(PatternReplaced {
            shift_pattern: render(pattern),
            affected_shifts,
            operation_id: operation_id.0.to_string(),
        }),
    )
        .into_response())
}

/// `DELETE /api/v1/orgs/{org}/shift-patterns/{id}`.
///
/// Archives what is still referenced and deletes what is not (docs/04). The two
/// answer differently — `200` with the archived row, `204` with nothing — so a
/// client can tell which happened without a second read, and the admin UI can
/// say "archived" rather than "deleted" when that is what occurred.
///
/// No `If-Match`: like archiving an event, this is a state transition rather
/// than an edit two coordinators could be racing on, and the caller is not
/// overwriting a value they read.
async fn delete_pattern(
    Coordinator(mut org): Coordinator,
    Path(path): Path<PatternPath>,
) -> Result<Response, ApiError> {
    let id = parse_uuid("pattern", &path.pattern)?;

    if evp_db::patterns::get(&mut org.tx, org.org_id, id)
        .await
        .map_err(ApiError::from)?
        .is_none()
    {
        return Err(ApiError::NotFound);
    }

    if evp_db::patterns::is_referenced(&mut org.tx, org.org_id, id)
        .await
        .map_err(ApiError::from)?
    {
        let (pattern, operation_id) =
            evp_db::patterns::archive(&mut org.tx, org.org_id, id, org.user_id)
                .await
                .map_err(ApiError::from)?
                .ok_or(ApiError::NotFound)?;
        org.commit().await?;
        return Ok(axum::Json(PatternArchived {
            shift_pattern: render(pattern),
            operation_id: operation_id.0.to_string(),
        })
        .into_response());
    }

    evp_db::patterns::delete(&mut org.tx, org.org_id, id, org.user_id)
        .await
        .map_err(ApiError::from)?;
    org.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
