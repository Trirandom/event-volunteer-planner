// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for the roster (docs/03 §3.6): the three hard rules
//! that guard `assignments`, each one attempted rather than described, with
//! its SQLSTATE asserted (docs/13 §2, `migrations/README.md`).
//!
//! Three of the six rules live here — nobody in two places at once (`23P01`),
//! nobody twice on one shift (also `23P01`, see that test for why it is not
//! the `23505` docs/03 §3.6 implies), nobody rostered who has declined or
//! withdrawn (`23514` on `withdrawn_participant`) — plus the two facts that
//! make the first of them trustworthy: the denormalised period is taken from
//! the shift and cannot be dictated by the caller, and moving a shift moves
//! the placements on it.
//!
//! Same connection discipline as `crates/evp-db/tests/catalog.rs`: one
//! transaction per test against `EVP_MIGRATION_DATABASE_URL`, never committed,
//! which is a rollback. See that file's module doc for why connecting as the
//! owner still proves what a run as `evp_api` would.

use evp_db::assignments::{self, NewAssignment};
use evp_db::catalog;
use evp_db::{DbError, locations, shifts};
use jiff::Timestamp;
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

/// Same fixture as `catalog.rs`'s `seed_org`, duplicated for the reason
/// `submissions.rs` gives: each `tests/*.rs` compiles as its own binary.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_org(conn: &mut PgConnection) -> (Uuid, Uuid) {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    let suffix = Uuid::now_v7().simple().to_string();

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

#[expect(
    clippy::expect_used,
    reason = "test fixture — a malformed literal here is a broken test, not a runtime case"
)]
fn at(value: &str) -> Timestamp {
    value.parse().expect("valid instant")
}

/// One event running the whole of 5 September, with one post to staff.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_event(conn: &mut PgConnection, org_id: Uuid, user_id: Uuid) -> (Uuid, Uuid) {
    let suffix = Uuid::now_v7().simple().to_string();
    let (event, _operation) = catalog::create_event(
        conn,
        Uuid::now_v7(),
        org_id,
        user_id,
        None,
        "Open Air",
        &format!("open-air-{suffix}"),
        "Europe/Paris",
        (at("2026-09-05T06:00:00Z"), at("2026-09-06T06:00:00Z")),
    )
    .await
    .expect("create the event");

    let (post, _operation) = locations::create(
        conn,
        org_id,
        event.id,
        user_id,
        &locations::NewLocation {
            kind: "zone".to_owned(),
            name: "Bar".to_owned(),
            description: None,
            address: None,
            exact_address: None,
            latitude: None,
            longitude: None,
            min_volunteers: None,
            max_volunteers: None,
            checked_by_default: true,
            adults_only: false,
            parent_id: None,
            sort_order: 0,
            colour: None,
            shift_pattern_id: None,
        },
    )
    .await
    .expect("create the location");

    (event.id, post.id)
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_shift(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    user_id: Uuid,
    location_id: Uuid,
    period: (Timestamp, Timestamp),
) -> Uuid {
    let (shift, _operation) = shifts::create(
        conn,
        org_id,
        event_id,
        user_id,
        &shifts::NewShift {
            location_id,
            title: None,
            period,
            required_count: 1,
            max_count: None,
            notes: None,
        },
    )
    .await
    .expect("create the shift");
    shift.id
}

/// One volunteer, enrolled on `event_id`. Returns the participation.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_participation(conn: &mut PgConnection, org_id: Uuid, event_id: Uuid) -> Uuid {
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
    .bind(event_id)
    .bind(volunteer_id)
    .execute(&mut *conn)
    .await
    .expect("insert participations row");

    participation_id
}

async fn roster(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    user_id: Uuid,
    shift_id: Uuid,
    participation_id: Uuid,
) -> Result<Option<(assignments::Assignment, catalog::OperationId)>, DbError> {
    assignments::create(
        conn,
        org_id,
        event_id,
        user_id,
        &NewAssignment {
            shift_id,
            participation_id,
            acknowledged_warnings: Vec::new(),
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// The three hard rules, each attempted (docs/13 §2)
// ---------------------------------------------------------------------------

/// HARD RULE: one volunteer is never in two places at once (docs/02 §5).
///
/// Two shifts at *different* posts whose hours overlap — which the schema
/// permits and a festival routinely has — with one volunteer on both.
#[tokio::test]
async fn one_volunteer_in_two_places_at_once_is_23p01() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, bar_id) = seed_event(&mut tx, org_id, user_id).await;

    let (door, _operation) = locations::create(
        &mut tx,
        org_id,
        event_id,
        user_id,
        &locations::NewLocation {
            kind: "zone".to_owned(),
            name: "Entrance".to_owned(),
            description: None,
            address: None,
            exact_address: None,
            latitude: None,
            longitude: None,
            min_volunteers: None,
            max_volunteers: None,
            checked_by_default: true,
            adults_only: false,
            parent_id: None,
            sort_order: 1,
            colour: None,
            shift_pattern_id: None,
        },
    )
    .await
    .expect("create the second location");

    let bar_shift = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T22:00:00Z")),
    )
    .await;
    let door_shift = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        door.id,
        (at("2026-09-05T20:00:00Z"), at("2026-09-06T00:00:00Z")),
    )
    .await;
    let participation_id = seed_participation(&mut tx, org_id, event_id).await;

    roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_shift,
        participation_id,
    )
    .await
    .expect("the first placement is accepted");

    let error = roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        door_shift,
        participation_id,
    )
    .await
    .expect_err("an overlapping placement for the same volunteer must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23P01"),
        "expected exclusion_violation, got {error:?}"
    );
}

