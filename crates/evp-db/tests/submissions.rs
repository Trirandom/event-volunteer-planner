// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for the volunteer pool, participations and
//! availability windows (docs/03 §3.3, §3.5): the hard constraints and RLS
//! tenant isolation, against a real PostgreSQL, never mocked (docs/13 §1).
//!
//! Same connection discipline as `crates/evp-db/tests/catalog.rs` — one
//! transaction per test against `EVP_MIGRATION_DATABASE_URL`, rolled back by
//! never being committed — see that file's module doc for why connecting as
//! `evp_migrator` still proves what a run as `evp_api` would (every table
//! here carries `FORCE ROW LEVEL SECURITY`, which binds the owner too).

use evp_db::DbError;
use evp_db::catalog;
use jiff_sqlx::ToSqlx as _;
use sqlx::{PgConnection, PgPool};
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

/// Same fixture as `catalog.rs`'s `seed_org`, duplicated rather than shared:
/// each `tests/*.rs` file compiles as its own binary, and a two-line helper is
/// cheaper to repeat than to factor into a crate this suite would then depend
/// on for tests alone.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_org(conn: &mut PgConnection) -> (Uuid, Uuid) {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    let suffix = Uuid::now_v7().simple().to_string();
    let slug = format!("test-{suffix}");
    let email = format!("{suffix}@example.test");

    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *conn)
        .await
        .expect("set app.current_org_id");
    sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *conn)
        .await
        .expect("set app.current_user_id");
    sqlx::query("SELECT set_config('app.current_role', 'owner', true)")
        .execute(&mut *conn)
        .await
        .expect("set app.current_role");

    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2::citext, 'Test Org')")
        .bind(org_id)
        .bind(&slug)
        .execute(&mut *conn)
        .await
        .expect("insert organizations row");
    sqlx::query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, 'Test Owner')",
    )
    .bind(user_id)
    .bind(&email)
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

    (org_id, user_id)
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
fn a_period() -> (jiff::Timestamp, jiff::Timestamp) {
    (
        "2026-09-05T08:00:00Z".parse().expect("valid instant"),
        "2026-09-05T20:00:00Z".parse().expect("valid instant"),
    )
}

/// One event, one volunteer, one participation linking them — the minimum
/// scaffold every test below needs before it can touch `availability_windows`.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_participation(conn: &mut PgConnection, org_id: Uuid, user_id: Uuid) -> Uuid {
    let (event, _operation) = catalog::create_event(
        conn,
        Uuid::now_v7(),
        org_id,
        user_id,
        None,
        "Open Air",
        "open-air",
        "Europe/Paris",
        a_period(),
    )
    .await
    .expect("create the event");

    let volunteer_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO volunteers (id, org_id, display_name) VALUES ($1, $2, 'Test Volunteer')",
    )
    .bind(volunteer_id)
    .bind(org_id)
    .execute(&mut *conn)
    .await
    .expect("insert volunteers row");

    let participation_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO participations (id, org_id, event_id, volunteer_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(participation_id)
    .bind(org_id)
    .bind(event.id)
    .bind(volunteer_id)
    .execute(&mut *conn)
    .await
    .expect("insert participations row");

    participation_id
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a malformed literal here is a broken test, not a runtime case"
)]
fn window(start: &str, end: &str) -> (jiff::Timestamp, jiff::Timestamp) {
    (
        start.parse().expect("valid instant"),
        end.parse().expect("valid instant"),
    )
}

async fn insert_window(
    conn: &mut PgConnection,
    org_id: Uuid,
    participation_id: Uuid,
    user_id: Uuid,
    period: (jiff::Timestamp, jiff::Timestamp),
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO availability_windows \
           (id, org_id, participation_id, kind, period, declared_by) \
         VALUES ($1, $2, $3, 'available', tstzrange($4, $5), $6)",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(participation_id)
    .bind(period.0.to_sqlx())
    .bind(period.1.to_sqlx())
    .bind(user_id)
    .execute(&mut *conn)
    .await
    .map(drop)
}

// ---------------------------------------------------------------------------
// Hard constraints: each test attempts the violation and asserts the SQLSTATE
// (docs/13 §2, migrations/README.md "Testing a migration").
// ---------------------------------------------------------------------------

