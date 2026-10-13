// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `GET /orgs/{org}/events/{event}/participations` — who is coming to one
//! edition, and when they said they can work (docs/04 §"Participation and
//! availability") — plus the two `.../participations/{id}/availability`
//! routes: reading one participation's declared windows, and a coordinator's
//! full replace of their own hand-entered ones.
//!
//! The roster list stays read-only. Two of the three writes docs/04 lists
//! beside it — bulk enrol, patch a status — are still deliberately absent
//! rather than stubbed: nothing in this slice performs them, and a route that
//! exists and does half the job is worse than one that is honestly missing.
//! The third, replacing availability, is implemented here, backed by
//! [`evp_db::availability`].
//!
//! The list carries each participation's declared windows. That is what the
//! assignation board ranks its dropdown by, and asking for it per seat would
//! be several hundred round trips for one festival day.

use axum::Router;
use axum::extract::{FromRef, Path};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::catalog::{DataPage, Period, PeriodInput, parse_named_period, render_period};
use crate::error::ApiError;
use crate::extract::JsonBody;
use crate::org::{Coordinator, OrgTx, ZoneLead};

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
{
    Router::new()
        .route(
            "/api/v1/orgs/{org}/events/{event}/participations",
            axum::routing::get(list_participations),
        )
        .route(
            "/api/v1/orgs/{org}/events/{event}/participations/{participation}/availability",
            axum::routing::get(get_availability).put(replace_availability),
        )
}

#[derive(Debug, Deserialize)]
struct EventScopedPath {
    event: Uuid,
}

#[derive(Debug, Deserialize)]
struct ParticipationScopedPath {
    event: Uuid,
    participation: Uuid,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WindowResponse {
    /// `available` or `unavailable`. Both are carried because they answer
    /// different questions, and a volunteer who declared neither is *unknown*
    /// rather than free (docs/03 §3.5).
    pub kind: String,
    pub period: Period,
    /// `declared` for a coordinator's hand-entered window, `submitted` for one
    /// derived from a volunteer's form submission (docs/03 §3.5). The two can
    /// now overlap in time (migration
    /// `20260918141853_availability_windows_provenance_exclusion`) — a
    /// coordinator's window is an override of an overlapping submitted one,
    /// not a second, contradictory fact — so a renderer needs this to tell
    /// them apart. Which one wins at a given instant is left to the caller.
    pub provenance: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ParticipationResponse {
    pub id: String,
    pub volunteer_id: String,
    /// The roster label, exactly as given and never parsed (ADR-0012).
    pub display_name: String,
    /// `invited`, `confirmed`, `declined` or `withdrawn`. The last two cannot
    /// hold an assignment — a constraint trigger refuses it — and are listed
    /// anyway, so that "why can I not pick Chloé?" has an answer on screen.
    pub status: String,
    pub availability: Vec<WindowResponse>,
}

fn render(participant: evp_db::participations::Participant) -> ParticipationResponse {
    ParticipationResponse {
        id: participant.id.to_string(),
        volunteer_id: participant.volunteer_id.to_string(),
        display_name: participant.display_name,
        status: participant.status,
        availability: participant
            .windows
            .into_iter()
            .map(|window| WindowResponse {
                kind: window.kind,
                period: render_period(window.start, window.end),
                provenance: window.provenance,
            })
            .collect(),
    }
}

/// Resolves `{event}` before reading anything under it, so that a caller
/// naming another tenant's event gets the same `404` a mistyped id does rather
/// than an empty list that reads as "nobody signed up".
async fn resolve_event(org: &mut OrgTx, event_id: Uuid) -> Result<(), ApiError> {
    evp_db::catalog::get_event(&mut org.tx, org.org_id, event_id)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)
        .map(drop)
}

async fn list_participations(
    ZoneLead(mut org): ZoneLead,
    Path(path): Path<EventScopedPath>,
) -> Result<axum::Json<DataPage<ParticipationResponse>>, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let participants = evp_db::participations::list(&mut org.tx, org.org_id, path.event)
        .await
        .map_err(ApiError::from)?;
    org.commit().await?;

    Ok(axum::Json(DataPage {
        data: participants.into_iter().map(render).collect(),
        next: None,
    }))
}

// ---------------------------------------------------------------------------
// Availability (docs/04 §"Participation and availability")
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct AvailabilityWindowResponse {
    pub id: String,
    /// `available` or `unavailable` (docs/03 §3.5).
    pub kind: String,
    pub period: Period,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// `declared` or `submitted` — see [`WindowResponse::provenance`].
    pub provenance: String,
}

