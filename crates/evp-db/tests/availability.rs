// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for `evp_db::availability` (docs/03 §3.5, docs/04
//! §"Participation and availability"): the coordinator's full replace of
//! their own declared windows, and — the product requirement this whole
//! slice exists to protect — that it never touches a submission-derived row.
//!
//! Same connection discipline as `crates/evp-db/tests/submissions.rs`: one
//! transaction per test against `EVP_MIGRATION_DATABASE_URL`, rolled back by
//! never being committed.

use evp_db::DbError;
use evp_db::availability::{self, NewWindow};
use evp_db::catalog;
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

/// One event, one volunteer, one participation on it — the minimum scaffold
/// every test below needs before it can touch `availability_windows`.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_participation(conn: &mut PgConnection, org_id: Uuid, user_id: Uuid) -> (Uuid, Uuid) {
    let (event, _operation) = catalog::create_event(
        conn,
        Uuid::now_v7(),
        org_id,
        user_id,
        None,
        "Open Air",
        &format!("open-air-{}", Uuid::now_v7().simple()),
        "Europe/Paris",
        (at("2026-09-05T00:00:00Z"), at("2026-09-07T00:00:00Z")),
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

    (event.id, participation_id)
}

/// A minimal, real submission — intake source, batch and the submission row
/// itself — so a window can carry a genuine `source_submission_id` rather
/// than a foreign key this test invented. Nothing here is read by the code
/// under test; it exists only to be a valid parent for the window.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_submission(conn: &mut PgConnection, org_id: Uuid, user_id: Uuid) -> Uuid {
    let source_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO intake_sources (id, org_id, kind, name, created_by) \
         VALUES ($1, $2, 'csv_upload', $3, $4)",
    )
    .bind(source_id)
    .bind(org_id)
    .bind(format!("Test source {}", Uuid::now_v7().simple()))
    .bind(user_id)
    .execute(&mut *conn)
    .await
    .expect("insert intake_sources row");

    let batch_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO submission_batches (id, org_id, source_id, trigger, created_by) \
         VALUES ($1, $2, $3, 'upload', $4)",
    )
    .bind(batch_id)
    .bind(org_id)
    .bind(source_id)
    .bind(user_id)
    .execute(&mut *conn)
    .await
    .expect("insert submission_batches row");

    let submission_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO submissions (id, org_id, source_id, batch_id, external_id) \
         VALUES ($1, $2, $3, $4, 'test-external-id')",
    )
    .bind(submission_id)
    .bind(org_id)
    .bind(source_id)
    .bind(batch_id)
    .execute(&mut *conn)
    .await
    .expect("insert submissions row");

    submission_id
}

/// Inserts a submission-derived window directly — the shape the intake
/// pipeline would produce, and the one this whole slice must never touch.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn insert_submitted_window(
    conn: &mut PgConnection,
    org_id: Uuid,
    participation_id: Uuid,
    submission_id: Uuid,
    kind: &str,
    period: (Timestamp, Timestamp),
) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO availability_windows \
           (id, org_id, participation_id, kind, period, source_submission_id) \
         VALUES ($1, $2, $3, $4::availability_kind, tstzrange($5, $6), $7)",
    )
    .bind(id)
    .bind(org_id)
    .bind(participation_id)
    .bind(kind)
    .bind(period.0.to_sqlx())
    .bind(period.1.to_sqlx())
    .bind(submission_id)
    .execute(&mut *conn)
    .await
    .expect("insert a submission-derived window");
    id
}

fn new_window(kind: &str, start: &str, end: &str) -> NewWindow {
    NewWindow {
        kind: kind.to_owned(),
        start: at(start),
        end: at(end),
        note: None,
    }
}

// ---------------------------------------------------------------------------
// replace_declared: the ordinary path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn replace_declared_writes_the_new_set_and_records_an_operation() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, participation_id) = seed_participation(&mut tx, org_id, user_id).await;

    let (created, _operation_id) = availability::replace_declared(
        &mut tx,
        org_id,
        event_id,
        participation_id,
        user_id,
        &[new_window(
            "available",
            "2026-09-05T09:00:00Z",
            "2026-09-05T17:00:00Z",
        )],
    )
    .await
    .expect("the participation exists")
    .expect("replace succeeds");

    assert_eq!(created.len(), 1);
    assert_eq!(created[0].kind, "available");
    assert_eq!(created[0].provenance, "declared");

    let read_back = availability::get(&mut tx, org_id, event_id, participation_id)
        .await
        .expect("get succeeds")
        .expect("the participation exists");
    assert_eq!(read_back.len(), 1);
    assert_eq!(read_back[0].provenance, "declared");
}

