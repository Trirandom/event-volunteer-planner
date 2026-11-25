// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Fixtures shared by the database-backed suites in this directory.
//!
//! Only what every suite does the same way lives here: the connection, the
//! owner-scoped org every test starts from, and a few literal helpers. Seeders
//! for events, forms, shifts and so on stay in their suites, because each one
//! seeds exactly the shape its assertions need.

use evp_db::DbError;
use jiff::Timestamp;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

/// The pool every suite runs on, connected as `evp_migrator`. Each test opens
/// one transaction on it and never commits, so nothing it does survives the
/// run. Not `sqlx::test`: that creates a database per test and needs
/// `CREATEDB`, which neither role has on purpose (`catalog.rs` has the full
/// reasoning).
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
pub(crate) async fn pool() -> PgPool {
    evp_db::connect(&url())
        .await
        .expect("could not connect to the test database")
}

/// The `evp_migrator` URL, for a suite that has to build its own pool or
/// connection rather than take [`pool`]'s.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
pub(crate) fn url() -> String {
    std::env::var("EVP_MIGRATION_DATABASE_URL").expect(
        "EVP_MIGRATION_DATABASE_URL must be set to run crates/evp-db's database-backed tests \
         (see crates/evp-db/tests/db/catalog.rs and migrations/README.md); `just test`/`just test-tz` \
         set it via compose.override.yaml",
    )
}

/// `set_config(name, value, true)`: a `SET LOCAL` that ends with the
/// transaction, as the org extractor's would.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
pub(crate) async fn set(conn: &mut PgConnection, name: &str, value: &str) {
    sqlx::query("SELECT set_config($1, $2, true)")
        .bind(name)
        .bind(value)
        .execute(&mut *conn)
        .await
        .expect("set_config");
}

/// Inserts an organisation, an owner user, and their membership on the
/// caller's transaction, and leaves `app.current_org_id` / `app.current_user_id`
/// / `app.current_role` set to them — the same three GUCs `evp-api::org`
/// would set for a request scoped to this org. Returns `(org_id, user_id)`.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
pub(crate) async fn seed_org(conn: &mut PgConnection) -> (Uuid, Uuid) {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    // Random per test so parallel tests (nextest's default) never collide on
    // `organizations_slug_format` uniqueness or `users.email` uniqueness —
    // both are real constraints and both are global to the shared dev
    // database these suites connect to.
    // The full 32 hex characters, not a prefix: two `seed_org` calls a few
    // microseconds apart (every test that seeds two orgs makes exactly that
    // call) share a UUIDv7's leading, timestamp-derived bits, so truncating
    // to the front would collide on `organizations_slug_key`. `5 + 32 = 37`
    // stays under `organizations_slug_format`'s 40-character cap.
    let suffix = Uuid::now_v7().simple().to_string();

    set(conn, "app.current_org_id", &org_id.to_string()).await;
    set(conn, "app.current_user_id", &user_id.to_string()).await;
    set(conn, "app.current_role", "owner").await;

    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2::citext, 'Test Org')")
        .bind(org_id)
        .bind(format!("test-{suffix}"))
        .execute(&mut *conn)
        .await
        .expect("insert organizations row");
    sqlx::query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, 'Test Owner')",
    )
    .bind(user_id)
    .bind(format!("{suffix}@example.test"))
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

/// An RFC 3339 instant literal.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a malformed literal here is a broken test, not a runtime case"
)]
pub(crate) fn at(value: &str) -> Timestamp {
    value.parse().expect("valid instant")
}

/// A twelve-hour period on 5 September 2026, for rows that need one but whose
/// test is not about it.
pub(crate) fn a_period() -> (Timestamp, Timestamp) {
    (at("2026-09-05T08:00:00Z"), at("2026-09-05T20:00:00Z"))
}

/// Asserts `error` is the database refusing with `sqlstate` on `constraint`.
pub(crate) fn assert_refused(error: &DbError, sqlstate: &str, constraint: &str) {
    assert_eq!(
        error.sqlstate().as_deref(),
        Some(sqlstate),
        "expected {sqlstate} ({constraint}), got {error:?}"
    );
    assert_eq!(error.constraint().as_deref(), Some(constraint), "{error:?}");
}
