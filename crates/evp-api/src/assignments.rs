// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/orgs/{org}/events/{event}/assignments` — the core write path
//! (docs/04 §"Assignments").
//!
//! Like [`crate::shifts`], the interesting decision is what this module does
//! **not** check. Three of the six hard rules (docs/02 §5) guard this table
//! and all three are enforced in PostgreSQL — an exclusion constraint, a
//! partial unique index and a constraint trigger. This module maps their
//! SQLSTATEs onto a `422` a coordinator can act on, and re-implements none of
//! them, so the answer to "can double-booking be bypassed?" is *no* rather
//! than "not through this handler".
//!
//! Three verbs of the documented surface, and only three. `PATCH` (a move),
//! `/check`, `/bulk`, `/bulk-cancel` and `/replace` are absent rather than
//! approximated: the board this slice serves places one volunteer at a time,
//! and `/check` in particular is advisory — shipping it before the constraint
//! engine that computes soft warnings would be shipping an endpoint that
//! always answers "no violations" and inviting a client to believe it.

use axum::Router;
use axum::extract::{FromRef, Path};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::catalog::{DataPage, Period, applied, precondition_version, render_period};
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
            "/api/v1/orgs/{org}/events/{event}/assignments",
            get(list_assignments).post(create_assignment),
        )
        .route(
            "/api/v1/orgs/{org}/events/{event}/assignments/{assignment}",
            axum::routing::delete(cancel_assignment),
        )
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct AssignmentResponse {
    pub id: String,
    pub event_id: String,
    pub shift_id: String,
    pub participation_id: String,
    pub volunteer_id: String,
    /// The shift's period, copied onto the row so the database can refuse a
    /// double-booking without a join (docs/03 §3.6). Returned because a client
    /// holding a roster and a shift list still has to draw one before the
    /// other has arrived.
    pub period: Period,
    /// `draft` or `published`. Never `cancelled`: a cancelled placement leaves
    /// the roster listing entirely.
    pub status: String,
    pub assigned_at: String,
    pub version: i32,
}

