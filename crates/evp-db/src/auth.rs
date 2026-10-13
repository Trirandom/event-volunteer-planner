// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Identity, sessions and the bootstrap owner.
//!
//! Every query here is written with `sqlx::query*` rather than the `query!`
//! macros. The macros check SQL against a live schema at compile time, which
//! needs either a reachable database or a committed `.sqlx` cache; this
//! workspace has neither yet, and a build that requires a database is a build
//! a contributor cannot run. `just openapi` and `cargo sqlx prepare` are what
//! close that gap, and moving this module onto the macros is the first thing
//! to do once the cache is committed (docs/11 §4).
//!
//! ## Row-Level Security
//!
//! `users`, `identities` and `sessions` carry no `org_id` and are not
//! tenant-scoped: identity is global, authorisation is per-organisation
//! (docs/03). `organizations` and `memberships` *are* policed, and every
//! statement touching them therefore runs inside a transaction that has set
//! the relevant session variable first. `set_config(..., true)` is `SET LOCAL`
//! in function form — it takes a bind parameter, which `SET LOCAL` cannot, and
//! it is scoped to the transaction. A plain `SET` would persist onto the next
//! request that borrowed the same pooled connection, which is precisely the
//! cross-tenant leak the policies exist to prevent.

use sqlx::{PgPool, Row as _};
use uuid::Uuid;

use crate::DbError;

/// A user as the session extractor needs them.
#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    /// `users.id`.
    pub id: Uuid,
    /// Canonical address. `citext` in the database, so it returns in the case
    /// it was stored in, not the case it was typed in.
    pub email: String,
    /// What to show in the interface.
    pub display_name: String,
    /// BCP-47 language tag.
    pub locale: String,
    /// The session this user was recognised by, so logout can revoke exactly
    /// the device that asked.
    pub session_id: Uuid,
}

/// One organisation this user may act in, and as what.
#[derive(Debug, Clone)]
pub struct Membership {
    /// `organizations.id`.
    pub org_id: Uuid,
    /// URL-safe identifier.
    pub org_slug: String,
    /// Display name.
    pub org_name: String,
    /// `member_role`, rendered as text. Decoded as text rather than as a Rust
    /// enum on purpose: adding a role to the database enum would otherwise turn
    /// every existing row into a decode error at runtime.
    pub role: String,
}

/// The stored password identity for an address, if one exists.
///
/// Returns the `users.id` and the PHC string. Deliberately does *not* say
/// whether the address exists without a password identity: the caller must not
/// be able to distinguish "no such user" from "no password on that user", and
/// the single `Option` is what keeps that distinction out of reach.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn password_identity(
    pool: &PgPool,
    email: &str,
) -> Result<Option<(Uuid, String)>, DbError> {
    let row = sqlx::query(
        "SELECT u.id, i.password_hash
           FROM users u
           JOIN identities i ON i.user_id = u.id AND i.provider = 'password'
          WHERE u.email = $1::citext",
    )
    .bind(email)
    .fetch_optional(pool)
    .await
    .map_err(DbError::Query)?;

    row.map(|row| {
        let id: Uuid = row.try_get("id").map_err(DbError::Query)?;
        // NOT NULL is guaranteed by identities_password_hash_iff_password for
        // any row this query can return, so a NULL here means the constraint
        // was dropped rather than that the password is absent.
        let hash: String = row.try_get("password_hash").map_err(DbError::Query)?;
        Ok((id, hash))
    })
    .transpose()
}

/// Is there any user at all?
///
/// The bootstrap's guard. "No users exist" is the only state in which creating
/// an owner from configuration is safe, because it is the only state in which
/// doing so cannot grant access to somebody else's deployment.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn any_user_exists(pool: &PgPool) -> Result<bool, DbError> {
    let row = sqlx::query("SELECT EXISTS (SELECT 1 FROM users) AS present")
        .fetch_one(pool)
        .await
        .map_err(DbError::Query)?;
    row.try_get("present").map_err(DbError::Query)
}