/// The boundary the rule above must *not* refuse: two shifts that merely
/// touch. `tstzrange` is half-open and `&&` is false for ranges sharing only
/// an endpoint, which is what lets one volunteer work 18:00–20:00 and then
/// 20:00–22:00 — the ordinary double shift, and the case a naive
/// `start <= other.end` check gets wrong.
#[tokio::test]
async fn consecutive_shifts_for_one_volunteer_are_accepted() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, bar_id) = seed_event(&mut tx, org_id, user_id).await;

    let first = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;
    let second = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T20:00:00Z"), at("2026-09-05T22:00:00Z")),
    )
    .await;
    let participation_id = seed_participation(&mut tx, org_id, event_id).await;

    roster(&mut tx, org_id, event_id, user_id, first, participation_id)
        .await
        .expect("the first placement is accepted");
    roster(&mut tx, org_id, event_id, user_id, second, participation_id)
        .await
        .expect("a placement starting exactly when the last one ended is accepted");
}

/// HARD RULE: no duplicate placement on the same shift (docs/02 §5).
///
/// It is refused by `assignments_no_double_booking` (`23P01`) rather than by
/// `assignments_one_per_shift` (`23505`), and that is worth stating because
/// docs/03 §3.6 presents the partial unique index as the enforcer. A second
/// placement on the same shift carries the *same period*, so the exclusion
/// constraint sees an overlap and refuses first — and since `period` is
/// synced from the shift and never supplied by a caller, there is no way for
/// two live rows to share a shift and not overlap. The index is a cheaper
/// backstop that the constraint above it always reaches first; the rule is
/// enforced either way, which is what this test pins down.
#[tokio::test]
async fn the_same_volunteer_twice_on_one_shift_is_refused() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, bar_id) = seed_event(&mut tx, org_id, user_id).await;
    let shift_id = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;
    let participation_id = seed_participation(&mut tx, org_id, event_id).await;

    roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        shift_id,
        participation_id,
    )
    .await
    .expect("the first placement is accepted");

    let error = roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        shift_id,
        participation_id,
    )
    .await
    .expect_err("the same volunteer twice on one shift must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23P01"),
        "expected exclusion_violation, got {error:?}"
    );
    assert_eq!(
        error.constraint().as_deref(),
        Some("assignments_no_double_booking"),
        "the refusal names the constraint that made it, which is what the API maps on"
    );
}

/// HARD RULE: a declined or withdrawn participant cannot hold an assignment.
#[tokio::test]
async fn rostering_a_withdrawn_participant_is_refused() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, bar_id) = seed_event(&mut tx, org_id, user_id).await;
    let shift_id = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;
    let participation_id = seed_participation(&mut tx, org_id, event_id).await;

    sqlx::query("UPDATE participations SET status = 'withdrawn' WHERE id = $1")
        .bind(participation_id)
        .execute(&mut *tx)
        .await
        .expect("withdraw the participation");

    let error = roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        shift_id,
        participation_id,
    )
    .await
    .expect_err("a withdrawn participant cannot be rostered");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation, got {error:?}"
    );
    assert_eq!(
        error.constraint().as_deref(),
        Some("withdrawn_participant"),
        "the trigger names the constraint so the API can explain the remedy"
    );
}

/// The other direction of the same rule, and the one that actually bites:
/// withdrawing somebody who is already on the roster.
#[tokio::test]
async fn withdrawing_somebody_who_holds_a_placement_is_refused() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, bar_id) = seed_event(&mut tx, org_id, user_id).await;
    let shift_id = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;
    let participation_id = seed_participation(&mut tx, org_id, event_id).await;
    roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        shift_id,
        participation_id,
    )
    .await
    .expect("the placement is accepted");

    let error = sqlx::query("UPDATE participations SET status = 'withdrawn' WHERE id = $1")
        .bind(participation_id)
        .execute(&mut *tx)
        .await
        .expect_err("withdrawing somebody who still holds a placement must be refused");

    let error = DbError::Query(error);
    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation, got {error:?}"
    );
}

// ---------------------------------------------------------------------------
// What makes the exclusion constraint trustworthy
// ---------------------------------------------------------------------------