#[tokio::test]
async fn overlapping_availability_windows_on_one_participation_is_23p01() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let participation_id = seed_participation(&mut tx, org_id, user_id).await;

    insert_window(
        &mut tx,
        org_id,
        participation_id,
        user_id,
        window("2026-09-05T10:00:00Z", "2026-09-05T14:00:00Z"),
    )
    .await
    .expect("the first window is created");

    let error = insert_window(
        &mut tx,
        org_id,
        participation_id,
        user_id,
        window("2026-09-05T12:00:00Z", "2026-09-05T16:00:00Z"),
    )
    .await
    .expect_err("an overlapping window on the same participation must be refused");

    let db_error = DbError::Query(error);
    assert_eq!(
        db_error.sqlstate().as_deref(),
        Some("23P01"),
        "expected exclusion_violation, got {db_error:?}"
    );
}

/// The boundary case `overlapping_availability_windows_on_one_participation_is_23p01`
/// does not cover: two windows that merely touch, sharing an endpoint, do not
/// overlap (`&&` on `tstzrange` is false for two ranges that only share a
/// boundary) and must both be accepted — this is what lets a volunteer's
/// picker store "08:00-12:00" and "12:00-18:00" as adjacent, un-merged rows
/// before the client-side merge (09 §3) runs.
#[tokio::test]
async fn adjacent_availability_windows_that_only_touch_are_accepted() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let participation_id = seed_participation(&mut tx, org_id, user_id).await;

    insert_window(
        &mut tx,
        org_id,
        participation_id,
        user_id,
        window("2026-09-05T08:00:00Z", "2026-09-05T12:00:00Z"),
    )
    .await
    .expect("the first window is created");

    insert_window(
        &mut tx,
        org_id,
        participation_id,
        user_id,
        window("2026-09-05T12:00:00Z", "2026-09-05T18:00:00Z"),
    )
    .await
    .expect("a window that only touches the first, sharing an endpoint, is accepted");
}

#[tokio::test]
async fn a_window_with_neither_provenance_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let participation_id = seed_participation(&mut tx, org_id, user_id).await;

    let (start, end) = window("2026-09-05T10:00:00Z", "2026-09-05T14:00:00Z");
    let error = sqlx::query(
        "INSERT INTO availability_windows (id, org_id, participation_id, kind, period) \
         VALUES ($1, $2, $3, 'available', tstzrange($4, $5))",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(participation_id)
    .bind(start.to_sqlx())
    .bind(end.to_sqlx())
    .execute(&mut *tx)
    .await
    .expect_err("a window naming neither declared_by nor source_submission_id must be refused");

    let db_error = DbError::Query(error);
    assert_eq!(
        db_error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation (availability_has_provenance), got {db_error:?}"
    );
}

// ---------------------------------------------------------------------------
// Tenant isolation, through the real RLS path (docs/03 §4).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn org_a_cannot_read_org_b_s_submissions() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");

    let (org_a, user_a) = seed_org(&mut tx).await;
    let fixture = evp_domain::example::build().expect("example.json parses and resolves");
    let (_festival, _operation) = catalog::create_example(&mut tx, org_a, user_a, &fixture)
        .await
        .expect("org A can load the worked example");

    let visible_to_a = evp_db::submissions::list(&mut tx, org_a)
        .await
        .expect("org A reads its own submissions");
    assert!(
        !visible_to_a.is_empty(),
        "the example fixture always ships with volunteers"
    );

    // Re-scope the same transaction to a second organisation, exactly as a
    // second request through evp-api::org would — a fresh SET LOCAL, not a
    // fresh connection.
    let (org_b, _user_b) = seed_org(&mut tx).await;

    let visible_to_b = evp_db::submissions::list(&mut tx, org_b)
        .await
        .expect("listing org B's submissions succeeds and returns zero rows");
    assert!(
        visible_to_b.is_empty(),
        "org B's session saw a submission it does not own: {visible_to_b:?}"
    );
}

#[tokio::test]
async fn writing_a_volunteer_stamped_with_another_org_s_id_is_rejected_by_rls() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");

    let (org_a, _user_a) = seed_org(&mut tx).await;
    let (_org_b, _user_b) = seed_org(&mut tx).await;

    // The transaction is now scoped to org B (the second seed_org call was
    // last), but this INSERT names org A explicitly — the attack RLS's
    // WITH CHECK exists to stop even when a handler forgot the WHERE.
    let error = sqlx::query(
        "INSERT INTO volunteers (id, org_id, display_name) VALUES ($1, $2, 'Smuggled In')",
    )
    .bind(Uuid::now_v7())
    .bind(org_a)
    .execute(&mut *tx)
    .await
    .expect_err("a volunteer stamped with another org's id must be refused");

    let db_error = DbError::Query(error);
    assert_eq!(
        db_error.sqlstate().as_deref(),
        Some("42501"),
        "expected insufficient_privilege (RLS WITH CHECK), got {db_error:?}"
    );
}
