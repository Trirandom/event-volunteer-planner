// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for `evp_db::backoffice` and migration
//! `20261020120000_backoffice_scope` (ADR-0045).
//!
//! The policies are the boundary, so most of what is asserted here is what
//! the `app.backoffice` scope must *not* reach: tenant data, and organisations
//! it may list but never rewrite. The repository round trips come after.
//!
//! Same discipline as `sms_settings.rs`: one uncommitted transaction per test
//! as `evp_migrator`, where `FORCE ROW LEVEL SECURITY` makes the policies bind
//! to the owner too.

use evp_db::backoffice;
use sqlx::{PgConnection, PgPool, Row as _};
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn pool() -> PgPool {
    let url = std::env::var("EVP_MIGRATION_DATABASE_URL").expect(
        "EVP_MIGRATION_DATABASE_URL must be set to run crates/evp-db's database-backed tests; \
         `just test`/`just test-tz` set it via compose.override.yaml",
    );
    evp_db::connect(&url)
        .await
        .expect("could not connect to the test database")
}

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::now_v7().simple())
}

/// An organisation with one owner and the default shift pattern, created the
/// way a tenant request would — then every scope cleared again, so the test
/// starts from "no GUC set" as a fresh backoffice request does.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_tenant(conn: &mut PgConnection) -> Uuid {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    set(conn, "app.current_org_id", &org_id.to_string()).await;
    set(conn, "app.current_user_id", &user_id.to_string()).await;
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2::citext, 'Tenant')")
        .bind(org_id)
        .bind(unique("tenant"))
        .execute(&mut *conn)
        .await
        .expect("insert organizations row");
    sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, 'Owner')")
        .bind(user_id)
        .bind(format!("{}@example.test", unique("owner")))
        .execute(&mut *conn)
        .await
        .expect("insert users row");
    sqlx::query("INSERT INTO memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')")
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(user_id)
        .execute(&mut *conn)
        .await
        .expect("insert memberships row");
    evp_db::patterns::seed_default(conn, org_id, user_id)
        .await
        .expect("seed the default shift pattern");
    set(conn, "app.current_org_id", "").await;
    set(conn, "app.current_user_id", "").await;
    org_id
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn set(conn: &mut PgConnection, name: &str, value: &str) {
    sqlx::query("SELECT set_config($1, $2, true)")
        .bind(name)
        .bind(value)
        .execute(&mut *conn)
        .await
        .expect("set_config");
}

#[expect(
    clippy::expect_used,
    reason = "test assertion — a failing count query is a broken test"
)]
async fn count(conn: &mut PgConnection, sql: &'static str, id: Uuid) -> i64 {
    sqlx::query(sql)
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        .expect("count query")
        .try_get::<i64, _>(0)
        .expect("count is a bigint")
}

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

#[tokio::test]
async fn without_the_scope_no_organisation_is_visible() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let org_id = seed_tenant(&mut tx).await;

    let seen = count(
        &mut tx,
        "SELECT count(*) FROM organizations WHERE id = $1",
        org_id,
    )
    .await;
    assert_eq!(seen, 0, "an unscoped transaction must see no tenant");
}

#[tokio::test]
async fn the_scope_sees_every_organisation_and_its_memberships() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let org_id = seed_tenant(&mut tx).await;
    backoffice::enter(&mut tx).await.expect("enter the scope");

    assert_eq!(
        count(
            &mut tx,
            "SELECT count(*) FROM organizations WHERE id = $1",
            org_id
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &mut tx,
            "SELECT count(*) FROM memberships WHERE org_id = $1",
            org_id
        )
        .await,
        1
    );
}

#[tokio::test]
async fn the_scope_does_not_reach_tenant_data() {
    // The backoffice administers who may act, not what they act on: a shift
    // pattern — like every volunteer, event and submission — stays invisible.
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let org_id = seed_tenant(&mut tx).await;
    backoffice::enter(&mut tx).await.expect("enter the scope");

    assert_eq!(
        count(
            &mut tx,
            "SELECT count(*) FROM shift_patterns WHERE org_id = $1",
            org_id
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &mut tx,
            "SELECT count(*) FROM operations WHERE org_id = $1",
            org_id
        )
        .await,
        0
    );
}