/// The denormalised period is the shift's, not something a caller supplies.
/// If it were not, the exclusion constraint would be comparing hours nobody
/// works.
#[tokio::test]
async fn the_stored_period_is_the_shifts_own() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, bar_id) = seed_event(&mut tx, org_id, user_id).await;
    let shift_id = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;
    let participation_id = seed_participation(&mut tx, org_id, event_id).await;

    let (assignment, _operation) = roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        shift_id,
        participation_id,
    )
    .await
    .expect("the placement is accepted")
    .expect("the participation exists");

    assert_eq!(assignment.period_start, at("2026-09-05T18:00:00Z"));
    assert_eq!(assignment.period_end, at("2026-09-05T20:00:00Z"));
}

/// Moving a shift moves the placements on it — the second half of the
/// propagation pair (docs/03 §3.6). Without it a roster would keep the hours
/// it was made against and quietly stop matching the schedule.
#[tokio::test]
async fn moving_a_shift_moves_its_placements() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, bar_id) = seed_event(&mut tx, org_id, user_id).await;
    let shift_id = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;
    let participation_id = seed_participation(&mut tx, org_id, event_id).await;
    roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        shift_id,
        participation_id,
    )
    .await
    .expect("the placement is accepted");

    sqlx::query("UPDATE shifts SET period = tstzrange($2, $3) WHERE id = $1")
        .bind(shift_id)
        .bind(at("2026-09-05T19:00:00Z").to_sqlx())
        .bind(at("2026-09-05T21:00:00Z").to_sqlx())
        .execute(&mut *tx)
        .await
        .expect("move the shift");

    let live = assignments::list(&mut tx, org_id, event_id)
        .await
        .expect("read the roster back");
    let placed = live.first().expect("the placement is still on the roster");
    assert_eq!(placed.period_start, at("2026-09-05T19:00:00Z"));
    assert_eq!(placed.period_end, at("2026-09-05T21:00:00Z"));
}

/// A cancelled placement leaves the roster and stops blocking the slot, which
/// is the whole behavioural difference between cancelling and deleting.
#[tokio::test]
async fn cancelling_frees_the_slot_and_keeps_the_row() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, bar_id) = seed_event(&mut tx, org_id, user_id).await;
    let shift_id = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;
    let participation_id = seed_participation(&mut tx, org_id, event_id).await;
    let (assignment, _operation) = roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        shift_id,
        participation_id,
    )
    .await
    .expect("the placement is accepted")
    .expect("the participation exists");

    let outcome = assignments::cancel(
        &mut tx,
        org_id,
        event_id,
        user_id,
        assignment.id,
        Some(assignment.version),
    )
    .await
    .expect("the cancellation is accepted");
    assert!(
        matches!(outcome, catalog::Versioned::Applied(_)),
        "cancelling a live placement applies"
    );

    assert!(
        assignments::list(&mut tx, org_id, event_id)
            .await
            .expect("read the roster back")
            .is_empty(),
        "a cancelled placement is not on the live roster"
    );
    assert!(
        assignments::get(&mut tx, org_id, event_id, assignment.id)
            .await
            .expect("read the row back")
            .is_some(),
        "the row is kept: a cancellation is history, not an erasure"
    );

    // And the slot is free again — the same volunteer can be put back on it,
    // which the partial unique index would refuse if a cancelled row still
    // counted.
    roster(
        &mut tx,
        org_id,
        event_id,
        user_id,
        shift_id,
        participation_id,
    )
    .await
    .expect("the slot is free once the placement is cancelled");
}

/// A participation belonging to another day of the festival is refused: an
/// assignment's event comes from its shift, so nothing else would notice
/// (migration `…180200`).
#[tokio::test]
async fn a_participation_from_another_day_is_23503() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (saturday, bar_id) = seed_event(&mut tx, org_id, user_id).await;
    let (sunday, _other_bar) = seed_event(&mut tx, org_id, user_id).await;

    let shift_id = seed_shift(
        &mut tx,
        org_id,
        saturday,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;
    // Enrolled on Sunday, pointed at a Saturday shift.
    let participation_id = seed_participation(&mut tx, org_id, sunday).await;

    let error = roster(
        &mut tx,
        org_id,
        saturday,
        user_id,
        shift_id,
        participation_id,
    )
    .await
    .expect_err("a participation from another edition cannot be rostered here");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23503"),
        "expected foreign_key_violation, got {error:?}"
    );
}

/// A participation of another organisation is not visible at all: the insert's
/// `SELECT` runs under RLS, so it matches nothing and the write reports "no
/// such participation" rather than leaking that one exists.
#[tokio::test]
async fn a_participation_of_another_org_is_invisible() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, bar_id) = seed_event(&mut tx, org_id, user_id).await;
    let shift_id = seed_shift(
        &mut tx,
        org_id,
        event_id,
        user_id,
        bar_id,
        (at("2026-09-05T18:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;

    let written = roster(&mut tx, org_id, event_id, user_id, shift_id, Uuid::now_v7())
        .await
        .expect("an unknown participation is an answer, not a failure");
    assert!(
        written.is_none(),
        "a participation this organisation cannot see is not one it can roster"
    );
}
