// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/api/v1/backoffice/…` — the deployment operator's routes (ADR-0045,
//! docs/04 §"Backoffice").
//!
//! Authorised by [`Backoffice`], the one extractor that sets
//! `app.backoffice`. It is to these routes what the org extractors in
//! [`crate::org`] are to the tenant ones: a handler that takes it cannot run
//! without the key having been checked, and cannot reach the database except
//! through the transaction it opened. Nothing here touches the session cookie,
//! and no handler here takes a [`crate::auth::CurrentUser`] — a coordinator's
//! session grants nothing on these routes, by construction rather than by a
//! check somebody has to remember.

use axum::extract::{FromRef, FromRequestParts, Path};
use axum::http::StatusCode;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::routing::{get, put};
use axum::{Json, Router};
use evp_domain::backoffice::BackofficeKey;
use evp_domain::password::{self, PasswordError};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::catalog::DataPage;
use crate::error::ApiError;
use crate::extract::JsonBody;
use crate::{ApiState, RateLimitPolicy, RateLimitSweeper, ratelimit};

/// What `organizations.timezone` defaults to in the schema, and therefore
/// what an omitted `timezone` means here.
const DEFAULT_TIMEZONE: &str = "Europe/Paris";

/// Whether this deployment has a backoffice, and if so, its key.
///
/// A newtype rather than a bare `Option<BackofficeKey>` in [`ApiState`], so
/// that `FromRef` can project it without colliding with any other optional
/// piece of state that arrives later.
#[derive(Debug, Clone, Default)]
pub struct BackofficeAccess(pub Option<BackofficeKey>);

/// A backoffice request whose key has been checked, holding a transaction
/// scoped with `app.backoffice` and nothing else.
///
/// As with [`crate::org::OrgTx`], dropping it without [`Self::commit`] rolls
/// back, which is the safe default for a handler that returns early.
#[derive(Debug)]
pub struct Backoffice {
    tx: Transaction<'static, Postgres>,
}

impl Backoffice {
    /// # Errors
    ///
    /// [`ApiError::Internal`] if the commit itself fails.
    pub async fn commit(self) -> Result<(), ApiError> {
        self.tx.commit().await.map_err(evp_db::DbError::Query)?;
        Ok(())
    }
}

impl<S> FromRequestParts<S> for Backoffice
where
    PgPool: FromRef<S>,
    BackofficeAccess: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // No key configured: answer exactly as an unknown path would. A
        // deployment that has not opted in does not advertise that it could.
        let BackofficeAccess(Some(key)) = BackofficeAccess::from_ref(state) else {
            return Err(ApiError::NotFound);
        };

        let presented = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(bearer)
            .ok_or(ApiError::Unauthenticated)?;

        if !key.matches(presented) {
            tracing::warn!("backoffice request with a wrong key");
            return Err(ApiError::Unauthenticated);
        }

        let pool = PgPool::from_ref(state);
        let mut tx = pool.begin().await.map_err(evp_db::DbError::Query)?;
        evp_db::backoffice::enter(&mut tx).await?;
        Ok(Self { tx })
    }
}

/// The credential in an `Authorization: Bearer …` header. The scheme is
/// case-insensitive (RFC 9110 §11.1); the credential is not.
fn bearer(header: &str) -> Option<&str> {
    let (scheme, credential) = header.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| credential.trim_start())
        .filter(|credential| !credential.is_empty())
}

