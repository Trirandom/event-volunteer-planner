// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for `evp_db::catalog`: the hard constraints, RLS
//! tenant isolation, and the worked example — against a real PostgreSQL,
//! never mocked (docs/13 §1).
//!
//! ## Why these tests connect as `evp_migrator` rather than spinning up an
//! isolated database per test
//!
//! `sqlx::test` — the tool `migrations/README.md` recommends — creates a
//! fresh database per test, which needs `CREATEDB` on the connecting role.
//! Neither `evp_migrator` nor `evp_api` has it, deliberately: `docker/db/init/00-roles.sh`
//! says why (docs/12 §3, docs/06 §2) and adding a third, `CREATEDB`-capable
//! role only for tests would be a second, weaker isolation boundary sitting
//! next to the real one.
//!
//! So every test here opens one transaction against the shared dev database
//! (`EVP_MIGRATION_DATABASE_URL`) and never commits it — dropping a
//! `Transaction` rolls it back, so nothing a test does is visible to another
//! test or survives the run. This is not a weaker guarantee than a scratch
//! database: `evp_migrator` owns every table, and every one of them carries
//! `FORCE ROW LEVEL SECURITY` (docs/03 §4, `migrations/README.md`), which is
//! precisely what makes the owner subject to the same policies `evp_api`
//! would be — so a test run this way proves the same thing a run against
//! `evp_api` would.
//!
//! Org/user/membership fixtures are inserted directly rather than through
//! `evp_db::auth::create_owner`, because that function opens and commits its
//! own transaction; this suite needs everything on the one transaction it
//! rolls back.

use evp_db::DbError;
use evp_db::catalog;
use jiff_sqlx::ToSqlx as _;
use sqlx::{PgConnection, PgPool, Row as _};
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn pool() -> PgPool {
    let url = std::env::var("EVP_MIGRATION_DATABASE_URL").expect(
        "EVP_MIGRATION_DATABASE_URL must be set to run crates/evp-db's database-backed tests \
         (see crates/evp-db/tests/catalog.rs and migrations/README.md); `just test`/`just test-tz` \
         set it via compose.override.yaml",
    );
    evp_db::connect(&url)
        .await
        .expect("could not connect to the test database")
}

/// Inserts an organisation, an owner user, and their membership on the
/// caller's transaction, and leaves `app.current_org_id` / `app.current_user_id`
/// / `app.current_role` set to them — the same three GUCs `evp-api::org`
/// would set for a request scoped to this org.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_org(conn: &mut PgConnection) -> (Uuid, Uuid) {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    // Random per test so parallel tests (nextest's default) never collide on
    // `organizations_slug_format` uniqueness or `users.email` uniqueness —
    // both are real constraints and both are global to the shared dev
    // database this suite connects to.
    // The full 32 hex characters, not a prefix: two `seed_org` calls a few
    // microseconds apart (every test that seeds two orgs makes exactly that
    // call) share a UUIDv7's leading, timestamp-derived bits, so truncating
    // to the front would collide on `organizations_slug_key`. `5 + 32 = 37`
    // stays under `organizations_slug_format`'s 40-character cap.
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

/// The value out of a versioned write, or a loud failure.
///
/// These tests assert on the row a write produced, and `Versioned`'s other two
/// arms are conditions the test itself set up wrong — a `let else` per call
/// site would be six copies of the same panic.
// `clippy::panic`, not `expect_used`: this helper panics outright and calls
// `.expect()` nowhere, so the old suppression named a lint it never triggered
// and `unfulfilled_lint_expectations` failed the build. `clippy.toml`'s
// `allow-panic-in-tests` does not reach here either — that relaxation applies
// to `#[cfg(test)]` modules, and an integration test under `tests/` is an
// ordinary binary as far as the lint is concerned.
#[expect(
    clippy::panic,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
fn applied<T>(outcome: catalog::Versioned<T>) -> T {
    match outcome {
        catalog::Versioned::Applied(value) => value,
        other => {
            let catalog::Versioned::Stale { current } = other else {
                panic!("the row this test just created is missing")
            };
            panic!("the version this test just read is stale; row is at {current}")
        }
    }
}

