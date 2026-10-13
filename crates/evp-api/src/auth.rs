// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Password authentication: the session cookie, the extractor, and three
//! routes.
//!
//! This is **not** the authentication model docs/04 describes. That is magic
//! links plus a generic OIDC client (ADR-0005, ADR-0013, ADR-0014), and it
//! remains the target. Passwords are here because a deployment needs a way in
//! before an SMTP relay or an identity provider exists, and `identities` was
//! already designed to carry several methods per user — so this occupies the
//! `'password'` provider slot rather than displacing anything. Magic links and
//! OIDC land beside it, on the same `sessions` table, and this module is then
//! the fallback rather than the front door.
//!
//! Sessions remain organisation members only (ADR-0008): volunteers have no
//! account and reach their own data through capability links instead.

use axum::extract::{FromRef, FromRequestParts, State};
use axum::http::StatusCode;
use axum::http::header::{HeaderMap, USER_AGENT};
use axum::http::request::Parts;
use axum::{Json, RequestPartsExt as _};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use evp_domain::password;
use evp_domain::token::Token;
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;

use crate::error::ApiError;
use crate::extract::JsonBody;

/// The cookie's name. `__Host-` is deliberately **not** used: that prefix
/// requires `Secure`, which requires HTTPS, and `docker compose up` serves
/// plain HTTP on localhost. A name that only works in production is a name
/// that gets worked around in development.
pub const COOKIE_NAME: &str = "evp_session";

/// How this deployment issues cookies and expires sessions.
#[derive(Debug, Clone, Copy)]
pub struct SessionPolicy {
    /// A session older than this is dead however active it has been. Bounds
    /// what a stolen cookie is worth (docs/12, T5).
    pub absolute_lifetime_seconds: i64,
    /// A session unused for this long is dead. Closes the laptop nobody
    /// logged out of.
    pub idle_timeout_seconds: i64,
    /// Whether to mark the cookie `Secure`.
    ///
    /// Derived from `EVP_PUBLIC_URL`'s scheme rather than configured
    /// separately: a deployment served over HTTPS that forgot to set a
    /// "secure cookies" flag is exactly the mistake worth making impossible,
    /// and an operator who has told us the public URL has already said this.
    pub secure: bool,
}

/// `POST /api/v1/auth/login`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct LoginRequest {
    /// The address the account is keyed by. Matched case-insensitively —
    /// `users.email` is `citext`.
    pub email: String,
    /// The password, in the clear, over what had better be TLS in production.
    ///
    /// `String` rather than `SecretString` because serde must construct it
    /// from the body; it is moved into a [`SecretString`] before anything else
    /// touches it, and this struct is never logged or stored.
    pub password: String,
}

/// The authenticated user, as `login` and `me` both return them.
#[derive(Debug, Serialize, ToSchema)]
pub struct UserResponse {
    /// `users.id`, a UUIDv7 string.
    pub id: String,
    /// Canonical address, in the case it was stored in.
    pub email: String,
    /// What to show in the interface.
    pub display_name: String,
    /// BCP-47 language tag.
    pub locale: String,
    /// Every organisation this user may act in.
    pub memberships: Vec<MembershipResponse>,
}

/// One organisation and the role held in it.
#[derive(Debug, Serialize, ToSchema)]
pub struct MembershipResponse {
    /// `organizations.id`.
    pub org_id: String,
    /// URL-safe identifier.
    pub slug: String,
    /// Display name.
    pub name: String,
    /// `owner`, `coordinator` or `zone_lead`.
    pub role: String,
}

/// A request that has been authenticated.
///
/// Used as an extractor: a handler that takes one cannot be reached without a
/// live session, so "did I remember to check?" is answered by the type rather
/// than by a line at the top of the function (docs/12).
#[derive(Debug, Clone)]
pub struct CurrentUser(pub evp_db::auth::AuthenticatedUser);

impl<S> FromRequestParts<S> for CurrentUser
where
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let jar = parts
            .extract::<CookieJar>()
            .await
            .map_err(|_| ApiError::Unauthenticated)?;

        let presented = jar
            .get(COOKIE_NAME)
            .map(|cookie| Token::from_client(cookie.value()))
            .ok_or(ApiError::Unauthenticated)?;

        let pool = PgPool::from_ref(state);
        let policy = SessionPolicy::from_ref(state);

        // Looking the session up also refreshes its idle window, so merely
        // being extracted counts as activity. That is the intent: a user
        // clicking around is not idle.
        evp_db::auth::authenticate(&pool, &presented.hash(), policy.idle_timeout_seconds)
            .await?
            .map(Self)
            .ok_or(ApiError::Unauthenticated)
    }
}

