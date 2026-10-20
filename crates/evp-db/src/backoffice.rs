// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The deployment operator's reads and writes: organisations, accounts, and
//! who belongs where (ADR-0045).
//!
//! Every function takes a connection already inside a transaction that called
//! [`enter`]; the policies from migration `20261020120000` are what make these
//! statements see anything at all. None of them sets `app.current_org_id`,
//! which is the other half of the guarantee: a backoffice transaction is never
//! also a tenant transaction, so it cannot reach tenant data through the
//! tenant policies either.
//!
//! Each write appends to `audit_log` on the same connection, attributed to
//! `'backoffice'` with no user, because there is none — and not to
//! `operations`, whose undo stack belongs to a user (ADR-0045).

use serde_json::json;
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;

/// What `audit_log.actor_label` says for every row written here.
const ACTOR_LABEL: &str = "backoffice";

/// An organisation, as the operator sees it.
#[derive(Debug, Clone)]
pub struct Organization {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub timezone: String,
    pub created_at: jiff::Timestamp,
    /// How many people may act in it. Zero is the state worth noticing: an
    /// organisation nobody can sign in to.
    pub member_count: i64,
}

/// One person's membership of one organisation, from the organisation's side.
#[derive(Debug, Clone)]
pub struct Member {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    /// `member_role` as text, for the reason given on
    /// [`crate::auth::Membership::role`].
    pub role: String,
    pub created_at: jiff::Timestamp,
}

/// An account, with every organisation it belongs to.
#[derive(Debug, Clone)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub created_at: jiff::Timestamp,
    /// `None` until the first sign-in — which is how the operator tells an
    /// account that was handed over from one still waiting to be used.
    pub last_login_at: Option<jiff::Timestamp>,
    pub memberships: Vec<crate::auth::Membership>,
}

/// Scope the current transaction to the backoffice.
///
/// `set_config(..., true)` is `SET LOCAL`: it ends with the transaction, so the
/// next request to borrow this pooled connection does not inherit the widest
/// scope this application has.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn enter(conn: &mut PgConnection) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.backoffice', 'on', true)")
        .execute(conn)
        .await
        .map(drop)
        .map_err(DbError::Query)
}

/// Whether `name` is in the `timezones` reference table.
///
/// `organizations.timezone` has no foreign key to it — it predates the table —
/// so the check the events' FK makes for free has to be made here, or an
/// organisation could default every new event to a zone the events table
/// would then refuse.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn timezone_exists(conn: &mut PgConnection, name: &str) -> Result<bool, DbError> {
    sqlx::query("SELECT EXISTS (SELECT 1 FROM timezones WHERE name = $1)")
        .bind(name)
        .fetch_one(conn)
        .await
        .map_err(DbError::Query)?
        .try_get(0)
        .map_err(DbError::Query)
}

/// Every organisation on the deployment, by name.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails or a row will not decode.
pub async fn list_organizations(conn: &mut PgConnection) -> Result<Vec<Organization>, DbError> {
    sqlx::query(
        "SELECT o.id, o.slug::text AS slug, o.name, o.timezone, o.created_at,
                (SELECT count(*) FROM memberships m WHERE m.org_id = o.id) AS member_count
           FROM organizations o
          ORDER BY o.name, o.slug",
    )
    .fetch_all(conn)
    .await
    .map_err(DbError::Query)?
    .iter()
    .map(organization)
    .collect()
}

/// Create an organisation with no members.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails — `23505` for a taken slug, `23514`
/// for one `organizations_slug_format` refuses. The caller translates both.
pub async fn create_organization(
    conn: &mut PgConnection,
    name: &str,
    slug: &str,
    timezone: &str,
) -> Result<Organization, DbError> {
    let row = sqlx::query(
        "INSERT INTO organizations (id, slug, name, timezone)
         VALUES ($1, $2::citext, $3, $4)
         RETURNING id, slug::text AS slug, name, timezone, created_at, 0::bigint AS member_count",
    )
    .bind(Uuid::now_v7())
    .bind(slug)
    .bind(name)
    .bind(timezone)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let created = organization(&row)?;

    audit(
        conn,
        Some(created.id),
        "organization.create",
        "organization",
        created.id,
        &json!({ "slug": created.slug, "name": created.name, "timezone": created.timezone }),
    )
    .await?;
    Ok(created)
}

