// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The org extractor and the transaction machinery from docs/02 §3, step 4-5.
//!
//! This is the load-bearing part of the whole architecture and, until this
//! module, it did not exist: every tenant-scoped route needs to (a) resolve
//! `{org}` from the path to an `org_id`, (b) verify the caller has a live
//! membership in it, (c) attach `(user_id, org_id, role)`, and (d) begin a
//! transaction with `SET LOCAL app.current_org_id` / `app.current_role`
//! *before* any tenant-table statement runs — never a bare `SET`, which would
//! persist onto the next request that borrows the same pooled connection
//! (docs/03 §4).
//!
//! Rather than a `tower` middleware layer — which would need somewhere to
//! stash a live `Transaction<'static, Postgres>` across the handler boundary,
//! and axum's `Extension` is `Clone`, which a transaction is not — this is
//! three `FromRequestParts` extractors, one per minimum role
//! ([`Owner`], [`Coordinator`], [`ZoneLead`]). A handler that reads or writes
//! tenant data takes one of them as a parameter; there is no path into a
//! tenant table that does not go through one, so "did I remember the role
//! check?" is answered by the function signature rather than a line inside it
//! (CLAUDE.md, "Authorisation is expressed as Axum extractors").
//!
//! Each extractor *owns* the transaction it opens. The handler runs the rest
//! of its statements against `org.tx` and must call
//! [`OrgTx::commit`] on every success path — dropping it without committing
//! rolls back, which is the safe default for a handler that returns early on
//! an error.

use axum::RequestPartsExt as _;
use axum::extract::{FromRef, FromRequestParts, Path};
use axum::http::request::Parts;
use serde::Deserialize;
use sqlx::{PgPool, Postgres, Row as _, Transaction};
use uuid::Uuid;

use crate::auth::{CurrentUser, SessionPolicy};
use crate::error::ApiError;

/// `member_role` as Rust, ordered least to most privileged so a minimum can be
/// compared with `>=`. Text, not the database enum, travels across this
/// boundary — see [`evp_db::auth::Membership::role`] for why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    ZoneLead,
    Coordinator,
    Owner,
}

impl Role {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "zone_lead" => Some(Self::ZoneLead),
            "coordinator" => Some(Self::Coordinator),
            "owner" => Some(Self::Owner),
            _ => None,
        }
    }
}

/// What a tenant-scoped handler is given: a transaction already carrying the
/// `SET LOCAL` GUCs the RLS policies key off, and who is making the request.
#[derive(Debug)]
pub struct OrgTx {
    pub tx: Transaction<'static, Postgres>,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub role: Role,
}

impl OrgTx {
    /// Commits. Named rather than exposing `tx` for this alone, so a handler
    /// that forgets to call it fails safe (rollback) instead of failing open.
    ///
    /// # Errors
    ///
    /// [`ApiError::Internal`] if the commit itself fails.
    pub async fn commit(self) -> Result<(), ApiError> {
        self.tx.commit().await.map_err(evp_db::DbError::Query)?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct OrgPath {
    org: Uuid,
}

/// Resolves `{org}` — an `org_id`, per docs/04 §1 (`/orgs/{org_id}/…`), not a
/// slug — opens the transaction, sets both GUCs, and checks the caller's
/// membership. Shared by all three role extractors below, which differ only
/// in the minimum they accept.
///
/// # Why this needs no query against `organizations` at all
///
/// The caller already named the organisation by id, so "does it exist and am
/// I a member" is one question, answered by `memberships` alone: `memberships`
/// is policed by `memberships_self_read`, which matches on
/// `app.current_user_id` alone (migration `20260915100400`) — no
/// `app.current_org_id` needed yet, that is what this function is resolving.
///
/// An id that does not exist and an id that exists but the caller does not
/// belong to are indistinguishable by design (docs/04 §2, `404`-for-forbidden
/// across tenants) — both come back `Ok(None)`.
async fn resolve(parts: &mut Parts, pool: &PgPool, user_id: Uuid) -> Result<OrgTx, ApiError> {
    let Path(OrgPath { org: org_id }) = parts
        .extract::<Path<OrgPath>>()
        .await
        .map_err(|_| ApiError::NotFound)?;

    let mut tx = pool.begin().await.map_err(evp_db::DbError::Query)?;

    sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(evp_db::DbError::Query)?;

    let row = sqlx::query(
        "SELECT role::text AS role FROM memberships WHERE org_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(evp_db::DbError::Query)?;

    let Some(row) = row else {
        return Err(ApiError::NotFound);
    };

    let role_text: String = row.try_get("role").map_err(evp_db::DbError::Query)?;
    let role = Role::parse(&role_text).ok_or_else(|| {
        ApiError::Internal(evp_db::DbError::Query(sqlx::Error::Decode(
            format!("unrecognised member_role {role_text:?}").into(),
        )))
    })?;

    // Now that the org is known, the transaction is scoped for everything the
    // handler does next. `app.current_role` lets a policy key off role
    // without a second round trip to memberships (none does yet; it is set
    // here so the first one that needs it does not have to touch this module).
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(evp_db::DbError::Query)?;
    sqlx::query("SELECT set_config('app.current_role', $1, true)")
        .bind(&role_text)
        .execute(&mut *tx)
        .await
        .map_err(evp_db::DbError::Query)?;

    Ok(OrgTx {
        tx,
        org_id,
        user_id,
        role,
    })
}

async fn scoped<S>(parts: &mut Parts, state: &S, minimum: Role) -> Result<OrgTx, ApiError>
where
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
    S: Send + Sync,
{
    let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
    let pool = PgPool::from_ref(state);
    let org = resolve(parts, &pool, user.id).await?;

    if org.role < minimum {
        // The transaction opened above is dropped here, which rolls back the
        // two set_config calls along with it — there is nothing to undo, they
        // never outlive the transaction regardless.
        return Err(ApiError::Forbidden);
    }

    Ok(org)
}

/// At least owner. Org settings, deleting an event (docs/04 §4).
#[derive(Debug)]
pub struct Owner(pub OrgTx);

impl<S> FromRequestParts<S> for Owner
where
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        scoped(parts, state, Role::Owner).await.map(Self)
    }
}

/// At least coordinator. Creating festivals and events, loading the example
/// (docs/04 §4: "Events: create, duplicate, archive").
#[derive(Debug)]
pub struct Coordinator(pub OrgTx);

impl<S> FromRequestParts<S> for Coordinator
where
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        scoped(parts, state, Role::Coordinator).await.map(Self)
    }
}

/// Any member — the name is the *minimum* role it accepts, per
/// CLAUDE.md's "Owner, Coordinator, `ZoneLead`" trio, and a zone lead is the
/// least-privileged role that still belongs to the organisation. Reading
/// festivals, events, locations and shifts (docs/04 §4).
#[derive(Debug)]
pub struct ZoneLead(pub OrgTx);

impl<S> FromRequestParts<S> for ZoneLead
where
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        scoped(parts, state, Role::ZoneLead).await.map(Self)
    }
}
