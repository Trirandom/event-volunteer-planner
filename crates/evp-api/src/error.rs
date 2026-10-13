// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! RFC 9457 `application/problem+json`, shaped in exactly one place.
//!
//! One mapping, so that "what does the user see when this fails?" has one
//! answer and adding a variant cannot quietly invent a new error shape
//! (docs/04 §Error format, docs/11 §2).
//!
//! "Exactly one place" is a claim about this crate, and it was briefly untrue.
//! A rejected *request body* never reached a handler, so it never reached
//! [`ApiError`] either: `axum::Json` answered `text/plain` with serde's own
//! message, and a client written against docs/04 had no `type` to branch on.
//! The fix is [`crate::extract::JsonBody`], which routes every
//! `JsonRejection` back through the variants below; the claim holds again
//! because an extractor that rejects with anything other than an `ApiError`
//! now has to be written deliberately.

use std::collections::BTreeMap;

use axum::Json;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

/// The error body. `violations` is absent here and arrives with the constraint
/// engine in M3, which is the first thing that has any.
#[derive(Debug, Serialize, ToSchema)]
pub struct Problem {
    /// Stable URI identifying the *kind* of error. Clients branch on this, not
    /// on `title`, which is prose and may be translated or reworded.
    #[serde(rename = "type")]
    pub kind: String,
    /// Short human-readable summary.
    pub title: String,
    /// The HTTP status, repeated in the body so a logged or forwarded body is
    /// self-contained.
    pub status: u16,
    /// What went wrong this time, when there is anything safe to add.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Per-field messages, for the validation failures a form can render
    /// beside the offending input (docs/04 §Error format). Absent rather than
    /// empty when the failure names no field, so a client can branch on
    /// presence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<BTreeMap<String, Vec<String>>>,
    /// Everything wrong with a form version, one entry per question (or per
    /// omission), for `PUT …/versions/{v}` and `…/publish` (docs/04 §"The
    /// volunteer form"). Absent on every other failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problems: Option<Vec<PublishProblem>>,
}

/// One thing wrong with a form version. `position` is the question's index
/// in the list — the same number as its `position` — or `null` for an
/// omission no single question is responsible for, such as a missing
/// processing consent. Clients branch on `code`; `message` is prose.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PublishProblem {
    pub position: Option<i32>,
    pub code: String,
    pub message: String,
}

impl From<evp_domain::form::Problem> for PublishProblem {
    fn from(problem: evp_domain::form::Problem) -> Self {
        Self {
            // A question list long enough to overflow `i32` never reaches
            // here — the body limit refuses it first — so saturating is a
            // formality, not a policy.
            position: problem
                .position
                .map(|position| i32::try_from(position).unwrap_or(i32::MAX)),
            code: problem.code.as_str().to_owned(),
            message: problem.message,
        }
    }
}