/// The members of one organisation, by name.
///
/// An unknown organisation and one with no members both come back empty; the
/// caller asks [`organization_exists`] when it needs to tell them apart.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails or a row will not decode.
pub async fn list_members(conn: &mut PgConnection, org_id: Uuid) -> Result<Vec<Member>, DbError> {
    sqlx::query(
        "SELECT u.id AS user_id, u.email::text AS email, u.display_name,
                m.role::text AS role, m.created_at
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.org_id = $1
          ORDER BY u.display_name, u.email",
    )
    .bind(org_id)
    .fetch_all(conn)
    .await
    .map_err(DbError::Query)?
    .iter()
    .map(member)
    .collect()
}

/// Whether an organisation with this id exists.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn organization_exists(conn: &mut PgConnection, org_id: Uuid) -> Result<bool, DbError> {
    sqlx::query("SELECT EXISTS (SELECT 1 FROM organizations WHERE id = $1)")
        .bind(org_id)
        .fetch_one(conn)
        .await
        .map_err(DbError::Query)?
        .try_get(0)
        .map_err(DbError::Query)
}

/// Make `user_id` a member of `org_id` in `role`, or change the role of an
/// existing membership.
///
/// One upsert rather than "insert, or update if it exists": the operator's
/// intent is the end state, and two statements would race a second tab doing
/// the same thing into a `23505` that means nothing to them.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails — `23503` when the organisation or
/// the user does not exist, `22P02` for a role `member_role` does not have.
pub async fn assign_member(
    conn: &mut PgConnection,
    org_id: Uuid,
    user_id: Uuid,
    role: &str,
) -> Result<Member, DbError> {
    sqlx::query(
        "INSERT INTO memberships (id, org_id, user_id, role)
         VALUES ($1, $2, $3, $4::member_role)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(user_id)
    .bind(role)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let row = sqlx::query(
        "SELECT u.id AS user_id, u.email::text AS email, u.display_name,
                m.role::text AS role, m.created_at
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.org_id = $1 AND m.user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let assigned = member(&row)?;

    audit(
        conn,
        Some(org_id),
        "membership.assign",
        "user",
        user_id,
        &json!({ "role": assigned.role }),
    )
    .await?;
    Ok(assigned)
}

/// End a membership. `false` if there was none.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn remove_member(
    conn: &mut PgConnection,
    org_id: Uuid,
    user_id: Uuid,
) -> Result<bool, DbError> {
    let removed = sqlx::query(
        "DELETE FROM memberships WHERE org_id = $1 AND user_id = $2 RETURNING role::text AS role",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let Some(row) = removed else {
        return Ok(false);
    };
    let role: String = row.try_get("role").map_err(DbError::Query)?;
    audit_change(
        conn,
        Some(org_id),
        "membership.remove",
        "user",
        user_id,
        Some(&json!({ "role": role })),
        None,
    )
    .await?;
    Ok(true)
}

/// Every account on the deployment, by address, with its memberships.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails or a row will not decode.
pub async fn list_users(conn: &mut PgConnection) -> Result<Vec<User>, DbError> {
    let mut users: Vec<User> = sqlx::query(
        "SELECT id, email::text AS email, display_name, created_at, last_login_at
           FROM users
          ORDER BY email",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?
    .iter()
    .map(user)
    .collect::<Result<_, _>>()?;

    // One query for every membership rather than one per user: the page shows
    // them all at once, and N+1 round trips is the cost that grows with the
    // deployment rather than with what anybody is looking at.
    let memberships = sqlx::query(
        "SELECT m.user_id, m.org_id, o.slug::text AS org_slug, o.name AS org_name,
                m.role::text AS role
           FROM memberships m
           JOIN organizations o ON o.id = m.org_id
          ORDER BY o.name",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    for row in &memberships {
        let user_id: Uuid = row.try_get("user_id").map_err(DbError::Query)?;
        if let Some(owner) = users.iter_mut().find(|candidate| candidate.id == user_id) {
            owner.memberships.push(crate::auth::Membership {
                org_id: row.try_get("org_id").map_err(DbError::Query)?,
                org_slug: row.try_get("org_slug").map_err(DbError::Query)?,
                org_name: row.try_get("org_name").map_err(DbError::Query)?,
                role: row.try_get("role").map_err(DbError::Query)?,
            });
        }
    }
    Ok(users)
}

/// Create an account with a password identity, and no memberships.
///
/// The identity's subject is the address, as the bootstrap's is
/// ([`crate::auth::create_owner`]): when we are the authority, the address is
/// the best stable subject there is.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails — `23505` when the address already
/// has an account, in any letter case (`citext`).
pub async fn create_user(
    conn: &mut PgConnection,
    email: &str,
    display_name: &str,
    password_hash: &str,
) -> Result<User, DbError> {
    let user_id = Uuid::now_v7();
    let row = sqlx::query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, $3)
         RETURNING id, email::text AS email, display_name, created_at, last_login_at",
    )
    .bind(user_id)
    .bind(email)
    .bind(display_name)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let created = user(&row)?;

    sqlx::query(
        "INSERT INTO identities (id, user_id, provider, subject, email_at_link, password_hash)
         VALUES ($1, $2, 'password', $3, $3::citext, $4)",
    )
    .bind(Uuid::now_v7())
    .bind(user_id)
    .bind(&created.email)
    .bind(password_hash)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    // Deployment-level: an account belongs to no organisation until assigned.
    // The password hash is deliberately not in `after` — an audit log is read
    // by more people than the identities table is.
    audit(
        conn,
        None,
        "user.create",
        "user",
        user_id,
        &json!({ "email": created.email, "display_name": created.display_name }),
    )
    .await?;
    Ok(created)
}

async fn audit(
    conn: &mut PgConnection,
    org_id: Option<Uuid>,
    action: &str,
    entity_type: &str,
    entity_id: Uuid,
    after: &serde_json::Value,
) -> Result<(), DbError> {
    audit_change(
        conn,
        org_id,
        action,
        entity_type,
        entity_id,
        None,
        Some(after),
    )
    .await
}

async fn audit_change(
    conn: &mut PgConnection,
    org_id: Option<Uuid>,
    action: &str,
    entity_type: &str,
    entity_id: Uuid,
    before: Option<&serde_json::Value>,
    after: Option<&serde_json::Value>,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO audit_log (org_id, actor_id, actor_label, action, entity_type, entity_id,
                                before, after)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)",
    )
    .bind(org_id)
    .bind(ACTOR_LABEL)
    .bind(action)
    .bind(entity_type)
    .bind(entity_id)
    .bind(before)
    .bind(after)
    .execute(conn)
    .await
    .map(drop)
    .map_err(DbError::Query)
}