// ---------------------------------------------------------------------------
// Hard constraints: each test attempts the violation and asserts the SQLSTATE
// (docs/13 §2, migrations/README.md "Testing a migration").
// ---------------------------------------------------------------------------

#[tokio::test]
async fn duplicate_festival_slug_in_one_org_is_23505() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    catalog::create_festival(
        &mut tx,
        Uuid::now_v7(),
        org_id,
        user_id,
        "Soundclash 26",
        "soundclash-26",
        "Europe/Paris",
        a_period(),
    )
    .await
    .expect("first festival with this slug succeeds");

    let error = catalog::create_festival(
        &mut tx,
        Uuid::now_v7(),
        org_id,
        user_id,
        "Soundclash 26 (again)",
        "soundclash-26",
        "Europe/Paris",
        a_period(),
    )
    .await
    .expect_err("a second festival with the same (org_id, slug) must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23505"),
        "expected unique_violation, got {error:?}"
    );
}

#[tokio::test]
async fn unknown_timezone_on_an_event_is_23503() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let error = catalog::create_event(
        &mut tx,
        Uuid::now_v7(),
        org_id,
        user_id,
        None,
        "Open Air",
        "open-air",
        "Not/A_Real_Zone",
        a_period(),
    )
    .await
    .expect_err("an unknown IANA name must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23503"),
        "expected foreign_key_violation against timezones, got {error:?}"
    );
}

/// `events_color_in_palette`: the column cannot hold a colour that is not in
/// the palette, because it cannot hold a colour at all — only an index into a
/// list whose entries are proved against black and white.
#[tokio::test]
async fn a_colour_outside_the_palette_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (event, _op) = catalog::create_event(
        &mut tx,
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

    let error = catalog::update_event(
        &mut tx,
        org_id,
        user_id,
        event.id,
        Some(event.version),
        &catalog::EventPatch {
            color: Some(64),
            ..catalog::EventPatch::default()
        },
    )
    .await
    .expect_err("an index past the end of the palette must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation against events_color_in_palette, got {error:?}"
    );
}

/// Siblings never share a colour, because "the next one" is the lowest index
/// none of them holds. The festival's day strip is the reason: six days drawn
/// in one colour is six days nobody can tell apart.
#[tokio::test]
async fn siblings_are_created_in_different_colours() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let mut colours = Vec::new();
    for slug in ["day-one", "day-two", "day-three"] {
        let (event, _op) = catalog::create_event(
            &mut tx,
            Uuid::now_v7(),
            org_id,
            user_id,
            None,
            slug,
            slug,
            "Europe/Paris",
            a_period(),
        )
        .await
        .expect("create the event");
        colours.push(event.color);
    }

    assert_eq!(
        colours,
        vec![0, 1, 2],
        "each event takes the lowest index its siblings left free"
    );
}

/// The freed index is reused. Deleting the second of three days and adding a
/// fourth gives it colour 1, not colour 3 — the alternative is a festival that
/// runs out of distinguishable colours after a few rounds of editing.
#[tokio::test]
async fn a_colour_freed_by_a_deletion_is_handed_out_again() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let mut ids = Vec::new();
    for slug in ["day-one", "day-two", "day-three"] {
        let (event, _op) = catalog::create_event(
            &mut tx,
            Uuid::now_v7(),
            org_id,
            user_id,
            None,
            slug,
            slug,
            "Europe/Paris",
            a_period(),
        )
        .await
        .expect("create the event");
        ids.push(event.id);
    }

    catalog::delete_event(&mut tx, org_id, ids[1], None)
        .await
        .expect("delete the middle day");

    let (replacement, _op) = catalog::create_event(
        &mut tx,
        Uuid::now_v7(),
        org_id,
        user_id,
        None,
        "day-four",
        "day-four",
        "Europe/Paris",
        a_period(),
    )
    .await
    .expect("create the replacement");

    assert_eq!(replacement.color, 1);
}

