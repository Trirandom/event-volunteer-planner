// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/orgs/{org}/events/{event}/shifts` — the schedule grid
//! (docs/04 §"Events, locations, shifts").
//!
//! The interesting decision here is what this module does **not** validate.
//! Two of the six hard rules (docs/02 §5) guard this table — a shift cannot
//! fall outside its event, and a shift cannot be longer than a day — and both
//! are enforced in PostgreSQL. This module does not re-implement either: it
//! maps their SQLSTATEs onto a `422` a coordinator can act on, so the
//! database stays the single authority and the answer to "can this rule be
//! bypassed?" is no, rather than "not through this handler".
//!
//! What it *does* check is the one thing the schema cannot: that the shift's
//! location belongs to the same event (see
//! [`evp_db::shifts::location_belongs_to`]).

use axum::Router;
use axum::extract::{FromRef, Path, Query};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::{get, patch};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::catalog::{
    DataPage, Period, PeriodInput, applied, parse_period, precondition_version, render_period,
    sent_field,
};
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
            "/api/v1/orgs/{org}/events/{event}/shifts",
            get(list_shifts).post(create_shift),
        )
        .route(
            "/api/v1/orgs/{org}/events/{event}/shifts/generate",
            axum::routing::post(generate_shifts),
        )
        .route(
            "/api/v1/orgs/{org}/events/{event}/shifts/{shift}",
            patch(patch_shift).delete(delete_shift),
        )
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct ShiftResponse {
    pub id: String,
    pub event_id: String,
    pub location_id: String,
    /// Absent means "inherit the location name" (docs/03 §3.4), which is what
    /// most shifts do — a `null` here would invite a client to render one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub period: Period,
    pub required_count: i16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_count: Option<i16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub version: i32,
}