/// Create the first organisation, its owner, and the owner's password
/// identity, in one transaction.
///
/// All four rows or none: an organisation with no owner cannot be administered
/// and cannot be deleted through the API, and a user with no membership can log
/// in and see nothing. Neither half is a state worth being able to reach.
///
/// # Errors
///
/// [`DbError::Query`] if any statement fails — including the unique violation
/// that results from two processes bootstrapping at once, which is the
/// intended outcome for the loser.
pub async fn create_owner(
    pool: &PgPool,
    email: &str,
    display_name: &str,
    password_hash: &str,
    org_slug: &str,
    org_name: &str,
) -> Result<Uuid, DbError> {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();

    let mut tx = pool.begin().await.map_err(DbError::Query)?;

    // Both policies are keyed to these, and both INSERTs below are refused
    // without them. Set inside the transaction, so the next borrower of this
    // connection does not inherit them.
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(DbError::Query)?;
    sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(DbError::Query)?;

    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2::citext, $3)")
        .bind(org_id)
        .bind(org_slug)
        .bind(org_name)
        .execute(&mut *tx)
        .await
        .map_err(DbError::Query)?;

    sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, $3)")
        .bind(user_id)
        .bind(email)
        .bind(display_name)
        .execute(&mut *tx)
        .await
        .map_err(DbError::Query)?;

    sqlx::query(
        "INSERT INTO identities (id, user_id, provider, subject, email_at_link, password_hash)
         VALUES ($1, $2, 'password', $3, $4::citext, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(user_id)
    .bind(email)
    .bind(email)
    .bind(password_hash)
    .execute(&mut *tx)
    .await
    .map_err(DbError::Query)?;

    sqlx::query("INSERT INTO memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')")
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(DbError::Query)?;

    crate::patterns::seed_default(&mut tx, org_id, user_id).await?;

    tx.commit().await.map_err(DbError::Query)?;
    Ok(user_id)
}

/// Record a new session and stamp the login on the user.
///
/// Expiry is computed by PostgreSQL rather than by the injected [`Clock`], and
/// that is deliberate rather than an oversight of ADR-0019. The rule there
/// governs *business logic* — what a schedule means, which is answerable and
/// must be reproducible under a fake clock. A session must expire on real
/// elapsed time no matter what any test has decided the time is; deriving it
/// from a clock a caller can set would make "expired" a thing a caller could
/// postpone.
///
/// [`Clock`]: evp_domain::Clock
///
/// # Errors
///
/// [`DbError::Query`] if either statement fails.
pub async fn create_session(
    pool: &PgPool,
    user_id: Uuid,
    token_hash: &[u8],
    absolute_lifetime_seconds: i64,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> Result<Uuid, DbError> {
    let session_id = Uuid::now_v7();
    let mut tx = pool.begin().await.map_err(DbError::Query)?;

    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_hash, absolute_expiry, user_agent, ip)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, $6::inet)",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(token_hash)
    .bind(seconds_as_f64(absolute_lifetime_seconds))
    .bind(user_agent)
    .bind(ip)
    .execute(&mut *tx)
    .await
    .map_err(DbError::Query)?;

    sqlx::query("UPDATE users SET last_login_at = now() WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(DbError::Query)?;

    tx.commit().await.map_err(DbError::Query)?;
    Ok(session_id)
}

/// Resolve a presented cookie to a user, refreshing the idle window.
///
/// One statement, deliberately: looking the session up and then deciding
/// whether it is live in Rust would be two round trips and a window between
/// them. The `UPDATE … RETURNING` makes "is it valid" and "it has just been
/// used" the same atomic act.
///
/// Both expiries are enforced here. Absolute expiry bounds a stolen cookie's
/// usefulness even on an active session; idle expiry closes the laptop nobody
/// logged out of (docs/12, T5).
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails. A token that is unknown, revoked
/// or expired is `Ok(None)` — not an error, because it is the ordinary case.
pub async fn authenticate(
    pool: &PgPool,
    token_hash: &[u8],
    idle_timeout_seconds: i64,
) -> Result<Option<AuthenticatedUser>, DbError> {
    let row = sqlx::query(
        "UPDATE sessions s
            SET last_seen_at = now()
          FROM users u
         WHERE s.token_hash = $1
           AND s.user_id = u.id
           AND s.revoked_at IS NULL
           AND s.absolute_expiry > now()
           AND s.last_seen_at > now() - make_interval(secs => $2)
     RETURNING s.id AS session_id, u.id AS user_id, u.email::text AS email,
               u.display_name, u.locale",
    )
    .bind(token_hash)
    .bind(seconds_as_f64(idle_timeout_seconds))
    .fetch_optional(pool)
    .await
    .map_err(DbError::Query)?;

    row.map(|row| {
        Ok(AuthenticatedUser {
            id: row.try_get("user_id").map_err(DbError::Query)?,
            email: row.try_get("email").map_err(DbError::Query)?,
            display_name: row.try_get("display_name").map_err(DbError::Query)?,
            locale: row.try_get("locale").map_err(DbError::Query)?,
            session_id: row.try_get("session_id").map_err(DbError::Query)?,
        })
    })
    .transpose()
}

/// Load a user by id, for the response to a login that has just succeeded.
///
/// Separate from [`authenticate`] rather than reusing it: that one is an
/// `UPDATE … RETURNING` which refreshes the idle window, and calling it here
/// would mean a login counted as two uses of a session that is one second old.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails. `Ok(None)` cannot happen for a
/// caller holding a `user_id` from this module, but is not worth an
/// unwrap: the row could have been deleted between the two statements.
pub async fn user_by_id(
    pool: &PgPool,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<Option<AuthenticatedUser>, DbError> {
    let row = sqlx::query(
        "SELECT id, email::text AS email, display_name, locale FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(DbError::Query)?;

    row.map(|row| {
        Ok(AuthenticatedUser {
            id: row.try_get("id").map_err(DbError::Query)?,
            email: row.try_get("email").map_err(DbError::Query)?,
            display_name: row.try_get("display_name").map_err(DbError::Query)?,
            locale: row.try_get("locale").map_err(DbError::Query)?,
            session_id,
        })
    })
    .transpose()
}

/// Revoke one session by its token.
///
/// Idempotent, and says nothing about whether the token was real: logout is
/// unauthenticated by nature — the caller presents a cookie we may not
/// recognise — so a truthful "no such session" would be an oracle for
/// guessing them.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn revoke(pool: &PgPool, token_hash: &[u8]) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(token_hash)
    .execute(pool)
    .await
    .map(drop)
    .map_err(DbError::Query)
}

/// Every organisation this user belongs to.
///
/// Runs under `app.current_user_id` and relies on the `memberships_self_read`
/// policy: `app.current_org_id` is not set here, because the caller has not
/// chosen an organisation yet — answering "which may I choose?" is this
/// function's entire job (docs/04).
///
/// # Errors
///
/// [`DbError::Query`] if any statement fails.
pub async fn memberships(pool: &PgPool, user_id: Uuid) -> Result<Vec<Membership>, DbError> {
    let mut tx = pool.begin().await.map_err(DbError::Query)?;

    sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(DbError::Query)?;

    // The join to `organizations` works without app.current_org_id because of
    // the `organizations_member_read` policy (migration 20260915100600); the
    // tenant policy alone would match nothing here and make "no memberships"
    // and "not yet scoped to an org" indistinguishable.
    let rows = sqlx::query(
        "SELECT m.org_id, o.slug::text AS org_slug, o.name AS org_name, m.role::text AS role
           FROM memberships m
           JOIN organizations o ON o.id = m.org_id
          WHERE m.user_id = $1
          ORDER BY o.name",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(DbError::Query)?;

    tx.commit().await.map_err(DbError::Query)?;

    rows.into_iter()
        .map(|row| {
            Ok(Membership {
                org_id: row.try_get("org_id").map_err(DbError::Query)?,
                org_slug: row.try_get("org_slug").map_err(DbError::Query)?,
                org_name: row.try_get("org_name").map_err(DbError::Query)?,
                role: row.try_get("role").map_err(DbError::Query)?,
            })
        })
        .collect()
}

/// `make_interval(secs => …)` takes a double precision.
///
/// The cast is written out rather than spelled `as f64` because the workspace
/// denies `as_conversions`: a silent truncation in a session lifetime is a
/// session that expires at the wrong time. An i64 large enough to lose
/// precision here is over 285 million years, and the configuration refuses
/// anything remotely near it.
fn seconds_as_f64(seconds: i64) -> f64 {
    f64::from(i32::try_from(seconds).unwrap_or(i32::MAX))
}