/// Widening the operational window leaves `public_period` alone.
///
/// The regression test for the rule this column used to carry: the first
/// widening wrote the old period in as the published hours. It belongs at this
/// level as well as at the API's, because the wrong version of it lived in
/// exactly one `CASE` in exactly this `UPDATE`.
#[tokio::test]
async fn widening_an_event_leaves_the_doors_where_they_were() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (event, _op) = catalog::create_event(
        &mut tx,
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
    assert_eq!(event.public_period_start, None);

    let (later, _op) = applied(
        catalog::update_event(
            &mut tx,
            org_id,
            user_id,
            event.id,
            Some(event.version),
            &catalog::EventPatch {
                period: Some((
                    "2026-09-05T06:00:00Z".parse().expect("valid instant"),
                    "2026-09-05T23:00:00Z".parse().expect("valid instant"),
                )),
                ..catalog::EventPatch::default()
            },
        )
        .await
        .expect("widen the event"),
    );

    assert_eq!(
        later.public_period_start, None,
        "growing the working hours says nothing about the doors"
    );
}

/// The doors are a tri-state: set, left alone, and taken back off. The middle
/// one is the case a two-valued field cannot express, and the last one is the
/// case an `Option` would collapse into it.
#[tokio::test]
async fn door_times_are_set_left_alone_and_cleared() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (event, _op) = catalog::create_event(
        &mut tx,
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

    let doors: (jiff::Timestamp, jiff::Timestamp) = (
        "2026-09-05T10:00:00Z".parse().expect("valid instant"),
        "2026-09-05T18:00:00Z".parse().expect("valid instant"),
    );
    let (set, _op) = applied(
        catalog::update_event(
            &mut tx,
            org_id,
            user_id,
            event.id,
            Some(event.version),
            &catalog::EventPatch {
                public_period: catalog::Patch::Set(doors),
                ..catalog::EventPatch::default()
            },
        )
        .await
        .expect("set the doors"),
    );
    assert_eq!(set.public_period_start, Some(doors.0));
    assert_eq!(set.public_period_end, Some(doors.1));

    let (renamed, _op) = applied(
        catalog::update_event(
            &mut tx,
            org_id,
            user_id,
            event.id,
            Some(set.version),
            &catalog::EventPatch {
                name: Some("Renamed".to_owned()),
                ..catalog::EventPatch::default()
            },
        )
        .await
        .expect("rename"),
    );
    assert_eq!(
        renamed.public_period_start,
        Some(doors.0),
        "an unmentioned column is an unchanged column"
    );

    let (cleared, _op) = applied(
        catalog::update_event(
            &mut tx,
            org_id,
            user_id,
            event.id,
            Some(renamed.version),
            &catalog::EventPatch {
                public_period: catalog::Patch::Clear,
                ..catalog::EventPatch::default()
            },
        )
        .await
        .expect("clear the doors"),
    );
    assert_eq!(cleared.public_period_start, None);
    assert_eq!(cleared.public_period_end, None);
}

#[tokio::test]
async fn a_shift_outside_its_event_s_period_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (event, _operation) = catalog::create_event(
        &mut tx,
        Uuid::now_v7(),
        org_id,
        user_id,
        None,
        "Open Air",
        "open-air",
        "Europe/Paris",
        a_period(), // 08:00Z-20:00Z
    )
    .await
    .expect("event is created");

    let zone_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO locations (id, org_id, event_id, parent_id, kind, name, sort_order) \
         VALUES ($1, $2, $3, NULL, 'zone', 'Missions', 0)",
    )
    .bind(zone_id)
    .bind(org_id)
    .bind(event.id)
    .execute(&mut *tx)
    .await
    .expect("zone is created");

    // 22:00Z-23:00Z the same day: entirely after the event's 20:00Z end, so
    // this is the shift-outside-event trigger, not merely an empty range.
    let result = sqlx::query(
        "INSERT INTO shifts (id, org_id, event_id, location_id, period) \
         VALUES ($1, $2, $3, $4, tstzrange($5, $6))",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(event.id)
    .bind(zone_id)
    .bind(
        "2026-09-05T22:00:00Z"
            .parse::<jiff::Timestamp>()
            .expect("valid instant")
            .to_sqlx(),
    )
    .bind(
        "2026-09-05T23:00:00Z"
            .parse::<jiff::Timestamp>()
            .expect("valid instant")
            .to_sqlx(),
    )
    .execute(&mut *tx)
    .await;

    let error = result.expect_err("a shift outside its event's period must be refused");
    let db_error = DbError::Query(error);
    assert_eq!(
        db_error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation (shift_outside_event), got {db_error:?}"
    );
    assert_eq!(
        db_error.constraint().as_deref(),
        Some("shift_outside_event")
    );
}