/// Everything a handler in this crate may fail with.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// The caller is not authenticated, or their session has expired.
    #[error("authentication required")]
    Unauthenticated,
    /// The credentials presented did not match.
    ///
    /// One variant for "no such account", "no password on that account" and
    /// "wrong password" — the three must be indistinguishable from outside, or
    /// the endpoint becomes a way to enumerate who has an account (docs/12).
    #[error("invalid credentials")]
    InvalidCredentials,
    /// The request body was structurally fine but semantically unusable.
    #[error("{0}")]
    Invalid(String),
    /// The request body could not be read as JSON at all — truncated, empty,
    /// or something else entirely.
    ///
    /// Distinct from [`Self::Invalid`] because the statuses differ and the
    /// remedies differ: this caller has to fix their serialiser, an `Invalid`
    /// caller has to fix a field. Collapsing the two into `422` would tell the
    /// first one to go looking in the wrong place (docs/04 §2).
    #[error("malformed request body")]
    Malformed,
    /// The request body arrived without the media type the endpoint reads.
    ///
    /// `415` rather than `400`: nothing is wrong with the body, and the caller
    /// fixes this by setting one header.
    #[error("unsupported media type")]
    UnsupportedMediaType,
    /// The caller has made more attempts on a throttled route than the
    /// deployment allows from one address.
    ///
    /// Carries the wait rather than computing it here: the quota belongs to
    /// [`crate::ratelimit`], and a `Retry-After` this module invented would
    /// be a number with nothing behind it.
    #[error("too many requests")]
    RateLimited {
        /// Whole seconds until the next attempt is accepted. Never zero — a
        /// client that obeys it must not land in the same refusal.
        retry_after_seconds: u64,
    },
    /// The request body exceeded the limit the server will buffer.
    ///
    /// Reached through axum's default body limit, so it needs no configuration
    /// to occur — and answering `400` to it would send a caller to inspect
    /// JSON that was never the problem.
    #[error("request body too large")]
    PayloadTooLarge,
    /// The resource does not exist, or exists in an organisation this caller
    /// is not a member of — the two are indistinguishable by design (docs/04
    /// §2): telling them apart would leak the existence of other tenants'
    /// records.
    #[error("not found")]
    NotFound,
    /// Authenticated, a member of the organisation, but not of a role this
    /// route requires.
    #[error("forbidden")]
    Forbidden,
    /// The request is well-formed but conflicts with the current state: a
    /// slug already in use, or an example requested for an org that already
    /// has one.
    #[error("{0}")]
    Conflict(String),
    /// A body field failed a rule the JSON schema cannot express: an unknown
    /// IANA timezone, an empty or inverted period, a slug that is not
    /// `organizations_slug_format`-shaped.
    #[error("{0}")]
    ValidationFailed(String),
    /// The same failure, but the offending fields are known and worth naming.
    ///
    /// A separate variant rather than an `Option` on the one above, so that a
    /// call site which *can* name the field is written that way deliberately
    /// — the pattern/step rule in docs/04 §"Shift patterns" is specified with
    /// its `errors` map, and an optional field would let it be omitted by
    /// accident.
    #[error("{detail}")]
    ValidationFields {
        /// The sentence a client shows when it renders nothing per-field.
        detail: String,
        /// Field name to the messages against it.
        errors: BTreeMap<String, Vec<String>>,
    },
    /// A form version's question list broke the authoring rules
    /// (`evp_domain::form`). A variant of its own because the contract names
    /// the shape — `problems`, each with a position — and a client renders
    /// every entry against its question at once.
    #[error("{detail}")]
    FormProblems {
        detail: String,
        problems: Vec<PublishProblem>,
    },
    /// An unsafe method arrived on a versioned resource with no `If-Match`.
    ///
    /// `428` rather than a silent overwrite (docs/04 §1): the caller has not
    /// said which version they read, so honouring the write would mean
    /// discarding whatever landed in between without anybody finding out.
    #[error("precondition required")]
    PreconditionRequired,
    /// The public form's proof of work (ADR-0043) is missing, forged, wrong,
    /// expired or already spent. One variant for all five: which one is a
    /// hint to whoever is scripting against the route, and the bundle's
    /// remedy is the same for each — fetch a fresh challenge and send again.
    #[error("captcha failed")]
    CaptchaFailed,
    /// Anything unexpected. The cause goes to the log, never to the caller.
    #[error("internal error")]
    Internal(#[source] evp_db::DbError),
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            Self::Unauthenticated | Self::InvalidCredentials => StatusCode::UNAUTHORIZED,
            Self::Invalid(_)
            | Self::ValidationFailed(_)
            | Self::ValidationFields { .. }
            | Self::FormProblems { .. }
            | Self::CaptchaFailed => StatusCode::UNPROCESSABLE_ENTITY,
            Self::PreconditionRequired => StatusCode::PRECONDITION_REQUIRED,
            Self::Malformed => StatusCode::BAD_REQUEST,
            Self::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Unauthenticated => "https://evp.example/errors/unauthenticated",
            Self::InvalidCredentials => "https://evp.example/errors/invalid-credentials",
            Self::Invalid(_) => "https://evp.example/errors/invalid-request",
            Self::Malformed => "https://evp.example/errors/malformed-body",
            Self::UnsupportedMediaType => "https://evp.example/errors/unsupported-media-type",
            Self::PayloadTooLarge => "https://evp.example/errors/payload-too-large",
            Self::RateLimited { .. } => "https://evp.example/errors/rate-limited",
            Self::NotFound => "https://evp.example/errors/not-found",
            Self::Forbidden => "https://evp.example/errors/forbidden",
            Self::Conflict(_) => "https://evp.example/errors/conflict",
            Self::ValidationFailed(_)
            | Self::ValidationFields { .. }
            | Self::FormProblems { .. } => "https://evp.example/errors/validation-failed",
            Self::PreconditionRequired => "https://evp.example/errors/precondition-required",
            Self::CaptchaFailed => "https://evp.example/errors/captcha-failed",
            Self::Internal(_) => "https://evp.example/errors/internal",
        }
    }

    fn title(&self) -> &'static str {
        match self {
            Self::Unauthenticated => "Authentication required",
            Self::InvalidCredentials => "Invalid credentials",
            Self::Invalid(_) => "The request could not be processed",
            Self::Malformed => "Malformed request body",
            Self::UnsupportedMediaType => "Unsupported media type",
            Self::PayloadTooLarge => "Request body too large",
            Self::RateLimited { .. } => "Too many requests",
            Self::NotFound => "Not found",
            Self::Forbidden => "Forbidden",
            Self::Conflict(_) => "Conflict",
            Self::ValidationFailed(_)
            | Self::ValidationFields { .. }
            | Self::FormProblems { .. } => "Validation failed",
            Self::PreconditionRequired => "Precondition required",
            Self::CaptchaFailed => "Verification failed",
            Self::Internal(_) => "Internal server error",
        }
    }

    /// What the caller is allowed to be told.
    ///
    /// [`Self::InvalidCredentials`] deliberately returns a fixed sentence: any
    /// variation between "unknown address" and "wrong password" is an account
    /// oracle. [`Self::Internal`] returns nothing at all, because a `sqlx`
    /// error message can carry a column name, a constraint name, or a fragment
    /// of a query (docs/12 §5).
    ///
    /// The three body-rejection arms are fixed for the same class of reason:
    /// the only cause available to them is serde's message, which describes
    /// our deserialiser and quotes values back out of the request. It is
    /// logged by [`crate::extract`] and goes no further.
    fn detail(&self) -> Option<String> {
        match self {
            Self::Unauthenticated => Some("Sign in to continue.".to_owned()),
            Self::InvalidCredentials => {
                Some("That email address and password do not match an account.".to_owned())
            }
            Self::Invalid(message)
            | Self::Conflict(message)
            | Self::ValidationFailed(message)
            | Self::ValidationFields {
                detail: message, ..
            }
            | Self::FormProblems {
                detail: message, ..
            } => Some(message.clone()),
            Self::PreconditionRequired => Some(
                "This resource is versioned. Send the ETag you read as If-Match, so a change \
                 made since then is not silently discarded."
                    .to_owned(),
            ),
            Self::Malformed => Some("The request body could not be read as JSON.".to_owned()),
            Self::CaptchaFailed => Some(
                "The form's automatic check did not complete. Reload the form and send it again."
                    .to_owned(),
            ),
            Self::UnsupportedMediaType => Some(
                "This endpoint reads a JSON body. Send it with Content-Type: application/json."
                    .to_owned(),
            ),
            Self::PayloadTooLarge => {
                Some("The request body is larger than this endpoint accepts.".to_owned())
            }
            // The wait is in the body as well as in `Retry-After`, because
            // this is the one refusal whose remedy a person has to read: the
            // sign-in form shows `detail` verbatim, and "try again" without a
            // number reads as "try again now".
            Self::RateLimited {
                retry_after_seconds,
            } => Some(format!(
                "Too many attempts from this address. Try again in {}.",
                in_seconds(*retry_after_seconds)
            )),
            Self::NotFound => Some("No resource with that identifier exists.".to_owned()),
            Self::Forbidden => {
                Some("Your role in this organisation does not permit this action.".to_owned())
            }
            Self::Internal(_) => None,
        }
    }

    /// The per-field map, for the one variant that carries one.
    ///
    /// Exhaustive rather than `_ => None`: a future variant that names fields
    /// must be added here deliberately, not silently serialise without them.
    fn errors(&self) -> Option<BTreeMap<String, Vec<String>>> {
        match self {
            Self::ValidationFields { errors, .. } => Some(errors.clone()),
            Self::Unauthenticated
            | Self::InvalidCredentials
            | Self::Invalid(_)
            | Self::Malformed
            | Self::UnsupportedMediaType
            | Self::RateLimited { .. }
            | Self::PayloadTooLarge
            | Self::NotFound
            | Self::Forbidden
            | Self::Conflict(_)
            | Self::ValidationFailed(_)
            | Self::FormProblems { .. }
            | Self::PreconditionRequired
            | Self::CaptchaFailed
            | Self::Internal(_) => None,
        }
    }

    /// The per-question list, for the one variant that carries one.
    /// Exhaustive for the same reason [`Self::errors`] is.
    fn problems(&self) -> Option<Vec<PublishProblem>> {
        match self {
            Self::FormProblems { problems, .. } => Some(problems.clone()),
            Self::Unauthenticated
            | Self::InvalidCredentials
            | Self::Invalid(_)
            | Self::Malformed
            | Self::UnsupportedMediaType
            | Self::RateLimited { .. }
            | Self::PayloadTooLarge
            | Self::NotFound
            | Self::Forbidden
            | Self::Conflict(_)
            | Self::ValidationFailed(_)
            | Self::ValidationFields { .. }
            | Self::PreconditionRequired
            | Self::CaptchaFailed
            | Self::Internal(_) => None,
        }
    }
}