fn render(shift: evp_db::shifts::Shift) -> ShiftResponse {
    ShiftResponse {
        id: shift.id.to_string(),
        event_id: shift.event_id.to_string(),
        location_id: shift.location_id.to_string(),
        title: shift.title,
        period: render_period(shift.period_start, shift.period_end),
        required_count: shift.required_count,
        max_count: shift.max_count,
        notes: shift.notes,
        created_at: shift.created_at.to_string(),
        updated_at: shift.updated_at.to_string(),
        version: shift.version,
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateShiftRequest {
    pub location_id: String,
    pub period: PeriodInput,
    #[serde(default)]
    pub title: Option<String>,
    /// How many volunteers this slot needs. Defaults to one — the overwhelming
    /// majority of posts — and `0` is allowed, for a slot that exists on the
    /// board but is not being staffed.
    #[serde(default)]
    pub required_count: Option<i16>,
    #[serde(default)]
    pub max_count: Option<i16>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchShiftRequest {
    #[serde(default)]
    pub location_id: Option<String>,
    #[serde(default)]
    pub period: Option<PeriodInput>,
    #[serde(default, deserialize_with = "sent_field")]
    #[schema(value_type = Option<String>)]
    pub title: evp_db::catalog::Patch<String>,
    #[serde(default)]
    pub required_count: Option<i16>,
    #[serde(default, deserialize_with = "sent_field")]
    #[schema(value_type = Option<i16>)]
    pub max_count: evp_db::catalog::Patch<i16>,
    #[serde(default, deserialize_with = "sent_field")]
    #[schema(value_type = Option<String>)]
    pub notes: evp_db::catalog::Patch<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ShiftWritten {
    pub shift: ShiftResponse,
    pub operation_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ShiftDeleted {
    pub operation_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ShiftQuery {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EventScopedPath {
    event: Uuid,
}

#[derive(Debug, Deserialize)]
struct ShiftPath {
    event: Uuid,
    shift: Uuid,
}

/// Turns the constraints guarding this table into answers a coordinator can
/// act on.
///
/// The `23514` arm reads the constraint *name* rather than collapsing every
/// check violation into one sentence: "this shift is outside its event" and
/// "this shift is longer than a day" have different remedies, and a single
/// message covering both would send half the callers looking in the wrong
/// place.
fn map_write_error(error: evp_db::DbError) -> ApiError {
    match error.sqlstate().as_deref() {
        Some("23514") => match error.constraint().as_deref() {
            Some("shift_outside_event") => ApiError::ValidationFailed(
                "The shift falls outside its event's period. Move the shift, or widen the event \
                 first."
                    .to_owned(),
            ),
            Some("shifts_period_sane") => ApiError::ValidationFailed(
                "A shift cannot be longer than 24 hours. Split it into consecutive shifts."
                    .to_owned(),
            ),
            Some("shifts_period_valid") => {
                ApiError::ValidationFailed("The shift's period is empty or unbounded.".to_owned())
            }
            _ => ApiError::ValidationFailed(
                "max_count must be at least required_count, and required_count cannot be \
                 negative."
                    .to_owned(),
            ),
        },
        Some("23503") => ApiError::ValidationFailed(
            "location_id does not name a location of this event.".to_owned(),
        ),
        _ => ApiError::Internal(error),
    }
}

async fn resolve_event(org: &mut OrgTx, event_id: Uuid) -> Result<(), ApiError> {
    evp_db::catalog::get_event(&mut org.tx, org.org_id, event_id)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)
        .map(drop)
}

/// The check the schema cannot make (see [`evp_db::shifts::location_belongs_to`]).
async fn check_location(
    org: &mut OrgTx,
    event_id: Uuid,
    location_id: Uuid,
) -> Result<(), ApiError> {
    if evp_db::shifts::location_belongs_to(&mut org.tx, org.org_id, event_id, location_id)
        .await
        .map_err(ApiError::from)?
    {
        Ok(())
    } else {
        Err(ApiError::ValidationFailed(
            "location_id must name a location of this event.".to_owned(),
        ))
    }
}

fn parse_uuid(name: &str, value: &str) -> Result<Uuid, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::ValidationFailed(format!("{name} is not a UUID.")))
}

fn parse_instant(name: &str, value: &str) -> Result<jiff::Timestamp, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::ValidationFailed(format!("{name} is not RFC 3339.")))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list_shifts(
    ZoneLead(mut org): ZoneLead,
    Path(path): Path<EventScopedPath>,
    Query(query): Query<ShiftQuery>,
) -> Result<axum::Json<DataPage<ShiftResponse>>, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let filter = evp_db::shifts::ShiftFilter {
        from: query
            .from
            .as_deref()
            .map(|value| parse_instant("from", value))
            .transpose()?,
        to: query
            .to
            .as_deref()
            .map(|value| parse_instant("to", value))
            .transpose()?,
        location_id: query
            .location
            .as_deref()
            .map(|value| parse_uuid("location", value))
            .transpose()?,
    };

    let shifts = evp_db::shifts::list(&mut org.tx, org.org_id, path.event, filter)
        .await
        .map_err(ApiError::from)?;
    org.commit().await?;

    Ok(axum::Json(DataPage {
        data: shifts.into_iter().map(render).collect(),
        next: None,
    }))
}

async fn create_shift(
    Coordinator(mut org): Coordinator,
    Path(path): Path<EventScopedPath>,
    JsonBody(request): JsonBody<CreateShiftRequest>,
) -> Result<Response, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let period = parse_period(&request.period)?;
    let location_id = parse_uuid("location_id", &request.location_id)?;
    check_location(&mut org, path.event, location_id).await?;

    let (shift, operation_id) = evp_db::shifts::create(
        &mut org.tx,
        org.org_id,
        path.event,
        org.user_id,
        &evp_db::shifts::NewShift {
            location_id,
            title: request.title,
            period,
            required_count: request.required_count.unwrap_or(1),
            max_count: request.max_count,
            notes: request.notes,
        },
    )
    .await
    .map_err(map_write_error)?;
    let version = shift.version;
    org.commit().await?;

    Ok((
        StatusCode::CREATED,
        [(header::ETAG, etag(version))],
        axum::Json(ShiftWritten {
            shift: render(shift),
            operation_id: operation_id.0.to_string(),
        }),
    )
        .into_response())
}

async fn patch_shift(
    Coordinator(mut org): Coordinator,
    Path(path): Path<ShiftPath>,
    precondition: Precondition,
    JsonBody(request): JsonBody<PatchShiftRequest>,
) -> Result<Response, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let location_id = request
        .location_id
        .as_deref()
        .map(|value| parse_uuid("location_id", value))
        .transpose()?;
    if let Some(location_id) = location_id {
        check_location(&mut org, path.event, location_id).await?;
    }

    let changes = evp_db::shifts::ShiftPatch {
        location_id,
        title: request.title,
        period: request.period.as_ref().map(parse_period).transpose()?,
        required_count: request.required_count,
        max_count: request.max_count,
        notes: request.notes,
    };
    if changes.is_empty() {
        return Err(ApiError::Invalid(
            "The request body changes nothing; send at least one field.".to_owned(),
        ));
    }

    let outcome = evp_db::shifts::update(
        &mut org.tx,
        org.org_id,
        path.event,
        org.user_id,
        path.shift,
        precondition_version(&precondition),
        &changes,
    )
    .await
    .map_err(map_write_error)?;

    let (shift, operation_id) = applied(outcome, &precondition)?;
    let version = shift.version;
    org.commit().await?;

    Ok((
        [(header::ETAG, etag(version))],
        axum::Json(ShiftWritten {
            shift: render(shift),
            operation_id: operation_id.0.to_string(),
        }),
    )
        .into_response())
}