// ---------------------------------------------------------------------------
// Tenant isolation, through the real RLS path (docs/03 §4).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn org_a_cannot_read_org_b_s_festivals() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");

    let (org_a, user_a) = seed_org(&mut tx).await;
    let (festival_a, _operation) = catalog::create_festival(
        &mut tx,
        Uuid::now_v7(),
        org_a,
        user_a,
        "Org A's Festival",
        "org-a-festival",
        "Europe/Paris",
        a_period(),
    )
    .await
    .expect("org A can create its own festival");

    // Re-scope the same transaction to a second organisation, exactly as a
    // second request through evp-api::org would — a fresh SET LOCAL, not a
    // fresh connection. `festival_a.id` is captured above, before the
    // rescope, standing in for an attacker who obtained or guessed the id —
    // a raw query issued *after* this point would be filtered by RLS itself
    // and would prove nothing about org B's session specifically.
    let (org_b, _user_b) = seed_org(&mut tx).await;

    let visible = catalog::list_festivals(&mut tx, org_b, None)
        .await
        .expect("listing org B's festivals succeeds and returns zero rows");
    assert!(
        visible.is_empty(),
        "org B's session saw a festival it does not own: {visible:?}"
    );

    // Asking for it by id, not just by list, must also come back empty — the
    // handler in evp-api::catalog maps this straight to 404.
    let by_id = catalog::get_festival(&mut tx, org_b, festival_a.id)
        .await
        .expect("the query itself succeeds");
    assert!(
        by_id.is_none(),
        "org B could read org A's festival by id: {by_id:?}"
    );
}

#[tokio::test]
async fn writing_a_row_stamped_with_another_org_s_id_is_rejected_by_rls() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");

    let (org_a, _user_a) = seed_org(&mut tx).await;
    let (_org_b, user_b) = seed_org(&mut tx).await;

    // The transaction is now scoped to org B (the second `seed_org` call was
    // last), but this INSERT names org A explicitly — the attack RLS's
    // WITH CHECK exists to stop even when a handler forgot the WHERE.
    let error = catalog::create_festival(
        &mut tx,
        Uuid::now_v7(),
        org_a,
        user_b,
        "Smuggled In",
        "smuggled-in",
        "Europe/Paris",
        a_period(),
    )
    .await
    .expect_err("a festival stamped with another org's id must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("42501"),
        "expected insufficient_privilege (RLS WITH CHECK), got {error:?}"
    );
}