/// A second `replace_declared` call replaces the first set rather than adding
/// to it — "full replace", not incremental add/remove (docs/04).
#[tokio::test]
async fn a_second_replace_removes_the_first_declared_set() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, participation_id) = seed_participation(&mut tx, org_id, user_id).await;

    availability::replace_declared(
        &mut tx,
        org_id,
        event_id,
        participation_id,
        user_id,
        &[new_window(
            "available",
            "2026-09-05T09:00:00Z",
            "2026-09-05T17:00:00Z",
        )],
    )
    .await
    .expect("the participation exists")
    .expect("first replace succeeds");

    let (created, _operation_id) = availability::replace_declared(
        &mut tx,
        org_id,
        event_id,
        participation_id,
        user_id,
        &[new_window(
            "unavailable",
            "2026-09-06T09:00:00Z",
            "2026-09-06T12:00:00Z",
        )],
    )
    .await
    .expect("the participation exists")
    .expect("second replace succeeds");

    assert_eq!(created.len(), 1);
    assert_eq!(created[0].kind, "unavailable");

    let read_back = availability::get(&mut tx, org_id, event_id, participation_id)
        .await
        .expect("get succeeds")
        .expect("the participation exists");
    assert_eq!(
        read_back.len(),
        1,
        "the first declared window must be gone, not kept alongside the second"
    );
}

/// An empty `windows` clears every declared window and leaves none behind —
/// still a valid "full replace", of the empty set.
#[tokio::test]
async fn replacing_with_an_empty_list_clears_declared_windows() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, participation_id) = seed_participation(&mut tx, org_id, user_id).await;

    availability::replace_declared(
        &mut tx,
        org_id,
        event_id,
        participation_id,
        user_id,
        &[new_window(
            "available",
            "2026-09-05T09:00:00Z",
            "2026-09-05T17:00:00Z",
        )],
    )
    .await
    .expect("the participation exists")
    .expect("first replace succeeds");

    let (created, _operation_id) =
        availability::replace_declared(&mut tx, org_id, event_id, participation_id, user_id, &[])
            .await
            .expect("the participation exists")
            .expect("clearing replace succeeds");
    assert!(created.is_empty());

    let read_back = availability::get(&mut tx, org_id, event_id, participation_id)
        .await
        .expect("get succeeds")
        .expect("the participation exists");
    assert!(read_back.is_empty());
}

/// `Ok(None)`, not an error, for a participation that does not belong to this
/// org+event — the same "wrong id and someone else's id look alike" contract
/// [`evp_db::shifts::location_belongs_to`] documents.
#[tokio::test]
async fn a_participation_of_another_event_is_not_found() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (_event_id, participation_id) = seed_participation(&mut tx, org_id, user_id).await;
    let (other_event_id, _other_participation) = seed_participation(&mut tx, org_id, user_id).await;

    let get_result = availability::get(&mut tx, org_id, other_event_id, participation_id)
        .await
        .expect("get succeeds");
    assert!(get_result.is_none());

    let replace_result = availability::replace_declared(
        &mut tx,
        org_id,
        other_event_id,
        participation_id,
        user_id,
        &[new_window(
            "available",
            "2026-09-05T09:00:00Z",
            "2026-09-05T17:00:00Z",
        )],
    )
    .await
    .expect("replace_declared succeeds");
    assert!(replace_result.is_none());
}

// ---------------------------------------------------------------------------
// The product requirement: submission-derived rows are never touched
// ---------------------------------------------------------------------------