/// `DELETE …/shifts/{id}`.
///
/// docs/04 makes this "refuses if assigned, unless `?force=true`". That guard
/// is deliberately absent rather than approximated: `assignments` arrives in
/// M3, and a check against a table that does not exist is a check that always
/// passes — it would ship already believing it works. `?force` is likewise not
/// accepted yet, so a client cannot come to depend on passing it.
async fn delete_shift(
    Coordinator(mut org): Coordinator,
    Path(path): Path<ShiftPath>,
    precondition: Precondition,
) -> Result<StatusCode, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let outcome = evp_db::shifts::delete(
        &mut org.tx,
        org.org_id,
        path.event,
        org.user_id,
        path.shift,
        precondition_version(&precondition),
    )
    .await
    .map_err(map_write_error)?;

    applied(outcome, &precondition)?;
    org.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Generation (docs/04 §"Generating shifts")
// ---------------------------------------------------------------------------

/// The wire shape of a generation run.
///
/// `days` and `window` are **local** — dates and wall-clock times in the
/// event's zone, not instants. That is the contract docs/04 states and the
/// reason [`evp_domain::generate`] walks in civil time: a coordinator saying
/// "09:00 to 14:00 on the 4th" means clock readings, and resolving them to
/// instants before the walk would quietly produce a different schedule across
/// a DST boundary.
#[derive(Debug, Deserialize, ToSchema)]
pub struct GenerateRequest {
    pub locations: Vec<String>,
    /// Local dates in the event's timezone, `YYYY-MM-DD`.
    pub days: Vec<String>,
    pub window: WindowInput,
    /// Overrides the resolution chain. Omitted, the location's pattern is
    /// used, then the event's default.
    #[serde(default)]
    pub pattern_id: Option<String>,
    #[serde(default)]
    pub required_count: Option<i16>,
    #[serde(default)]
    pub max_count: Option<i16>,
    /// Writes nothing and returns the same body. What the bulk editor renders
    /// as a preview.
    #[serde(default)]
    pub dry_run: bool,
}