/// The backoffice routes, behind a quota of their own.
///
/// `None` for a degenerate quota, as [`crate::router`] treats every other.
pub(crate) fn router(limits: RateLimitPolicy) -> Option<(Router<ApiState>, RateLimitSweeper)> {
    let routes = Router::new()
        .route(
            "/api/v1/backoffice/organizations",
            get(list_organizations).post(create_organization),
        )
        .route(
            "/api/v1/backoffice/organizations/{org}/members",
            get(list_members),
        )
        .route(
            "/api/v1/backoffice/organizations/{org}/members/{user}",
            put(assign_member).delete(remove_member),
        )
        .route(
            "/api/v1/backoffice/users",
            get(list_users).post(create_user),
        );
    ratelimit::protect_backoffice(routes, limits)
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationResponse {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub timezone: String,
    pub created_at: String,
    pub member_count: i64,
}

impl From<evp_db::backoffice::Organization> for OrganizationResponse {
    fn from(org: evp_db::backoffice::Organization) -> Self {
        Self {
            id: org.id.to_string(),
            slug: org.slug,
            name: org.name,
            timezone: org.timezone,
            created_at: org.created_at.to_string(),
            member_count: org.member_count,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateOrganizationRequest {
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub timezone: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MemberResponse {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub created_at: String,
}

impl From<evp_db::backoffice::Member> for MemberResponse {
    fn from(member: evp_db::backoffice::Member) -> Self {
        Self {
            user_id: member.user_id.to_string(),
            email: member.email,
            display_name: member.display_name,
            role: member.role,
            created_at: member.created_at.to_string(),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AssignMemberRequest {
    pub role: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UserResponse {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub created_at: String,
    pub last_login_at: Option<String>,
    pub memberships: Vec<crate::auth::MembershipResponse>,
}

impl From<evp_db::backoffice::User> for UserResponse {
    fn from(user: evp_db::backoffice::User) -> Self {
        Self {
            id: user.id.to_string(),
            email: user.email,
            display_name: user.display_name,
            created_at: user.created_at.to_string(),
            last_login_at: user.last_login_at.map(|at| at.to_string()),
            memberships: user
                .memberships
                .into_iter()
                .map(|membership| crate::auth::MembershipResponse {
                    org_id: membership.org_id.to_string(),
                    slug: membership.org_slug,
                    name: membership.org_name,
                    role: membership.role,
                })
                .collect(),
        }
    }
}

/// `String` for the password, as in [`crate::auth::LoginRequest`]: serde has
/// to build it, and it is moved into a [`SecretString`] before anything else
/// sees it.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateUserRequest {
    pub email: String,
    pub display_name: String,
    pub password: String,
}

fn page<T>(data: Vec<T>) -> Json<DataPage<T>> {
    Json(DataPage { data, next: None })
}

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------

async fn list_organizations(
    Backoffice { mut tx }: Backoffice,
) -> Result<Json<DataPage<OrganizationResponse>>, ApiError> {
    let organizations = evp_db::backoffice::list_organizations(&mut tx).await?;
    Ok(page(organizations.into_iter().map(Into::into).collect()))
}

async fn create_organization(
    mut backoffice: Backoffice,
    JsonBody(request): JsonBody<CreateOrganizationRequest>,
) -> Result<(StatusCode, Json<OrganizationResponse>), ApiError> {
    let name = required("name", &request.name)?;
    let slug = request.slug.trim();
    let timezone = request
        .timezone
        .as_deref()
        .map(str::trim)
        .filter(|timezone| !timezone.is_empty())
        .unwrap_or(DEFAULT_TIMEZONE);

    if !evp_db::backoffice::timezone_exists(&mut backoffice.tx, timezone).await? {
        return Err(ApiError::ValidationFailed(
            "timezone is not a known IANA time zone name.".to_owned(),
        ));
    }

    let created = evp_db::backoffice::create_organization(&mut backoffice.tx, name, slug, timezone)
        .await
        .map_err(|error| match error.sqlstate().as_deref() {
            Some("23505") => {
                ApiError::Conflict("An organisation with this slug already exists.".to_owned())
            }
            Some("23514") => ApiError::ValidationFailed(
                "slug must be 3 to 40 lowercase letters, digits or hyphens, \
                 not starting or ending with a hyphen."
                    .to_owned(),
            ),
            _ => ApiError::Internal(error),
        })?;
    backoffice.commit().await?;

    tracing::info!(org_id = %created.id, "backoffice created an organisation");
    Ok((StatusCode::CREATED, Json(created.into())))
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

async fn list_members(
    Backoffice { mut tx }: Backoffice,
    Path(org): Path<String>,
) -> Result<Json<DataPage<MemberResponse>>, ApiError> {
    let org_id = id(&org)?;
    if !evp_db::backoffice::organization_exists(&mut tx, org_id).await? {
        return Err(ApiError::NotFound);
    }
    let members = evp_db::backoffice::list_members(&mut tx, org_id).await?;
    Ok(page(members.into_iter().map(Into::into).collect()))
}

async fn assign_member(
    mut backoffice: Backoffice,
    Path((org, user)): Path<(String, String)>,
    JsonBody(request): JsonBody<AssignMemberRequest>,
) -> Result<Json<MemberResponse>, ApiError> {
    let org_id = id(&org)?;
    let user_id = id(&user)?;
    let role = role(&request.role)?;

    let member = evp_db::backoffice::assign_member(&mut backoffice.tx, org_id, user_id, role)
        .await
        .map_err(|error| match error.sqlstate().as_deref() {
            // Either foreign key: the organisation or the account is unknown,
            // and the caller named both by id.
            Some("23503") => ApiError::NotFound,
            _ => ApiError::Internal(error),
        })?;
    backoffice.commit().await?;

    tracing::info!(org_id = %org_id, user_id = %user_id, role, "backoffice assigned a member");
    Ok(Json(member.into()))
}

async fn remove_member(
    mut backoffice: Backoffice,
    Path((org, user)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let org_id = id(&org)?;
    let user_id = id(&user)?;

    if !evp_db::backoffice::remove_member(&mut backoffice.tx, org_id, user_id).await? {
        return Err(ApiError::NotFound);
    }
    backoffice.commit().await?;

    tracing::info!(org_id = %org_id, user_id = %user_id, "backoffice removed a member");
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

async fn list_users(
    Backoffice { mut tx }: Backoffice,
) -> Result<Json<DataPage<UserResponse>>, ApiError> {
    let users = evp_db::backoffice::list_users(&mut tx).await?;
    Ok(page(users.into_iter().map(Into::into).collect()))
}

async fn create_user(
    mut backoffice: Backoffice,
    JsonBody(request): JsonBody<CreateUserRequest>,
) -> Result<(StatusCode, Json<UserResponse>), ApiError> {
    let supplied = SecretString::from(request.password);
    let email = request.email.trim();
    if !evp_domain::submission::looks_like_email(email) {
        return Err(ApiError::ValidationFailed(
            "email is not an email address.".to_owned(),
        ));
    }
    let display_name = required("display_name", &request.display_name)?;

    let hashed = password::hash(&supplied).map_err(|error| match error {
        PasswordError::TooShort => ApiError::ValidationFailed(format!(
            "password must be at least {} characters.",
            password::MIN_PASSWORD_LENGTH
        )),
        // Argon2 refusing to hash an acceptable password is this process's
        // fault, not the caller's — and not a database error either, but
        // `Internal` is where the one "something unexpected" variant lives.
        other => {
            tracing::error!(error = %other, "could not hash a backoffice-created password");
            ApiError::Internal(evp_db::DbError::Crypto)
        }
    })?;

    let created = evp_db::backoffice::create_user(&mut backoffice.tx, email, display_name, &hashed)
        .await
        .map_err(|error| match error.sqlstate().as_deref() {
            Some("23505") => {
                ApiError::Conflict("An account with this email address already exists.".to_owned())
            }
            _ => ApiError::Internal(error),
        })?;
    backoffice.commit().await?;

    tracing::info!(user_id = %created.id, "backoffice created an account");
    Ok((StatusCode::CREATED, Json(created.into())))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// A path id that is not a UUID names nothing, and is answered as such.
fn id(raw: &str) -> Result<Uuid, ApiError> {
    raw.parse().map_err(|_| ApiError::NotFound)
}

/// Checked here rather than left to the `::member_role` cast, whose failure is
/// a `22P02` indistinguishable from any other malformed value.
fn role(raw: &str) -> Result<&'static str, ApiError> {
    match raw {
        "owner" => Ok("owner"),
        "coordinator" => Ok("coordinator"),
        "zone_lead" => Ok("zone_lead"),
        _ => Err(ApiError::ValidationFailed(
            "role must be owner, coordinator or zone_lead.".to_owned(),
        )),
    }
}

fn required<'a>(field: &str, value: &'a str) -> Result<&'a str, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ApiError::ValidationFailed(format!("{field} is required.")));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::bearer;

    #[test]
    fn a_bearer_header_yields_its_credential() {
        assert_eq!(bearer("Bearer abc"), Some("abc"));
    }

    #[test]
    fn the_scheme_is_case_insensitive() {
        assert_eq!(bearer("bearer abc"), Some("abc"));
        assert_eq!(bearer("BEARER abc"), Some("abc"));
    }

    #[test]
    fn another_scheme_is_not_a_bearer() {
        assert_eq!(bearer("Basic abc"), None);
    }

    #[test]
    fn a_scheme_with_no_credential_is_nothing() {
        assert_eq!(bearer("Bearer"), None);
        assert_eq!(bearer("Bearer "), None);
    }
}
