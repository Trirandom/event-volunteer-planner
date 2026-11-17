// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! A post is a role within its zone's shifts (ADR-0052), and the schema is
//! what holds that shape: shifts live on zones only, and an assignment's
//! `post_id` names a post of *its shift's* zone. Each rule is attempted
//! rather than described, with its SQLSTATE and constraint asserted
//! (docs/13 §2), from both sides where the trigger guards both.
//!
//! Same connection discipline as `crates/evp-db/tests/catalog.rs`: one
//! transaction per test, never committed.

use evp_db::assignments::{self, NewAssignment};
use evp_db::catalog;
use evp_db::{DbError, locations, shifts};
use jiff::Timestamp;
use sqlx::postgres::PgArguments;
use sqlx::query::Query;
use sqlx::{PgConnection, PgPool, Postgres};
use uuid::Uuid;

type Statement<'q> = Query<'q, Postgres, PgArguments>;

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

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn act_as(conn: &mut PgConnection, org_id: Uuid) {
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *conn)
        .await
        .expect("set app.current_org_id");
}

/// Same fixture as `catalog.rs`'s `seed_org`, duplicated because each
/// `tests/*.rs` compiles as its own binary.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_org(conn: &mut PgConnection) -> (Uuid, Uuid) {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    let suffix = Uuid::now_v7().simple().to_string();

    act_as(conn, org_id).await;
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

/// The festival night every test here staffs: a Bar zone with a Bar manager
/// post, and a second zone, Entrance, whose post is Cashier.
struct Night {
    org_id: Uuid,
    user_id: Uuid,
    event_id: Uuid,
    bar: Uuid,
    bar_manager: Uuid,
    entrance: Uuid,
    cashier: Uuid,
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn location(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    user_id: Uuid,
    name: &str,
    parent_id: Option<Uuid>,
) -> Uuid {
    let (row, _operation) = locations::create(
        conn,
        org_id,
        event_id,
        user_id,
        &locations::NewLocation {
            kind: if parent_id.is_some() { "post" } else { "zone" }.to_owned(),
            name: name.to_owned(),
            description: None,
            address: None,
            exact_address: None,
            latitude: None,
            longitude: None,
            min_volunteers: None,
            max_volunteers: None,
            checked_by_default: true,
            adults_only: false,
            parent_id,
            sort_order: 0,
            colour: None,
            shift_pattern_id: None,
        },
    )
    .await
    .expect("create the location");
    row.id
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_night(conn: &mut PgConnection) -> Night {
    let (org_id, user_id) = seed_org(conn).await;
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

    let bar = location(conn, org_id, event.id, user_id, "Bar", None).await;
    let bar_manager = location(conn, org_id, event.id, user_id, "Bar manager", Some(bar)).await;
    let entrance = location(conn, org_id, event.id, user_id, "Entrance", None).await;
    let cashier = location(conn, org_id, event.id, user_id, "Cashier", Some(entrance)).await;

    Night {
        org_id,
        user_id,
        event_id: event.id,
        bar,
        bar_manager,
        entrance,
        cashier,
    }
}

fn new_shift(location_id: Uuid, start: &str, end: &str) -> shifts::NewShift {
    shifts::NewShift {
        location_id,
        title: None,
        period: (at(start), at(end)),
        required_count: 1,
        max_count: None,
        notes: None,
    }
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_shift(conn: &mut PgConnection, night: &Night, location_id: Uuid) -> Uuid {
    let (shift, _operation) = shifts::create(
        conn,
        night.org_id,
        night.event_id,
        night.user_id,
        &new_shift(location_id, "2026-09-05T18:00:00Z", "2026-09-05T20:00:00Z"),
    )
    .await
    .expect("create the shift");
    shift.id
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_participation(conn: &mut PgConnection, night: &Night) -> Uuid {
    let volunteer_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO volunteers (id, org_id, display_name) VALUES ($1, $2, 'Test Volunteer')",
    )
    .bind(volunteer_id)
    .bind(night.org_id)
    .execute(&mut *conn)
    .await
    .expect("insert volunteers row");

    let participation_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO participations (id, org_id, event_id, volunteer_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(participation_id)
    .bind(night.org_id)
    .bind(night.event_id)
    .bind(volunteer_id)
    .execute(&mut *conn)
    .await
    .expect("insert participations row");

    participation_id
}

async fn roster(
    conn: &mut PgConnection,
    night: &Night,
    shift_id: Uuid,
    participation_id: Uuid,
    post_id: Option<Uuid>,
) -> Result<Option<(assignments::Assignment, catalog::OperationId)>, DbError> {
    assignments::create(
        conn,
        night.org_id,
        night.event_id,
        night.user_id,
        &NewAssignment {
            shift_id,
            participation_id,
            post_id,
            acknowledged_warnings: Vec::new(),
        },
    )
    .await
}

/// Runs `statement` inside a savepoint and hands back the error it must
/// raise, leaving the transaction usable for the next attempt.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn refused(conn: &mut PgConnection, statement: Statement<'_>) -> DbError {
    sqlx::query("SAVEPOINT attempt")
        .execute(&mut *conn)
        .await
        .expect("savepoint");
    let error = statement
        .execute(&mut *conn)
        .await
        .expect_err("the statement must be refused");
    sqlx::query("ROLLBACK TO SAVEPOINT attempt")
        .execute(&mut *conn)
        .await
        .expect("rollback to savepoint");
    DbError::Query(error)
}

fn assert_refused(error: &DbError, sqlstate: &str, constraint: &str) {
    assert_eq!(
        error.sqlstate().as_deref(),
        Some(sqlstate),
        "expected {sqlstate} ({constraint}), got {error:?}"
    );
    assert_eq!(error.constraint().as_deref(), Some(constraint), "{error:?}");
}

// ---------------------------------------------------------------------------
// Shifts live on zones
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_shift_on_a_post_is_refused() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;

    let error = shifts::create(
        &mut tx,
        night.org_id,
        night.event_id,
        night.user_id,
        &new_shift(
            night.bar_manager,
            "2026-09-05T18:00:00Z",
            "2026-09-05T20:00:00Z",
        ),
    )
    .await
    .expect_err("a shift cannot be scheduled on a post");

    assert_refused(&error, "23514", "shift_on_post");
}

#[tokio::test]
async fn moving_a_shift_onto_a_post_is_refused() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;

    let error = refused(
        &mut tx,
        sqlx::query("UPDATE shifts SET location_id = $1 WHERE id = $2")
            .bind(night.bar_manager)
            .bind(shift),
    )
    .await;

    assert_refused(&error, "23514", "shift_on_post");
}

// ---------------------------------------------------------------------------
// An assignment's post is a post of its shift's zone
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_assignment_names_a_post_of_its_shifts_zone() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;