// ---------------------------------------------------------------------------
// SET LOCAL, not SET: the GUC must not survive onto the next checkout of the
// same pooled connection (docs/02 §3, docs/03 §4, migrations/README.md).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn app_current_org_id_does_not_leak_across_pooled_connections() {
    // A pool of exactly one connection: the second `begin()` below is
    // guaranteed to reuse the same physical connection the first transaction
    // used, which is the only way this test can tell SET LOCAL apart from SET.
    let url = std::env::var("EVP_MIGRATION_DATABASE_URL")
        .expect("EVP_MIGRATION_DATABASE_URL must be set (see catalog.rs's `pool()` helper)");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect");

    let marker = Uuid::now_v7().to_string();
    let mut first = pool.begin().await.expect("begin first transaction");
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(&marker)
        .execute(&mut *first)
        .await
        .expect("set_config");
    first
        .commit()
        .await
        .expect("commit releases the connection back to the pool");

    let mut second = pool.begin().await.expect("begin second transaction");
    let row = sqlx::query("SELECT current_setting('app.current_org_id', true) AS value")
        .fetch_one(&mut *second)
        .await
        .expect("reading the GUC");
    let value: Option<String> = row.try_get("value").expect("value column");
    second.rollback().await.expect("rollback");

    // Per migration 20260915100700: the GUC exists but reverts to the empty
    // string at commit, never to the marker from the transaction before it.
    assert_ne!(
        value.as_deref(),
        Some(marker.as_str()),
        "app.current_org_id leaked across a pooled connection — SET LOCAL is not doing its job"
    );
}

// ---------------------------------------------------------------------------
// The worked example.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_example_creates_the_expected_structure_on_an_empty_org() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    assert!(
        !catalog::org_has_any_festival(&mut tx, org_id)
            .await
            .expect("checking emptiness"),
        "a freshly seeded org must start with no festival"
    );

    let fixture = evp_domain::example::build().expect("example.json parses and resolves");
    let expected_events = fixture.events.len();
    let expected_shifts: usize = fixture.events.iter().map(|event| event.shifts.len()).sum();

    let (festival, _operation) = catalog::create_example(&mut tx, org_id, user_id, &fixture)
        .await
        .expect("the example persists on an empty org");

    assert_eq!(festival.name, "Soundclash 26");
    assert_eq!(
        festival.event_count,
        i64::try_from(expected_events).unwrap()
    );

    let events = catalog::list_events_for_festival(&mut tx, org_id, festival.id)
        .await
        .expect("listing the created events");
    assert_eq!(events.len(), expected_events);

    let shift_count: i64 = sqlx::query("SELECT count(*) AS n FROM shifts WHERE org_id = $1")
        .bind(org_id)
        .fetch_one(&mut *tx)
        .await
        .expect("counting shifts")
        .try_get("n")
        .expect("n column");
    assert_eq!(shift_count, i64::try_from(expected_shifts).unwrap());

    // Zones and posts arrive as dumped: the same count of each kind, so a
    // post whose parent failed to resolve cannot quietly become a zone.
    let expected_posts: usize = fixture
        .events
        .iter()
        .flat_map(|event| &event.locations)
        .filter(|location| location.parent.is_some())
        .count();
    let expected_locations: usize = fixture
        .events
        .iter()
        .map(|event| event.locations.len())
        .sum();
    let row = sqlx::query(
        "SELECT count(*) AS n, count(*) FILTER (WHERE kind = 'post') AS posts \
         FROM locations WHERE org_id = $1",
    )
    .bind(org_id)
    .fetch_one(&mut *tx)
    .await
    .expect("counting locations");
    let locations: i64 = row.try_get("n").expect("n column");
    let posts: i64 = row.try_get("posts").expect("posts column");
    assert_eq!(locations, i64::try_from(expected_locations).unwrap());
    assert_eq!(posts, i64::try_from(expected_posts).unwrap());

    // The mission and shift details survive the round trip, not only the rows.
    let described: i64 = sqlx::query(
        "SELECT count(*) AS n FROM locations WHERE org_id = $1 AND description IS NOT NULL",
    )
    .bind(org_id)
    .fetch_one(&mut *tx)
    .await
    .expect("counting described locations")
    .try_get("n")
    .expect("n column");
    let expected_described = fixture
        .events
        .iter()
        .flat_map(|event| &event.locations)
        .filter(|location| location.description.is_some())
        .count();
    assert_eq!(described, i64::try_from(expected_described).unwrap());

    // Now the org is non-empty; a second load must be refused by the caller's
    // own check (the handler in evp-api::catalog is what actually returns
    // 409 — this asserts the flag it reads).
    assert!(
        catalog::org_has_any_festival(&mut tx, org_id)
            .await
            .expect("checking emptiness again"),
        "the org must report non-empty immediately after the example loads"
    );
}