fn render_window(window: evp_db::availability::Window) -> AvailabilityWindowResponse {
    AvailabilityWindowResponse {
        id: window.id.to_string(),
        kind: window.kind,
        period: render_period(window.start, window.end),
        note: window.note,
        provenance: window.provenance,
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AvailabilityResponse {
    pub windows: Vec<AvailabilityWindowResponse>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AvailabilityWindowInput {
    pub kind: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReplaceAvailabilityRequest {
    pub windows: Vec<AvailabilityWindowInput>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AvailabilityWritten {
    pub windows: Vec<AvailabilityWindowResponse>,
    pub operation_id: String,
}

fn parse_kind(index: usize, value: &str) -> Result<String, ApiError> {
    match value {
        "available" | "unavailable" => Ok(value.to_owned()),
        _ => Err(ApiError::ValidationFailed(format!(
            "windows[{index}].kind must be \"available\" or \"unavailable\"."
        ))),
    }
}

/// Turns `availability_period_valid` and the provenance-scoped exclusion
/// constraint into answers a coordinator can act on.
///
/// Every other constraint on this table — `availability_has_provenance`, the
/// two foreign keys — cannot be tripped from here: this module always sends
/// exactly one of `declared_by`/`source_submission_id`, and `declared_by` is
/// the caller's own, already-authenticated user id.
fn map_write_error(error: evp_db::DbError) -> ApiError {
    match error.sqlstate().as_deref() {
        Some("23P01") => ApiError::ValidationFailed(
            "Two of the submitted windows overlap. Merge or adjust them before saving.".to_owned(),
        ),
        Some("23514") => {
            ApiError::ValidationFailed("A window's period is empty or invalid.".to_owned())
        }
        _ => ApiError::Internal(error),
    }
}

async fn get_availability(
    ZoneLead(mut org): ZoneLead,
    Path(path): Path<ParticipationScopedPath>,
) -> Result<axum::Json<AvailabilityResponse>, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let windows =
        evp_db::availability::get(&mut org.tx, org.org_id, path.event, path.participation)
            .await
            .map_err(ApiError::from)?
            .ok_or(ApiError::NotFound)?;
    org.commit().await?;

    Ok(axum::Json(AvailabilityResponse {
        windows: windows.into_iter().map(render_window).collect(),
    }))
}

/// `PUT .../participations/{id}/availability` — a coordinator's full replace
/// of their own hand-entered windows (docs/04). Requires [`Coordinator`],
/// matching docs/04's "this endpoint is for a coordinator entering
/// availability by hand".
///
/// Scoped to `declared_by`-provenance rows only: a submission-derived window
/// is never touched by this call, whatever it contains (see
/// `evp_db::availability`'s module doc). This is more precise than docs/04's
/// literal wording — "a full replace of that participation's windows" — which
/// would, read literally, also delete a volunteer's submitted answer; docs/04
/// is an ordinary doc, not an ADR, and is being brought in line with this.
async fn replace_availability(
    Coordinator(mut org): Coordinator,
    Path(path): Path<ParticipationScopedPath>,
    JsonBody(request): JsonBody<ReplaceAvailabilityRequest>,
) -> Result<axum::Json<AvailabilityWritten>, ApiError> {
    resolve_event(&mut org, path.event).await?;

    let mut windows = Vec::with_capacity(request.windows.len());
    for (index, input) in request.windows.iter().enumerate() {
        let kind = parse_kind(index, &input.kind)?;
        let (start, end) = parse_named_period(
            &format!("windows[{index}]"),
            &PeriodInput {
                start: input.start.clone(),
                end: input.end.clone(),
            },
        )?;
        windows.push(evp_db::availability::NewWindow {
            kind,
            start,
            end,
            note: input.note.clone(),
        });
    }

    let outcome = evp_db::availability::replace_declared(
        &mut org.tx,
        org.org_id,
        path.event,
        path.participation,
        org.user_id,
        &windows,
    )
    .await
    .map_err(map_write_error)?;

    let (created, operation_id) = outcome.ok_or(ApiError::NotFound)?;
    org.commit().await?;

    Ok(axum::Json(AvailabilityWritten {
        windows: created.into_iter().map(render_window).collect(),
        operation_id: operation_id.0.to_string(),
    }))
}