    let (assignment, _operation) = roster(
        &mut tx,
        &night,
        shift,
        participation,
        Some(night.bar_manager),
    )
    .await
    .expect("the bar manager is a role on the bar's shift")
    .expect("the participation exists");

    assert_eq!(assignment.post_id, Some(night.bar_manager));
    let listed = assignments::list(&mut tx, night.org_id, night.event_id)
        .await
        .expect("list the roster");
    assert_eq!(
        listed.iter().map(|row| row.post_id).collect::<Vec<_>>(),
        vec![Some(night.bar_manager)],
        "the roster says who is the bar manager"
    );
}

#[tokio::test]
async fn an_assignment_without_a_post_works_the_zone() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;

    let (assignment, _operation) = roster(&mut tx, &night, shift, participation, None)
        .await
        .expect("a plain bar placement")
        .expect("the participation exists");

    assert_eq!(assignment.post_id, None);
}

#[tokio::test]
async fn an_assignment_naming_another_zones_post_is_refused() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;

    let error = roster(&mut tx, &night, shift, participation, Some(night.cashier))
        .await
        .expect_err("the entrance's cashier is not a role on the bar's shift");

    assert_refused(&error, "23514", "assignment_post_outside_zone");
}

#[tokio::test]
async fn an_assignment_naming_a_zone_as_its_post_is_refused() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;

    let error = roster(&mut tx, &night, shift, participation, Some(night.bar))
        .await
        .expect_err("a zone is not a role within itself");

    assert_refused(&error, "23514", "assignment_post_outside_zone");
}

