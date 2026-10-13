// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The review queue (docs/04 "Batches and submissions", docs/08 §6):
//!
//! ```text
//! GET  /api/v1/orgs/{org}/intake/submissions?state=needs_review
//! POST /api/v1/orgs/{org}/intake/submissions/{sub}/resolve
//!      { action: "match", volunteer_id } | { action: "create_new" }
//!      | { action: "reject", reason } | { action: "reconcile" }
//! ```
//!
//! Coordinator or above, as the submissions page is. `reconcile` is not in
//! docs/04's list: it is the answer to a submission the timing floor held,
//! which was never compared with the pool and so has no candidates to match.
//!
//! The queue is scoped by organisation, like `GET …/festivals/{f}/submissions`
//! (`evp_db::submissions::list` says why).

use axum::Router;
use axum::extract::{FromRef, Path, Query};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::error::ApiError;
use crate::extract::JsonBody;
use crate::org::Coordinator;
use crate::submissions::{AnswerResponse, AvailabilityResponse};

/// A rejection reason is a note for the next coordinator, not an essay.
const MAX_REASON: usize = 500;

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
{
    Router::new()
        .route(
            "/api/v1/orgs/{org}/intake/submissions",
            axum::routing::get(list_queue),
        )
        .route(
            "/api/v1/orgs/{org}/intake/submissions/{sub}/resolve",
            axum::routing::post(resolve),
        )
}