/// Local wall-clock times, `HH:MM`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct WindowInput {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GeneratedShift {
    /// Absent on a dry run: nothing was written, so there is no id to name,
    /// and inventing one would let a client store a reference to a shift that
    /// does not exist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift_id: Option<String>,
    pub location_id: String,
    pub period: Period,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SkippedDay {
    pub location_id: String,
    pub day: String,
    /// `no_pattern`, `overlaps_existing` or `nonexistent_local_time`. Clients
    /// branch on this, never on `detail`.
    pub reason: String,
    pub detail: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GenerateResponse {
    /// `null` on a dry run — nothing happened, so there is nothing to undo.
    pub operation_id: Option<String>,
    pub created: Vec<GeneratedShift>,
    pub skipped: Vec<SkippedDay>,
    /// Wall-clock minutes of window the pattern did not cover, on the last day
    /// that had any. Never rounded up (docs/04).
    pub remainder_minutes: i64,
}

/// Parses `HH:MM` (or `HH:MM:SS`).
fn parse_local_time(field: &str, value: &str) -> Result<jiff::civil::Time, ApiError> {
    value.parse().map_err(|_| {
        ApiError::ValidationFailed(format!(
            "window.{field} is not a local time like \"09:00\"."
        ))
    })
}

/// Translates the pure walk's refusals into the API's.
///
/// `NonexistentLocalTime` is deliberately **not** here: it is a per-item skip,
/// not a failure of the run, and it is handled at the call site where the
/// location and day it concerns are still in scope.
fn map_generate_error(error: &evp_domain::generate::GenerateError) -> ApiError {
    use evp_domain::generate::GenerateError;
    match *error {
        GenerateError::OnceOverrunsWindow { local } => ApiError::ValidationFailed(format!(
            "The pattern would have ended at {local}, past the window. Widen the window, or \
             use a pattern that fits it."
        )),
        GenerateError::EmptyPattern => ApiError::ValidationFailed(
            "The pattern has no duration and would repeat forever.".to_owned(),
        ),
        GenerateError::NonexistentLocalTime { local } => {
            ApiError::ValidationFailed(format!("{local} does not exist in the event's time zone."))
        }
        GenerateError::OutOfRange => ApiError::ValidationFailed(
            "A generated boundary is not a representable date.".to_owned(),
        ),
    }
}

/// Converts a stored pattern into the pure walk's vocabulary.
///
/// An unrecognised `repeat`, `on_remainder` or segment `kind` falls back to the
/// column default rather than failing: all three are constrained in the schema,
/// so a value outside them means the enum grew and this code has not caught up
/// — and refusing an existing pattern for that reason would break generation on
/// a migration rather than on the deploy that forgot to update this.
fn as_walk_pattern(pattern: &evp_db::patterns::ShiftPattern) -> evp_domain::generate::Pattern {
    use evp_domain::generate::{OnRemainder, Repeat, Segment, SegmentKind};
    evp_domain::generate::Pattern {
        repeat: if pattern.repeat == "once" {
            Repeat::Once
        } else {
            Repeat::Tile
        },
        on_remainder: if pattern.on_remainder == "truncate" {
            OnRemainder::Truncate
        } else {
            OnRemainder::Drop
        },
        segments: pattern
            .segments
            .iter()
            .map(|segment| Segment {
                kind: if segment.kind == "gap" {
                    SegmentKind::Gap
                } else {
                    SegmentKind::Shift
                },
                duration_minutes: i64::from(segment.duration_minutes),
                label: segment.label.clone(),
            })
            .collect(),
    }
}

/// Resolves the pattern for one location, most-specific-first: the request's
/// argument, then `locations.shift_pattern_id`, then
/// `events.default_shift_pattern_id` (docs/04 §"Generating shifts").
///
/// `Ok(None)` is the `no_pattern` skip: a location with nothing in the chain
/// is reported rather than silently given two-hour slots.
async fn resolve_pattern(
    org: &mut OrgTx,
    event: &evp_db::catalog::Event,
    location: &evp_db::locations::Location,
    requested: Option<Uuid>,
) -> Result<Option<evp_db::patterns::ShiftPattern>, ApiError> {
    let Some(pattern_id) = requested
        .or(location.shift_pattern_id)
        .or(event.default_shift_pattern_id)
    else {
        return Ok(None);
    };
    evp_db::patterns::get(&mut org.tx, org.org_id, pattern_id)
        .await
        .map_err(ApiError::from)
}

/// Everything a run works out before it decides whether to write it.
///
/// Split from the handler because "what would this produce?" and "write it"
/// are the two halves a dry run sits between, and a handler that interleaves
/// them makes `dry_run` a flag threaded through the walk rather than a branch
/// after it.
struct Plan {
    planned: Vec<evp_db::shifts::NewShift>,
    /// Parallel to `planned`. Kept separately rather than read back off
    /// `NewShift::title` so that a future generator which stops using the
    /// segment label as the shift title does not silently empty the preview.
    labels: Vec<Option<String>>,
    skipped: Vec<SkippedDay>,
    remainder_minutes: i64,
}

/// Walks every (location, day) pair, resolving the pattern most-specific-first
/// and reporting per-item skips rather than failing the run (ADR-0024).
#[expect(
    clippy::too_many_arguments,
    reason = "one parameter per already-validated piece of the request; bundling them into a struct here would only move the same eight values one level"
)]
async fn plan_run(
    org: &mut OrgTx,
    event: &evp_db::catalog::Event,
    zone: &jiff::tz::TimeZone,
    request: &GenerateRequest,
    event_id: Uuid,
    window: evp_domain::generate::Window,
    requested_pattern: Option<Uuid>,
    days: &[(String, jiff::civil::Date)],
) -> Result<Plan, ApiError> {
    let mut planned: Vec<evp_db::shifts::NewShift> = Vec::new();
    let mut labels: Vec<Option<String>> = Vec::new();
    let mut skipped: Vec<SkippedDay> = Vec::new();
    let mut remainder_minutes = 0_i64;

    for location_id in &request.locations {
        let location_id = parse_uuid("locations[]", location_id)?;
        let Some(location) =
            evp_db::locations::get(&mut org.tx, org.org_id, event_id, location_id).await?
        else {
            return Err(ApiError::ValidationFailed(
                "locations[] must name locations of this event.".to_owned(),
            ));
        };

        let Some(pattern) = resolve_pattern(org, event, &location, requested_pattern).await? else {
            for (day, _parsed) in days {
                skipped.push(SkippedDay {
                    location_id: location_id.to_string(),
                    day: day.clone(),
                    reason: "no_pattern".to_owned(),
                    detail: "This location has no shift pattern, and neither has the event. \
                             Attach one, or name one in pattern_id."
                        .to_owned(),
                });
            }
            continue;
        };
        let walk = as_walk_pattern(&pattern);

        for (day, parsed) in days {
            let plan = match evp_domain::generate::plan_day(zone, *parsed, window, &walk) {
                Ok(plan) => plan,
                // A local time that does not exist is about *this* day, so it
                // is a per-item skip. Everything else is a mistake in the
                // request itself and fails the run.
                Err(evp_domain::generate::GenerateError::NonexistentLocalTime { local }) => {
                    skipped.push(SkippedDay {
                        location_id: location_id.to_string(),
                        day: day.clone(),
                        reason: "nonexistent_local_time".to_owned(),
                        detail: format!(
                            "{local} does not exist in {} — the clocks go forward. Move the \
                             window, or use a pattern whose segments do not land there.",
                            event.timezone
                        ),
                    });
                    continue;
                }
                Err(error) => return Err(map_generate_error(&error)),
            };
            remainder_minutes = plan.remainder_minutes;

            let Some(first) = plan.slots.first() else {
                continue;
            };
            let last_end = plan.slots.last().map_or(first.end, |slot| slot.end);
            if evp_db::shifts::overlaps_existing(
                &mut org.tx,
                org.org_id,
                event_id,
                location_id,
                (first.start, last_end),
            )
            .await
            .map_err(ApiError::from)?
            {
                skipped.push(SkippedDay {
                    location_id: location_id.to_string(),
                    day: day.clone(),
                    reason: "overlaps_existing".to_owned(),
                    detail: "This location already has shifts overlapping that window. \
                             Delete them first, or generate a different day."
                        .to_owned(),
                });
                continue;
            }

            for slot in plan.slots {
                labels.push(slot.label.clone());
                planned.push(evp_db::shifts::NewShift {
                    location_id,
                    title: slot.label,
                    period: (slot.start, slot.end),
                    required_count: request.required_count.unwrap_or(1),
                    max_count: request.max_count,
                    notes: None,
                });
            }
        }
    }
    Ok(Plan {
        planned,
        labels,
        skipped,
        remainder_minutes,
    })
}