#[tokio::test]
async fn retagging_an_assignment_with_another_zones_post_is_refused() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;
    let (assignment, _operation) = roster(&mut tx, &night, shift, participation, None)
        .await
        .expect("a plain bar placement")
        .expect("the participation exists");

    let error = refused(
        &mut tx,
        sqlx::query("UPDATE assignments SET post_id = $1 WHERE id = $2")
            .bind(night.cashier)
            .bind(assignment.id),
    )
    .await;

    assert_refused(&error, "23514", "assignment_post_outside_zone");
}

/// The other direction: the post stays put and the shift leaves its zone.
#[tokio::test]
async fn moving_a_shift_with_a_post_holder_to_another_zone_is_refused() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;
    roster(
        &mut tx,
        &night,
        shift,
        participation,
        Some(night.bar_manager),
    )
    .await
    .expect("the bar manager placement")
    .expect("the participation exists");

    let error = refused(
        &mut tx,
        sqlx::query("UPDATE shifts SET location_id = $1 WHERE id = $2")
            .bind(night.entrance)
            .bind(shift),
    )
    .await;

    assert_refused(&error, "23514", "assignment_post_outside_zone");
}

/// The boundary of the rule above: a shift with only role-less people on it
/// moves freely, because nobody on it holds a role the new zone lacks.
#[tokio::test]
async fn moving_a_shift_without_post_holders_to_another_zone_is_accepted() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;
    roster(&mut tx, &night, shift, participation, None)
        .await
        .expect("a plain bar placement")
        .expect("the participation exists");

    sqlx::query("UPDATE shifts SET location_id = $1 WHERE id = $2")
        .bind(night.entrance)
        .bind(shift)
        .execute(&mut *tx)
        .await
        .expect("nothing on this shift is tied to the bar");
}

/// A cancelled placement is history, not a role anyone is holding, so it does
/// not pin the shift to its zone.
#[tokio::test]
async fn a_cancelled_post_holder_does_not_pin_the_shift() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;
    let (assignment, _operation) = roster(
        &mut tx,
        &night,
        shift,
        participation,
        Some(night.bar_manager),
    )
    .await
    .expect("the bar manager placement")
    .expect("the participation exists");
    assignments::cancel(
        &mut tx,
        night.org_id,
        night.event_id,
        night.user_id,
        assignment.id,
        None,
    )
    .await
    .expect("cancel the placement");

    sqlx::query("UPDATE shifts SET location_id = $1 WHERE id = $2")
        .bind(night.entrance)
        .bind(shift)
        .execute(&mut *tx)
        .await
        .expect("a cancelled bar manager holds nothing");
}

#[tokio::test]
async fn deleting_a_post_leaves_its_holder_on_the_zone() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;
    let (assignment, _operation) = roster(
        &mut tx,
        &night,
        shift,
        participation,
        Some(night.bar_manager),
    )
    .await
    .expect("the bar manager placement")
    .expect("the participation exists");

    sqlx::query("DELETE FROM locations WHERE id = $1")
        .bind(night.bar_manager)
        .execute(&mut *tx)
        .await
        .expect("delete the post");

    let after = assignments::get(&mut tx, night.org_id, night.event_id, assignment.id)
        .await
        .expect("read the placement back")
        .expect("the placement survives its post");
    assert_eq!(after.post_id, None);
    assert_eq!(after.shift_id, shift);
    assert_eq!(after.status, "draft");
}

/// HARD RULE `cross_tenant` (docs/02 §5): the post is held to the
/// assignment's organisation by the composite foreign key.
#[tokio::test]
async fn an_assignment_naming_another_orgs_post_is_23503() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let night = seed_night(&mut tx).await;
    let shift = seed_shift(&mut tx, &night, night.bar).await;
    let participation = seed_participation(&mut tx, &night).await;
    let (assignment, _operation) = roster(&mut tx, &night, shift, participation, None)
        .await
        .expect("a plain bar placement")
        .expect("the participation exists");
    let other = seed_night(&mut tx).await;
    act_as(&mut tx, night.org_id).await;

    let error = refused(
        &mut tx,
        sqlx::query("UPDATE assignments SET post_id = $1 WHERE id = $2")
            .bind(other.bar_manager)
            .bind(assignment.id),
    )
    .await;

    assert_refused(&error, "23503", "assignments_post_id_org_id_fkey");
}