/// `1 second`, not `1 seconds`. The only place this API pluralises anything,
/// and it is here rather than in the frontend because the number is the
/// server's — an English string is the documented `detail`, and translation
/// arrives with the rest of the interface's (docs/14 §4).
fn in_seconds(count: u64) -> String {
    if count == 1 {
        "1 second".to_owned()
    } else {
        format!("{count} seconds")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // Logged here rather than at each call site, so a handler cannot add a
        // variant and forget to record it. The `?` chain carries the sqlx
        // cause; the caller gets the body below and nothing else.
        if let Self::Internal(cause) = &self {
            tracing::error!(error = ?cause, "request failed");
        }

        let status = self.status();
        let body = Problem {
            kind: self.kind().to_owned(),
            title: self.title().to_owned(),
            status: status.as_u16(),
            detail: self.detail(),
            errors: self.errors(),
            problems: self.problems(),
        };

        let mut response = (
            status,
            [(header::CONTENT_TYPE, "application/problem+json")],
            Json(body),
        )
            .into_response();

        // The one variant with a header of its own (docs/04 §2). Added here
        // rather than by the caller for the same reason the body is shaped
        // here: a 429 that forgot `Retry-After` is a 429 every client retries
        // immediately, and "remember to set the header" is not a mechanism.
        if let Self::RateLimited {
            retry_after_seconds,
        } = self
        {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, retry_after_seconds.into());
        }

        response
    }
}

impl From<evp_db::DbError> for ApiError {
    fn from(error: evp_db::DbError) -> Self {
        Self::Internal(error)
    }
}
