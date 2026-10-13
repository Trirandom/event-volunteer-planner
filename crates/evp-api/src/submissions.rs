// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `GET /orgs/{org}/festivals/{festival}/submissions` — volunteer form
//! submissions, for `PlanSubmissionsView` (docs/09, docs/03 §3.10).
//!
//! Read-only for now: nothing in this vertical slice reconciles a submission
//! against the pool, reviews a fuzzy match, or applies an edit — this is the
//! display the coordinator sees once `evp_db::catalog::create_example` (or,
//! later, a real CSV import) has already resolved every submission to a
//! volunteer.

use axum::Router;
use axum::extract::{FromRef, Path};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::error::ApiError;
use crate::org::Coordinator;

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
{
    Router::new().route(
        "/api/v1/orgs/{org}/festivals/{festival}/submissions",
        axum::routing::get(list_submissions),
    )
}

#[derive(Debug, Deserialize)]
struct FestivalPath {
    festival: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AnswerResponse {
    pub question: String,
    pub value: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AvailabilityResponse {
    pub event_id: String,
    /// RFC 3339, UTC.
    pub start: String,
    pub end: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SubmissionResponse {
    pub id: String,
    /// Never null: every submission this endpoint returns has already been
    /// resolved to a volunteer, and a volunteer always has a display name.
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    /// RFC 3339, UTC.
    pub submitted_at: String,
    pub answers: Vec<AnswerResponse>,
    pub availability: Vec<AvailabilityResponse>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SubmissionsResponse {
    pub submissions: Vec<SubmissionResponse>,
}

fn render(submission: evp_db::submissions::Submission) -> SubmissionResponse {
    SubmissionResponse {
        id: submission.id.to_string(),
        display_name: submission.display_name,
        first_name: submission.first_name,
        last_name: submission.last_name,
        submitted_at: submission.submitted_at.to_string(),
        answers: submission
            .answers
            .into_iter()
            .map(|answer| AnswerResponse {
                question: answer.question,
                value: answer.value,
            })
            .collect(),
        availability: submission
            .availability
            .into_iter()
            .map(|window| AvailabilityResponse {
                event_id: window.event_id.to_string(),
                start: window.start.to_string(),
                end: window.end.to_string(),
            })
            .collect(),
    }
}

fn parse_uuid(field: &str, value: &str) -> Result<Uuid, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::ValidationFailed(format!("{field} is not a UUID.")))
}

/// `GET /api/v1/orgs/{org}/festivals/{festival}/submissions`.
///
/// `{festival}` is resolved first — the same reason
/// [`crate::locations::resolve_event`] resolves `{event}` before touching a
/// location: it turns a caller naming another tenant's festival into the same
/// `404` a mistyped id gets, rather than an empty list that would look like a
/// festival with no submissions.
///
/// Sorted by `submitted_at` ascending, oldest first, matching the order a
/// coordinator reviews a campaign's arrivals in.
async fn list_submissions(
    Coordinator(mut org): Coordinator,
    Path(path): Path<FestivalPath>,
) -> Result<axum::Json<SubmissionsResponse>, ApiError> {
    let festival_id = parse_uuid("festival", &path.festival)?;

    evp_db::catalog::get_festival(&mut org.tx, org.org_id, festival_id)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)?;

    let submissions = evp_db::submissions::list(&mut org.tx, org.org_id)
        .await
        .map_err(ApiError::from)?;
    org.commit().await?;

    Ok(axum::Json(SubmissionsResponse {
        submissions: submissions.into_iter().map(render).collect(),
    }))
}