/// The critical regression test: a coordinator replacing their own declared
/// windows must leave a volunteer's submitted window completely untouched —
/// same id, same kind, same period, still carrying its `source_submission_id`
/// — regardless of how many times the coordinator edits.
#[tokio::test]
async fn replace_declared_leaves_submission_derived_windows_untouched() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, participation_id) = seed_participation(&mut tx, org_id, user_id).await;
    let submission_id = seed_submission(&mut tx, org_id, user_id).await;

    let submitted_id = insert_submitted_window(
        &mut tx,
        org_id,
        participation_id,
        submission_id,
        "available",
        (at("2026-09-05T08:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;

    // The coordinator overrides part of it by phone: unavailable in the
    // afternoon. This overlaps the submitted window in time, which the
    // provenance-scoped exclusion constraint must allow (migration
    // `20260918141853_availability_windows_provenance_exclusion`).
    let (created, _operation_id) = availability::replace_declared(
        &mut tx,
        org_id,
        event_id,
        participation_id,
        user_id,
        &[new_window(
            "unavailable",
            "2026-09-05T14:00:00Z",
            "2026-09-05T18:00:00Z",
        )],
    )
    .await
    .expect("the participation exists")
    .expect("a declared window overlapping a submitted one is accepted");
    assert_eq!(created.len(), 1);

    let read_back = availability::get(&mut tx, org_id, event_id, participation_id)
        .await
        .expect("get succeeds")
        .expect("the participation exists");
    assert_eq!(read_back.len(), 2, "both provenances must be present");

    let submitted = read_back
        .iter()
        .find(|window| window.id == submitted_id)
        .expect("the submitted window must survive, with the same id");
    assert_eq!(submitted.provenance, "submitted");
    assert_eq!(submitted.kind, "available");
    assert_eq!(submitted.start, at("2026-09-05T08:00:00Z"));
    assert_eq!(submitted.end, at("2026-09-05T20:00:00Z"));

    let declared = read_back
        .iter()
        .find(|window| window.id != submitted_id)
        .expect("the declared window is the other one");
    assert_eq!(declared.provenance, "declared");
    assert_eq!(declared.kind, "unavailable");

    // A second, unrelated replace — even one that clears every declared
    // window — must still leave the submission untouched.
    availability::replace_declared(&mut tx, org_id, event_id, participation_id, user_id, &[])
        .await
        .expect("the participation exists")
        .expect("clearing replace succeeds");

    let read_back = availability::get(&mut tx, org_id, event_id, participation_id)
        .await
        .expect("get succeeds")
        .expect("the participation exists");
    assert_eq!(
        read_back.len(),
        1,
        "only the submitted window remains once every declared window is cleared"
    );
    assert_eq!(read_back[0].id, submitted_id);
    assert_eq!(read_back[0].provenance, "submitted");
}

// ---------------------------------------------------------------------------
// Hard constraints, each attempted and its SQLSTATE asserted (docs/13 §2)
// ---------------------------------------------------------------------------

/// Two declared windows in the same request that overlap must be refused —
/// the exclusion constraint fires on the second `INSERT` within this same
/// transaction, before the caller's own request even completes.
#[tokio::test]
async fn two_overlapping_declared_windows_in_one_request_is_23p01() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, participation_id) = seed_participation(&mut tx, org_id, user_id).await;

    let error = availability::replace_declared(
        &mut tx,
        org_id,
        event_id,
        participation_id,
        user_id,
        &[
            new_window("available", "2026-09-05T09:00:00Z", "2026-09-05T17:00:00Z"),
            new_window(
                "unavailable",
                "2026-09-05T12:00:00Z",
                "2026-09-05T14:00:00Z",
            ),
        ],
    )
    .await
    .expect_err("two overlapping declared windows in one request must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23P01"),
        "expected exclusion_violation, got {error:?}"
    );
}

/// The other side of the same constraint: two *submitted* windows overlapping
/// are refused too — provenance-scoping only relaxed cross-provenance
/// overlap, not overlap within one provenance.
#[tokio::test]
async fn two_overlapping_submitted_windows_is_23p01() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (_event_id, participation_id) = seed_participation(&mut tx, org_id, user_id).await;
    let submission_id = seed_submission(&mut tx, org_id, user_id).await;

    insert_submitted_window(
        &mut tx,
        org_id,
        participation_id,
        submission_id,
        "available",
        (at("2026-09-05T08:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;

    let error = sqlx::query(
        "INSERT INTO availability_windows \
           (id, org_id, participation_id, kind, period, source_submission_id) \
         VALUES ($1, $2, $3, 'unavailable', tstzrange($4, $5), $6)",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(participation_id)
    .bind(at("2026-09-05T10:00:00Z").to_sqlx())
    .bind(at("2026-09-05T12:00:00Z").to_sqlx())
    .bind(submission_id)
    .execute(&mut *tx)
    .await
    .expect_err("two overlapping submitted windows on the same participation must be refused");

    let db_error = DbError::Query(error);
    assert_eq!(
        db_error.sqlstate().as_deref(),
        Some("23P01"),
        "expected exclusion_violation, got {db_error:?}"
    );
}

/// The whole point of the provenance-scoped constraint: a declared window MAY
/// overlap a submitted one — that is the override, not a contradiction.
/// Already exercised as a side effect of
/// `replace_declared_leaves_submission_derived_windows_untouched`; kept here
/// too, phrased as the constraint boundary it is, so a reader of the hard
/// constraints in this file sees the accepted case beside the two refused
/// ones above rather than having to infer it from a differently named test.
#[tokio::test]
async fn a_declared_window_may_overlap_a_submitted_one() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (event_id, participation_id) = seed_participation(&mut tx, org_id, user_id).await;
    let submission_id = seed_submission(&mut tx, org_id, user_id).await;

    insert_submitted_window(
        &mut tx,
        org_id,
        participation_id,
        submission_id,
        "available",
        (at("2026-09-05T08:00:00Z"), at("2026-09-05T20:00:00Z")),
    )
    .await;

    availability::replace_declared(
        &mut tx,
        org_id,
        event_id,
        participation_id,
        user_id,
        &[new_window(
            "unavailable",
            "2026-09-05T14:00:00Z",
            "2026-09-05T18:00:00Z",
        )],
    )
    .await
    .expect("the participation exists")
    .expect("a declared window overlapping a submitted one is accepted");
}