#[tokio::test]
async fn the_scope_can_neither_rename_nor_delete_an_organisation() {
    // No UPDATE or DELETE policy: RLS filters the target rows silently, so
    // the statement succeeds and touches nothing.
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let org_id = seed_tenant(&mut tx).await;
    backoffice::enter(&mut tx).await.expect("enter the scope");

    let renamed = sqlx::query("UPDATE organizations SET name = 'Hijacked' WHERE id = $1")
        .bind(org_id)
        .execute(&mut *tx)
        .await
        .expect("update runs")
        .rows_affected();
    let deleted = sqlx::query("DELETE FROM organizations WHERE id = $1")
        .bind(org_id)
        .execute(&mut *tx)
        .await
        .expect("delete runs")
        .rows_affected();

    assert_eq!(renamed, 0);
    assert_eq!(deleted, 0);
}

#[tokio::test]
async fn a_value_other_than_on_does_not_open_the_scope() {
    // The predicate is an equality on a literal, not "is set": a GUC left as
    // '' by an earlier transaction on the same pooled connection, or set to
    // anything else, must mean closed.
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let org_id = seed_tenant(&mut tx).await;

    for value in ["", "off", "true", "ON"] {
        set(&mut tx, "app.backoffice", value).await;
        assert_eq!(
            count(
                &mut tx,
                "SELECT count(*) FROM organizations WHERE id = $1",
                org_id
            )
            .await,
            0,
            "app.backoffice = {value:?} opened the scope"
        );
    }
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_organisation_is_created_empty_and_listed() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    backoffice::enter(&mut tx).await.expect("enter the scope");
    let slug = unique("bo");

    let created = backoffice::create_organization(&mut tx, "Soundclash", &slug, "Europe/Paris")
        .await
        .expect("create");
    assert_eq!(created.slug, slug);
    assert_eq!(created.member_count, 0);

    let listed = backoffice::list_organizations(&mut tx).await.expect("list");
    assert!(listed.iter().any(|org| org.id == created.id));
}

#[tokio::test]
async fn a_taken_slug_is_a_unique_violation() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    backoffice::enter(&mut tx).await.expect("enter the scope");
    let slug = unique("bo");

    backoffice::create_organization(&mut tx, "First", &slug, "Europe/Paris")
        .await
        .expect("first create");
    let error = backoffice::create_organization(&mut tx, "Second", &slug, "Europe/Paris")
        .await
        .expect_err("second create with the same slug");
    assert_eq!(error.sqlstate().as_deref(), Some("23505"));
}

#[tokio::test]
async fn a_malformed_slug_is_a_check_violation() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    backoffice::enter(&mut tx).await.expect("enter the scope");

    let error = backoffice::create_organization(&mut tx, "Bad", "-Bad Slug-", "Europe/Paris")
        .await
        .expect_err("organizations_slug_format must refuse it");
    assert_eq!(error.sqlstate().as_deref(), Some("23514"));
}

#[tokio::test]
async fn timezones_are_checked_against_the_reference_table() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");

    assert!(
        backoffice::timezone_exists(&mut tx, "Europe/Paris")
            .await
            .expect("query")
    );
    assert!(
        !backoffice::timezone_exists(&mut tx, "Mars/Olympus_Mons")
            .await
            .expect("query")
    );
}

#[tokio::test]
async fn a_user_is_created_with_a_password_identity() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    backoffice::enter(&mut tx).await.expect("enter the scope");
    let email = format!("{}@example.test", unique("coord"));

    let user = backoffice::create_user(&mut tx, &email, "Coordinator", "$argon2id$stub")
        .await
        .expect("create");
    assert_eq!(user.email, email);
    assert!(user.memberships.is_empty());

    let identities = count(
        &mut tx,
        "SELECT count(*) FROM identities WHERE user_id = $1 AND provider = 'password'",
        user.id,
    )
    .await;
    assert_eq!(identities, 1, "an account nobody can sign in to is useless");
}