fn organization(row: &PgRow) -> Result<Organization, DbError> {
    Ok(Organization {
        id: row.try_get("id").map_err(DbError::Query)?,
        slug: row.try_get("slug").map_err(DbError::Query)?,
        name: row.try_get("name").map_err(DbError::Query)?,
        timezone: row.try_get("timezone").map_err(DbError::Query)?,
        created_at: timestamp(row, "created_at")?,
        member_count: row.try_get("member_count").map_err(DbError::Query)?,
    })
}

fn member(row: &PgRow) -> Result<Member, DbError> {
    Ok(Member {
        user_id: row.try_get("user_id").map_err(DbError::Query)?,
        email: row.try_get("email").map_err(DbError::Query)?,
        display_name: row.try_get("display_name").map_err(DbError::Query)?,
        role: row.try_get("role").map_err(DbError::Query)?,
        created_at: timestamp(row, "created_at")?,
    })
}

fn user(row: &PgRow) -> Result<User, DbError> {
    Ok(User {
        id: row.try_get("id").map_err(DbError::Query)?,
        email: row.try_get("email").map_err(DbError::Query)?,
        display_name: row.try_get("display_name").map_err(DbError::Query)?,
        created_at: timestamp(row, "created_at")?,
        last_login_at: row
            .try_get::<Option<jiff_sqlx::Timestamp>, _>("last_login_at")
            .map_err(DbError::Query)?
            .map(jiff_sqlx::Timestamp::to_jiff),
        memberships: Vec::new(),
    })
}

fn timestamp(row: &PgRow, column: &str) -> Result<jiff::Timestamp, DbError> {
    row.try_get::<jiff_sqlx::Timestamp, _>(column)
        .map(jiff_sqlx::Timestamp::to_jiff)
        .map_err(DbError::Query)
}