/// `SELECT count(*) AS n … WHERE org_id = $1`, for the example tests' many
/// row counts.
#[expect(
    clippy::expect_used,
    reason = "test helper — a failed count must abort the test loudly, not be handled"
)]
async fn count(tx: &mut PgConnection, sql: &'static str, org_id: Uuid) -> i64 {
    sqlx::query(sql)
        .bind(org_id)
        .fetch_one(&mut *tx)
        .await
        .expect("counting rows")
        .try_get("n")
        .expect("n column")
}

/// The example arrives with volunteers, not just structure (docs/09,
/// docs/03 §3.10): a submission per fixture volunteer, a participation per
/// event they said anything about, and one `available` window per range they
/// declared.
#[tokio::test]
async fn the_example_creates_volunteers_participations_and_availability() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let fixture = evp_domain::example::build().expect("example.json parses and resolves");
    let expected_volunteers = fixture.volunteers.len();
    let expected_participations: usize = fixture
        .volunteers
        .iter()
        .map(|volunteer| volunteer.participations.len())
        .sum();
    let expected_windows: usize = fixture
        .volunteers
        .iter()
        .flat_map(|volunteer| &volunteer.participations)
        .map(|participation| participation.windows.len())
        .sum();

    let (_festival, _operation) = catalog::create_example(&mut tx, org_id, user_id, &fixture)
        .await
        .expect("the example persists on an empty org");

    let volunteer_count = count(
        &mut tx,
        "SELECT count(*) AS n FROM volunteers WHERE org_id = $1",
        org_id,
    )
    .await;
    assert_eq!(volunteer_count, i64::try_from(expected_volunteers).unwrap());

    let submission_count = count(
        &mut tx,
        "SELECT count(*) AS n FROM submissions WHERE org_id = $1",
        org_id,
    )
    .await;
    assert_eq!(
        submission_count,
        i64::try_from(expected_volunteers).unwrap(),
        "one submission per fixture volunteer, including those with no availability"
    );

    let participation_count = count(
        &mut tx,
        "SELECT count(*) AS n FROM participations WHERE org_id = $1",
        org_id,
    )
    .await;
    assert_eq!(
        participation_count,
        i64::try_from(expected_participations).unwrap()
    );

    let window_count = count(
        &mut tx,
        "SELECT count(*) AS n FROM availability_windows WHERE org_id = $1",
        org_id,
    )
    .await;
    assert_eq!(window_count, i64::try_from(expected_windows).unwrap());

    // Each window keeps the provenance it was dumped with: read off the
    // volunteer's submission, or typed in by a coordinator (ADR-0009).
    let expected_hand_entered = fixture
        .volunteers
        .iter()
        .flat_map(|volunteer| &volunteer.participations)
        .flat_map(|participation| &participation.windows)
        .filter(|window| window.declared)
        .count();
    let hand_entered = count(
        &mut tx,
        "SELECT count(*) AS n FROM availability_windows WHERE org_id = $1 AND declared_by IS NOT NULL",
        org_id,
    )
    .await;
    assert_eq!(hand_entered, i64::try_from(expected_hand_entered).unwrap());

    let expected_assignments: usize = fixture
        .volunteers
        .iter()
        .flat_map(|volunteer| &volunteer.participations)
        .map(|participation| participation.assignments.len())
        .sum();
    let assignment_count = count(
        &mut tx,
        "SELECT count(*) AS n FROM assignments WHERE org_id = $1",
        org_id,
    )
    .await;
    assert_eq!(
        assignment_count,
        i64::try_from(expected_assignments).unwrap()
    );

    let submissions = evp_db::submissions::list(&mut tx, org_id)
        .await
        .expect("listing the created submissions");
    assert_eq!(submissions.len(), expected_volunteers);
    assert!(
        submissions
            .windows(2)
            .all(|pair| pair[0].submitted_at <= pair[1].submitted_at),
        "submissions must come back sorted by submitted_at ascending"
    );
}
