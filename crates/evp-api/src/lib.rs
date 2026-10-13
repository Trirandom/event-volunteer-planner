// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Axum routers, extractors, DTOs, OpenAPI generation and error mapping.
//!
//! M0 carries three routes and no more. They exist to prove the
//! configuration → wiring → hot-reload loop, not to be an API; the surface in
//! [docs/04](../../../docs/04-api.md) arrives with the milestones that need it.

pub mod assignments;
pub mod auth;
pub mod captcha;
pub mod catalog;
pub mod error;
pub mod extract;
pub mod forms;
pub mod intake;
pub mod locations;
pub mod org;
pub mod participations;
pub mod patterns;
pub mod public_form;
pub mod ratelimit;
pub mod shifts;
pub mod sms_settings;
pub mod submissions;

use axum::extract::{FromRef, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use sqlx::PgPool;
use utoipa::ToSchema;

pub use auth::SessionPolicy;
pub use ratelimit::{RateLimitPolicy, RateLimitSweeper};

/// What the handlers are given. Cloned per request, so everything in it is
/// cheap to clone.
#[derive(Debug, Clone)]
pub struct ApiState {
    /// Pool for the unprivileged application role.
    pub pool: PgPool,
    /// Build identity, stamped at compile time and served unauthenticated.
    pub meta: Meta,
    /// Cookie attributes and session expiry, decided once at startup.
    pub sessions: SessionPolicy,
    /// `EVP_SECRET_KEY_FILE`, for sealing values that must be recoverable
    /// rather than hashed — per-org OVH SMS credentials (ADR-0034).
    pub secret_key: evp_db::crypto::EncryptionKey,
    /// The public form's proof of work (ADR-0043): key, difficulty, and the
    /// solutions already spent.
    pub captcha: captcha::CaptchaPolicy,
}

// `FromRef` is what lets a handler ask for the one piece of state it needs —
// `State<PgPool>` rather than the whole `ApiState`. That is not cosmetic: the
// session extractor is generic over any state these can be projected from, so
// it can be unit-tested against a state that has nothing else in it.
impl FromRef<ApiState> for PgPool {
    fn from_ref(state: &ApiState) -> Self {
        state.pool.clone()
    }
}

impl FromRef<ApiState> for SessionPolicy {
    fn from_ref(state: &ApiState) -> Self {
        state.sessions
    }
}

impl FromRef<ApiState> for captcha::CaptchaPolicy {
    fn from_ref(state: &ApiState) -> Self {
        state.captcha.clone()
    }
}

impl FromRef<ApiState> for evp_db::crypto::EncryptionKey {
    fn from_ref(state: &ApiState) -> Self {
        state.secret_key.clone()
    }
}

/// `GET /api/v1/meta` — the AGPL §13 response.
///
/// Unauthenticated by design. A network user who cannot obtain the source of
/// the instance they are using has not been given what the licence requires,
/// and an endpoint behind a login would exclude every volunteer
/// ([CONTRIBUTING.md](../../../CONTRIBUTING.md)).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Meta {
    /// Crate version, from `CARGO_PKG_VERSION`.
    pub version: String,
    /// `git describe` output for the build, or `unknown` for a build made
    /// outside a checkout.
    pub commit: String,
    /// Where this deployment's source can be obtained. A modified deployment
    /// must point this at its own fork.
    pub source_url: String,
}

/// The M0 router, and the sweeper for the rate limiter's bucket store.
///
/// `None` if `limits` is not a usable quota, which `config.rs` refuses before
/// this is called ([`ratelimit::protect`]). Returning it rather than falling
/// back keeps "the deployment asked for a limit and did not get one" a startup
/// failure instead of a silence.
///
/// The sweeper comes back with the router because the two have the same
/// lifetime and forgetting it would leak: nothing else would ever drop a
/// bucket. See [`RateLimitSweeper`].
pub fn router(state: ApiState, limits: RateLimitPolicy) -> Option<(Router, RateLimitSweeper)> {
    // Route-scoped rather than a layer over the whole router: `/healthz` and
    // `/readyz` are polled by the orchestrator every few seconds and must
    // never be throttled, and `/api/v1/meta` is the AGPL §13 response, which
    // is not a thing to ration. The routes that need a quota get one each, so
    // a flood of logins cannot spend the budget of anything else.
    let (login, login_sweeper) = ratelimit::protect(post(auth::login), limits)?;
    // The public form's submission route is the second unauthenticated write
    // (docs/09 §5), with a quota and a bucket store of its own. Its `GET` is
    // not throttled: it is a read of what is already public, and a volunteer
    // reloading a half-filled form must never be told to wait.
    let (submit, submit_sweeper) =
        ratelimit::protect_form_submissions(public_form::submit_route(), limits)?;
    let sweeper = login_sweeper.and(submit_sweeper);

    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/api/v1/meta", get(meta))
        // Named to match docs/04 §Authentication, so that the magic-link and
        // OIDC routes documented there land beside these rather than replacing
        // them.
        .route("/api/v1/auth/login", login)
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/auth/me", get(auth::me))
        .merge(assignments::router())
        .merge(catalog::router())
        .merge(forms::router())
        .merge(intake::router())
        .merge(locations::router())
        .merge(participations::router())
        .merge(patterns::router())
        .merge(public_form::router(submit))
        .merge(shifts::router())
        .merge(sms_settings::router())
        .merge(submissions::router())
        .with_state(state);

    Some((router, sweeper))
}

/// Liveness: the process is running and the runtime is scheduling tasks.
/// It deliberately touches nothing else — a liveness probe that consults the
/// database restarts the API when the database is slow, which is the one
/// response guaranteed not to help.
async fn healthz() -> &'static str {
    "ok"
}

/// Readiness: the process can serve traffic, which means it can reach the
/// database.
async fn readyz(State(state): State<ApiState>) -> Result<&'static str, StatusCode> {
    match evp_db::ping(&state.pool).await {
        Ok(()) => Ok("ready"),
        Err(error) => {
            tracing::warn!(error = %error, "readiness probe failed");
            Err(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

async fn meta(State(state): State<ApiState>) -> Json<Meta> {
    Json(state.meta)
}