#[derive(Debug, Deserialize)]
struct QueueFilter {
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SubmissionPath {
    sub: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ClaimedResponse {
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CandidateResponse {
    pub volunteer_id: String,
    /// Trigram similarity of the display names, 0 to 1.
    pub score: f32,
    pub last_name_agrees: bool,
    pub phone_agrees: bool,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReasonResponse {
    pub field: String,
    /// `too_fast`, `email_in_use`, `unmappable`, … — what a client branches on.
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReviewItemResponse {
    pub id: String,
    /// RFC 3339, UTC.
    pub received_at: String,
    /// Absent when the payload would not map: only `reject` is offered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed: Option<ClaimedResponse>,
    pub answers: Vec<AnswerResponse>,
    pub availability: Vec<AvailabilityResponse>,
    pub reasons: Vec<ReasonResponse>,
    /// Best first.
    pub candidates: Vec<CandidateResponse>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReviewQueueResponse {
    pub submissions: Vec<ReviewItemResponse>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ResolveInput {
    Match {
        volunteer_id: String,
    },
    CreateNew,
    Reject {
        #[serde(default)]
        reason: String,
    },
    Reconcile,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResolvedState {
    Applied,
    Rejected,
    NeedsReview,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ResolveResponse {
    /// Where the submission is now. `needs_review` only after `reconcile`
    /// found it ambiguous after all.
    pub state: ResolvedState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volunteer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_kind: Option<String>,
    /// The submitted address belongs to another volunteer, so it was not
    /// written (ADR-0028); the coordinator gives this one their own.
    pub email_withheld: bool,
    pub operation_id: String,
}

async fn list_queue(
    Coordinator(mut org): Coordinator,
    Query(filter): Query<QueueFilter>,
) -> Result<axum::Json<ReviewQueueResponse>, ApiError> {
    match filter.state.as_deref() {
        None | Some("needs_review") => {}
        Some(_) => {
            return Err(ApiError::ValidationFailed(
                "Only state=needs_review is listed here.".to_owned(),
            ));
        }
    }
    let items = evp_db::intake::review_queue(&mut org.tx, org.org_id)
        .await
        .map_err(ApiError::from)?;
    org.commit().await?;
    Ok(axum::Json(ReviewQueueResponse {
        submissions: items.into_iter().map(render).collect(),
    }))
}

fn render(item: evp_db::intake::ReviewItem) -> ReviewItemResponse {
    ReviewItemResponse {
        id: item.id.to_string(),
        received_at: item.received_at.to_string(),
        claimed: item.claimed.map(|claimed| ClaimedResponse {
            display_name: claimed.display_name,
            first_name: claimed.first_name,
            last_name: claimed.last_name,
            email: claimed.email,
            phone: claimed.phone,
        }),
        answers: item
            .answers
            .into_iter()
            .map(|answer| AnswerResponse {
                question: answer.question,
                value: answer.value,
            })
            .collect(),
        availability: item
            .availability
            .into_iter()
            .map(|window| AvailabilityResponse {
                event_id: window.event_id.to_string(),
                start: window.start.to_string(),
                end: window.end.to_string(),
            })
            .collect(),
        reasons: item
            .reasons
            .into_iter()
            .map(|reason| ReasonResponse {
                field: reason.field,
                code: reason.code,
                message: reason.message,
            })
            .collect(),
        candidates: item
            .candidates
            .into_iter()
            .map(|candidate| CandidateResponse {
                volunteer_id: candidate.volunteer_id.to_string(),
                score: candidate.score,
                last_name_agrees: candidate.last_name_agrees,
                phone_agrees: candidate.phone_agrees,
                display_name: candidate.display_name,
                first_name: candidate.first_name,
                last_name: candidate.last_name,
                email: candidate.email,
                phone: candidate.phone,
            })
            .collect(),
    }
}

/// `409` when the submission is no longer waiting — another coordinator got
/// there first — so the client reloads the queue rather than retrying.
async fn resolve(
    Coordinator(mut org): Coordinator,
    Path(path): Path<SubmissionPath>,
    JsonBody(input): JsonBody<ResolveInput>,
) -> Result<axum::Json<ResolveResponse>, ApiError> {
    let submission_id: Uuid = path.sub.parse().map_err(|_| ApiError::NotFound)?;
    let resolution = match input {
        ResolveInput::Match { volunteer_id } => {
            evp_db::intake::Resolution::Match(volunteer_id.parse().map_err(|_| {
                ApiError::ValidationFailed("volunteer_id is not a UUID.".to_owned())
            })?)
        }
        ResolveInput::CreateNew => evp_db::intake::Resolution::CreateNew,
        ResolveInput::Reject { reason } => {
            if reason.chars().count() > MAX_REASON {
                return Err(ApiError::ValidationFailed(format!(
                    "reason is longer than {MAX_REASON} characters."
                )));
            }
            evp_db::intake::Resolution::Reject(reason)
        }
        ResolveInput::Reconcile => evp_db::intake::Resolution::Reconcile,
    };

    let outcome = evp_db::intake::resolve(
        &mut org.tx,
        org.org_id,
        org.user_id,
        submission_id,
        &resolution,
    )
    .await
    .map_err(ApiError::from)?;
    let (reviewed, operation_id) = match outcome {
        Ok(done) => done,
        Err(evp_db::intake::Refused::NotPending) => {
            return Err(ApiError::Conflict(
                "This submission is no longer waiting for review.".to_owned(),
            ));
        }
        Err(evp_db::intake::Refused::UnknownVolunteer) => {
            return Err(ApiError::ValidationFailed(
                "volunteer_id names no volunteer of this organisation.".to_owned(),
            ));
        }
        Err(evp_db::intake::Refused::Unmappable) => {
            return Err(ApiError::ValidationFailed(
                "This submission's answers cannot be applied; it can only be rejected.".to_owned(),
            ));
        }
    };
    org.commit().await?;

    let response = match reviewed {
        evp_db::intake::Reviewed::Applied {
            volunteer_id,
            kind,
            email_withheld,
        } => ResolveResponse {
            state: ResolvedState::Applied,
            volunteer_id: Some(volunteer_id.to_string()),
            match_kind: Some(kind.as_str().to_owned()),
            email_withheld,
            operation_id: operation_id.0.to_string(),
        },
        evp_db::intake::Reviewed::Rejected => ResolveResponse {
            state: ResolvedState::Rejected,
            volunteer_id: None,
            match_kind: None,
            email_withheld: false,
            operation_id: operation_id.0.to_string(),
        },
        evp_db::intake::Reviewed::StillNeedsReview => ResolveResponse {
            state: ResolvedState::NeedsReview,
            volunteer_id: None,
            match_kind: None,
            email_withheld: false,
            operation_id: operation_id.0.to_string(),
        },
    };
    Ok(axum::Json(response))
}