/// `POST /api/v1/auth/login` — exchange an address and password for a session.
///
/// # Errors
///
/// [`ApiError::InvalidCredentials`] for an unknown address, an account with no
/// password identity, or a wrong password — all three indistinguishable by
/// design. [`ApiError::Internal`] if the database fails.
///
/// The body arrives through [`JsonBody`] rather than `axum::Json`, so a
/// malformed or wrong-shaped request is `problem+json` like every other
/// failure here instead of `text/plain` carrying serde's message
/// ([`crate::extract`]). The response type is still `axum::Json` — only the
/// direction that can fail needs the wrapper.
pub async fn login(
    State(pool): State<PgPool>,
    State(policy): State<SessionPolicy>,
    jar: CookieJar,
    headers: HeaderMap,
    JsonBody(request): JsonBody<LoginRequest>,
) -> Result<(CookieJar, Json<UserResponse>), ApiError> {
    let supplied = SecretString::from(request.password);

    let found = evp_db::auth::password_identity(&pool, request.email.trim()).await?;

    let Some((user_id, stored)) = found else {
        // The address is unknown. Verify against a throwaway hash anyway, so
        // that the unknown-address path costs the same as the wrong-password
        // path: returning immediately here would make login timing a reliable
        // way to enumerate who has an account (docs/12).
        password::verify(&supplied, DUMMY_HASH).ok();
        return Err(ApiError::InvalidCredentials);
    };

    match password::verify(&supplied, &stored) {
        Ok(()) => {}
        Err(password::PasswordError::MalformedHash) => {
            // An operations fault, not a wrong password: the stored PHC string
            // is corrupt. The caller is told the same thing either way, but
            // this must be findable in the log, because no password will ever
            // work for this account until somebody fixes the row.
            tracing::error!(user_id = %user_id, "stored password hash will not parse");
            return Err(ApiError::InvalidCredentials);
        }
        Err(_) => return Err(ApiError::InvalidCredentials),
    }

    let token = Token::generate();
    let user_agent = headers
        .get(USER_AGENT)
        .and_then(|value| value.to_str().ok())
        // Bounded before it reaches the database: the column is unbounded
        // `text`, and a header is attacker-controlled.
        .map(|value| value.chars().take(256).collect::<String>());

    let session_id = evp_db::auth::create_session(
        &pool,
        user_id,
        &token.hash(),
        policy.absolute_lifetime_seconds,
        user_agent.as_deref(),
        // The peer address is the reverse proxy's, not the user's, and
        // trusting a forwarded header without knowing the hop count records a
        // value the client chose. Left NULL until the proxy contract is
        // settled, because a wrong IP in an audit trail is worse than none.
        None,
    )
    .await?;

    // Read back rather than echo the request: `email` is `citext`, so the
    // stored casing is authoritative and may differ from what was typed, and
    // `display_name` and `locale` were never in the request at all.
    let user = evp_db::auth::user_by_id(&pool, user_id, session_id)
        .await?
        .ok_or(ApiError::InvalidCredentials)?;
    let memberships = evp_db::auth::memberships(&pool, user_id).await?;

    tracing::info!(user_id = %user_id, session_id = %session_id, "session issued");
    Ok((
        jar.add(session_cookie(&token, policy)),
        Json(response_for(user, memberships)),
    ))
}

/// `GET /api/v1/auth/me` — who the caller is, and where they may act.
///
/// # Errors
///
/// [`ApiError::Unauthenticated`] without a live session;
/// [`ApiError::Internal`] if the database fails.
pub async fn me(
    State(pool): State<PgPool>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<UserResponse>, ApiError> {
    let memberships = evp_db::auth::memberships(&pool, user.id).await?;
    Ok(Json(response_for(user, memberships)))
}

/// `POST /api/v1/auth/logout` — revoke this device's session.
///
/// Unauthenticated on purpose, and idempotent: a caller whose session has
/// already expired is trying to do the right thing, and answering 401 would
/// leave the cookie in their browser. Always 204, and always clears the cookie.
///
/// # Errors
///
/// [`ApiError::Internal`] if the database fails.
pub async fn logout(
    State(pool): State<PgPool>,
    State(policy): State<SessionPolicy>,
    jar: CookieJar,
) -> Result<(CookieJar, StatusCode), ApiError> {
    if let Some(cookie) = jar.get(COOKIE_NAME) {
        evp_db::auth::revoke(&pool, &Token::from_client(cookie.value()).hash()).await?;
    }

    // Built with the same attributes as the cookie it replaces. A browser
    // matches on name, domain and path, so a removal cookie that differs in
    // `Path` adds a second cookie instead of clearing the first.
    let mut removal = Cookie::build((COOKIE_NAME, ""))
        .path("/")
        .http_only(true)
        .secure(policy.secure)
        .same_site(SameSite::Lax)
        .build();
    removal.make_removal();

    Ok((jar.add(removal), StatusCode::NO_CONTENT))
}

/// `HttpOnly` so script cannot read it, `SameSite=Lax` so a cross-site POST
/// cannot ride it, `Secure` whenever the deployment is served over HTTPS
/// (docs/04, docs/12 T5).
///
/// Deliberately a **session cookie** — no `Max-Age`. The server's
/// `absolute_expiry` is the authority on how long a session lasts; a cookie
/// that outlived it would leave the browser presenting a token the server has
/// already refused, and one that expired first would log out a live session.
fn session_cookie(token: &Token, policy: SessionPolicy) -> Cookie<'static> {
    Cookie::build((COOKIE_NAME, token.expose().to_owned()))
        .path("/")
        .http_only(true)
        .secure(policy.secure)
        .same_site(SameSite::Lax)
        .build()
}

/// One shape for both routes, so `login` and `me` cannot drift into describing
/// the same user differently.
fn response_for(
    user: evp_db::auth::AuthenticatedUser,
    memberships: Vec<evp_db::auth::Membership>,
) -> UserResponse {
    UserResponse {
        id: user.id.to_string(),
        email: user.email,
        display_name: user.display_name,
        locale: user.locale,
        memberships: memberships.into_iter().map(into_membership).collect(),
    }
}

fn into_membership(membership: evp_db::auth::Membership) -> MembershipResponse {
    MembershipResponse {
        org_id: membership.org_id.to_string(),
        slug: membership.org_slug,
        name: membership.org_name,
        role: membership.role,
    }
}

/// A syntactically valid Argon2id hash of a value nobody knows, used only to
/// spend the same time on an unknown address as on a wrong password.
///
/// Its parameters must track [`argon2::Argon2::default`], or the two paths
/// diverge in cost again and the defence stops working.
const DUMMY_HASH: &str =
    "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Rk9SVEhFVElNSU5HREVGRU5DRU9OTFk";