#[tokio::test]
async fn a_taken_email_is_a_unique_violation_whatever_its_case() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    backoffice::enter(&mut tx).await.expect("enter the scope");
    let email = format!("{}@example.test", unique("dup"));

    backoffice::create_user(&mut tx, &email, "One", "$argon2id$stub")
        .await
        .expect("first create");
    let error = backoffice::create_user(&mut tx, &email.to_uppercase(), "Two", "$argon2id$stub")
        .await
        .expect_err("citext makes these one address");
    assert_eq!(error.sqlstate().as_deref(), Some("23505"));
}

#[tokio::test]
async fn assigning_twice_changes_the_role_instead_of_failing() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    backoffice::enter(&mut tx).await.expect("enter the scope");
    let org = backoffice::create_organization(&mut tx, "Org", &unique("bo"), "Europe/Paris")
        .await
        .expect("create org");
    let user = backoffice::create_user(
        &mut tx,
        &format!("{}@example.test", unique("m")),
        "Member",
        "$argon2id$stub",
    )
    .await
    .expect("create user");

    let first = backoffice::assign_member(&mut tx, org.id, user.id, "coordinator")
        .await
        .expect("assign");
    assert_eq!(first.role, "coordinator");
    let second = backoffice::assign_member(&mut tx, org.id, user.id, "owner")
        .await
        .expect("reassign");
    assert_eq!(second.role, "owner");

    let members = backoffice::list_members(&mut tx, org.id)
        .await
        .expect("list");
    assert_eq!(members.len(), 1);

    let users = backoffice::list_users(&mut tx).await.expect("list users");
    let listed = users
        .iter()
        .find(|candidate| candidate.id == user.id)
        .expect("listed");
    assert_eq!(listed.memberships.len(), 1);
    assert_eq!(
        listed.memberships.first().map(|m| m.role.as_str()),
        Some("owner")
    );
}

#[tokio::test]
async fn assigning_an_unknown_user_is_a_foreign_key_violation() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    backoffice::enter(&mut tx).await.expect("enter the scope");
    let org = backoffice::create_organization(&mut tx, "Org", &unique("bo"), "Europe/Paris")
        .await
        .expect("create org");

    let error = backoffice::assign_member(&mut tx, org.id, Uuid::now_v7(), "coordinator")
        .await
        .expect_err("no such user");
    assert_eq!(error.sqlstate().as_deref(), Some("23503"));
}

#[tokio::test]
async fn removing_a_membership_reports_whether_there_was_one() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    backoffice::enter(&mut tx).await.expect("enter the scope");
    let org = backoffice::create_organization(&mut tx, "Org", &unique("bo"), "Europe/Paris")
        .await
        .expect("create org");
    let user = backoffice::create_user(
        &mut tx,
        &format!("{}@example.test", unique("r")),
        "Leaving",
        "$argon2id$stub",
    )
    .await
    .expect("create user");
    backoffice::assign_member(&mut tx, org.id, user.id, "zone_lead")
        .await
        .expect("assign");

    assert!(
        backoffice::remove_member(&mut tx, org.id, user.id)
            .await
            .expect("remove")
    );
    assert!(
        !backoffice::remove_member(&mut tx, org.id, user.id)
            .await
            .expect("remove again")
    );
}

#[tokio::test]
async fn every_write_leaves_an_audit_row_attributed_to_the_backoffice() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    backoffice::enter(&mut tx).await.expect("enter the scope");
    let org = backoffice::create_organization(&mut tx, "Org", &unique("bo"), "Europe/Paris")
        .await
        .expect("create org");
    let user = backoffice::create_user(
        &mut tx,
        &format!("{}@example.test", unique("a")),
        "Audited",
        "$argon2id$stub",
    )
    .await
    .expect("create user");
    backoffice::assign_member(&mut tx, org.id, user.id, "coordinator")
        .await
        .expect("assign");

    // The tenant's own read policy is what an owner will use to see these
    // later, so that is the scope they are read back under.
    set(&mut tx, "app.current_org_id", &org.id.to_string()).await;
    let tenant_rows = count(
        &mut tx,
        "SELECT count(*) FROM audit_log
          WHERE org_id = $1 AND actor_id IS NULL AND actor_label = 'backoffice'",
        org.id,
    )
    .await;
    assert_eq!(tenant_rows, 2, "organisation created, member assigned");
}