fn render(assignment: evp_db::assignments::Assignment) -> AssignmentResponse {
    AssignmentResponse {
        id: assignment.id.to_string(),
        event_id: assignment.event_id.to_string(),
        shift_id: assignment.shift_id.to_string(),
        participation_id: assignment.participation_id.to_string(),
        volunteer_id: assignment.volunteer_id.to_string(),
        period: render_period(assignment.period_start, assignment.period_end),
        status: assignment.status,
        assigned_at: assignment.assigned_at.to_string(),
        version: assignment.version,
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAssignmentRequest {
    pub shift_id: String,
    pub participation_id: String,
    /// Soft-constraint codes the coordinator has accepted (ADR-0007, docs/04).
    /// Accepted and stored now so that an override is recorded from the first
    /// day; nothing computes a warning to acknowledge yet, so an empty list is
    /// the only honest value a client can send.
    #[serde(default)]
    pub acknowledge_warnings: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AssignmentWritten {
    pub assignment: AssignmentResponse,
    pub operation_id: String,
}

#[derive(Debug, Deserialize)]
struct EventScopedPath {
    event: Uuid,
}

#[derive(Debug, Deserialize)]
struct AssignmentPath {
    event: Uuid,
    assignment: Uuid,
}

/// Turns the constraints guarding this table into answers a coordinator can
/// act on.
///
/// Each rule gets its own sentence with its own remedy. "This volunteer is
/// already working then" and "this volunteer has withdrawn" are different
/// problems with different fixes, and a single "that is not allowed" would
/// send half the callers looking in the wrong place.
///
/// The double-booking message deliberately does not name the clashing shift.
/// The violation aborts the transaction, so nothing can be read back inside
/// it, and re-opening one to look would be reporting a state that is no longer
/// the one that refused the write. Naming the clash is `/check`'s job
/// (docs/04), which lands with the engine that computes it.
fn map_write_error(error: evp_db::DbError) -> ApiError {
    match error.sqlstate().as_deref() {
        // Covers the duplicate placement as well as the genuine clash: a second
        // placement on the same shift carries the same hours, so the exclusion
        // constraint refuses it before `assignments_one_per_shift` is ever
        // consulted (crates/evp-db/tests/assignments.rs pins that down). The
        // sentence therefore has to be true of both, which is why it names the
        // hours rather than the other shift.
        Some("23P01" | "23505") => ApiError::ValidationFailed(
            "That volunteer is already working during those hours — this shift, or one that \
             overlaps it. Take them off the other shift first, or pick somebody else."
                .to_owned(),
        ),
        Some("23514") if error.constraint().as_deref() == Some("withdrawn_participant") => {
            ApiError::ValidationFailed(
                "That volunteer has declined or withdrawn from this event, so they cannot be \
                 rostered. Change their participation first."
                    .to_owned(),
            )
        }
        Some("23503")
            if error.constraint().as_deref()
                == Some("assignments_participation_is_this_edition") =>
        {
            ApiError::ValidationFailed(
                "That volunteer signed up for a different day of this festival. Enrol them on \
                 this one first."
                    .to_owned(),
            )
        }
        Some("23503") => ApiError::ValidationFailed(
            "shift_id and participation_id must both name rows of this event.".to_owned(),
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

/// The check the schema cannot make from the request alone.
///
/// `assignments.event_id` is set from the *shift* by a trigger, so posting a
/// shift of another day to this event's collection would file a perfectly
/// valid row under a day the caller did not name. Resolving the shift within
/// `{event}` first is what makes the URL mean what it says.
async fn check_shift(org: &mut OrgTx, event_id: Uuid, shift_id: Uuid) -> Result<(), ApiError> {
    if evp_db::shifts::get(&mut org.tx, org.org_id, event_id, shift_id)
        .await
        .map_err(ApiError::from)?
        .is_some()
    {
        Ok(())
    } else {
        Err(ApiError::ValidationFailed(
            "shift_id must name a shift of this event.".to_owned(),
        ))
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

/// `GET …/assignments` — the live roster, cancelled placements excluded.
async fn list_assignments(
    ZoneLead(mut org): ZoneLead,
    Path(path): Path<EventScopedPath>,
) -> Result<axum::Json<DataPage<AssignmentResponse>>, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let assignments = evp_db::assignments::list(&mut org.tx, org.org_id, path.event)
        .await
        .map_err(ApiError::from)?;
    org.commit().await?;

    Ok(axum::Json(DataPage {
        data: assignments.into_iter().map(render).collect(),
        next: None,
    }))
}

/// `POST …/assignments` — put one volunteer on one shift.
async fn create_assignment(
    Coordinator(mut org): Coordinator,
    Path(path): Path<EventScopedPath>,
    JsonBody(request): JsonBody<CreateAssignmentRequest>,
) -> Result<Response, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let shift_id = parse_uuid("shift_id", &request.shift_id)?;
    let participation_id = parse_uuid("participation_id", &request.participation_id)?;
    check_shift(&mut org, path.event, shift_id).await?;

    let written = evp_db::assignments::create(
        &mut org.tx,
        org.org_id,
        path.event,
        org.user_id,
        &evp_db::assignments::NewAssignment {
            shift_id,
            participation_id,
            acknowledged_warnings: request.acknowledge_warnings,
        },
    )
    .await
    .map_err(map_write_error)?;

    let Some((assignment, operation_id)) = written else {
        return Err(ApiError::ValidationFailed(
            "participation_id does not name anybody enrolled in this organisation.".to_owned(),
        ));
    };
    let version = assignment.version;
    org.commit().await?;

    Ok((
        StatusCode::CREATED,
        [(header::ETAG, etag(version))],
        axum::Json(AssignmentWritten {
            assignment: render(assignment),
            operation_id: operation_id.0.to_string(),
        }),
    )
        .into_response())
}

/// `DELETE …/assignments/{id}` — cancels, does not erase (docs/04).
///
/// `If-Match` like every other write on a versioned row: two coordinators
/// staffing the same festival at once is the normal case, and a cancellation
/// sent against a placement somebody else has already replaced must be
/// refused rather than applied to whatever is there now.
async fn cancel_assignment(
    Coordinator(mut org): Coordinator,
    Path(path): Path<AssignmentPath>,
    precondition: Precondition,
) -> Result<StatusCode, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let outcome = evp_db::assignments::cancel(
        &mut org.tx,
        org.org_id,
        path.event,
        org.user_id,
        path.assignment,
        precondition_version(&precondition),
    )
    .await
    .map_err(map_write_error)?;

    applied(outcome, &precondition)?;
    org.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