/// `POST /api/v1/orgs/{org}/events/{event}/shifts/generate`.
///
/// docs/04 lists `Idempotency-Key` on this route. It is **not** honoured yet —
/// no replay store exists — and it is deliberately neither read nor required,
/// so no client comes to believe a retry is safe when it would double the
/// schedule. What does protect a retry today is `overlaps_existing`: a second
/// run over the same days skips them.
async fn generate_shifts(
    Coordinator(mut org): Coordinator,
    Path(path): Path<EventScopedPath>,
    JsonBody(request): JsonBody<GenerateRequest>,
) -> Result<axum::Json<GenerateResponse>, ApiError> {
    let event = evp_db::catalog::get_event(&mut org.tx, org.org_id, path.event)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)?;

    let zone = jiff::tz::TimeZone::get(&event.timezone).map_err(|_| {
        // The event's timezone is a foreign key into `timezones`, so this can
        // only happen when the server's tzdb is older than the database's.
        ApiError::ValidationFailed(format!(
            "This event's time zone ({}) is not available on the server.",
            event.timezone
        ))
    })?;

    let window = evp_domain::generate::Window {
        start: parse_local_time("start", &request.window.start)?,
        end: parse_local_time("end", &request.window.end)?,
    };
    let requested_pattern = request
        .pattern_id
        .as_deref()
        .map(|value| parse_uuid("pattern_id", value))
        .transpose()?;

    let mut days = Vec::with_capacity(request.days.len());
    for day in &request.days {
        let parsed: jiff::civil::Date = day.parse().map_err(|_| {
            ApiError::ValidationFailed(format!("\"{day}\" is not a date like \"2026-07-04\"."))
        })?;
        days.push((day.clone(), parsed));
    }

    let Plan {
        planned,
        labels,
        skipped,
        remainder_minutes,
    } = plan_run(
        &mut org,
        &event,
        &zone,
        &request,
        path.event,
        window,
        requested_pattern,
        &days,
    )
    .await?;

    // A dry run returns the same body and writes nothing (docs/04), so it
    // stops here — before the inserts and before the operation row. The
    // transaction is dropped without committing, which rolls back the reads
    // above along with it.
    if request.dry_run {
        return Ok(axum::Json(GenerateResponse {
            operation_id: None,
            created: planned
                .iter()
                .zip(labels)
                .map(|(shift, label)| GeneratedShift {
                    shift_id: None,
                    location_id: shift.location_id.to_string(),
                    period: render_period(shift.period.0, shift.period.1),
                    label,
                })
                .collect(),
            skipped,
            remainder_minutes,
        }));
    }

    let (created, operation_id) = evp_db::shifts::create_run(
        &mut org.tx,
        org.org_id,
        path.event,
        org.user_id,
        &planned,
        &request.days,
    )
    .await
    .map_err(map_write_error)?;
    org.commit().await?;

    Ok(axum::Json(GenerateResponse {
        operation_id: Some(operation_id.0.to_string()),
        created: created
            .into_iter()
            .map(|shift| GeneratedShift {
                shift_id: Some(shift.id.to_string()),
                location_id: shift.location_id.to_string(),
                period: render_period(shift.period_start, shift.period_end),
                label: shift.title,
            })
            .collect(),
        skipped,
        remainder_minutes,
    }))
}
