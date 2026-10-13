// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `.../participations/{id}/availability` through the real router (docs/04
//! §"Participation and availability").
//!
//! What the database refuses is proved in
//! `crates/evp-db/tests/availability.rs`, including the critical regression
//! case: a coordinator's replace must never touch a submission-derived
//! window. What is proved here is this crate's half — that the write is
//! `Coordinator`-gated while the read is open to any member, that a `422`
//! rather than a `500` comes back for an in-request overlap, that a window
//! overlapping a submission's is accepted (the exclusion constraint's
//! provenance scoping, migration
//! `20260918141853_availability_windows_provenance_exclusion`), and that
//! `operation_id` is always returned (ADR-0024).

mod support;

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{Call, add_member, create_event_body, pool, router, seed_member};
use uuid::Uuid;

/// A coordinator-created event, through the real router.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed_event(router: &axum::Router, org_id: Uuid, cookie: &str) -> String {
    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(cookie)
        .body(create_event_body("Availability Event"))
        .send(router)
        .await;
    assert_eq!(event.status, StatusCode::CREATED, "{:?}", event.body);
    event
        .body
        .pointer("/event/id")
        .and_then(Value::as_str)
        .expect("a created event carries a string id")
        .to_owned()
}

/// A volunteer enrolled on `event_id`, inserted directly — enrolling is a
/// documented write `evp-api` does not serve yet (`evp_api::participations`),
/// same reasoning as `crates/evp-api/tests/assignments.rs`'s fixture of the
/// same name.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed_participation(pool: &PgPool, org_id: Uuid, event_id: &str) -> String {
    let event_id: Uuid = event_id.parse().expect("the API answered with a UUID");
    let volunteer_id = Uuid::now_v7();
    let participation_id = Uuid::now_v7();

    let mut tx = pool.begin().await.expect("begin fixture transaction");
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("set app.current_org_id");
    sqlx::query("INSERT INTO volunteers (id, org_id, display_name) VALUES ($1, $2, 'Camille')")
        .bind(volunteer_id)
        .bind(org_id)
        .execute(&mut *tx)
        .await
        .expect("insert volunteers row");
    sqlx::query(
        "INSERT INTO participations (id, org_id, event_id, volunteer_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(participation_id)
    .bind(org_id)
    .bind(event_id)
    .bind(volunteer_id)
    .execute(&mut *tx)
    .await
    .expect("insert participations row");
    tx.commit().await.expect("commit fixture transaction");

    participation_id.to_string()
}

/// A minimal, real submission and one submission-derived window on
/// `participation_id`, inserted directly — the shape the intake pipeline
/// would produce, and the one `PUT .../availability` must never touch.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed_submitted_window(
    pool: &PgPool,
    org_id: Uuid,
    participation_id: &str,
    start: &str,
    end: &str,
) -> String {
    let participation_id: Uuid = participation_id.parse().expect("valid UUID");
    let user_id = Uuid::now_v7();
    let source_id = Uuid::now_v7();
    let batch_id = Uuid::now_v7();
    let window_id = Uuid::now_v7();

    let mut tx = pool.begin().await.expect("begin fixture transaction");
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("set app.current_org_id");
    sqlx::query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, 'Intake Actor')",
    )
    .bind(user_id)
    .bind(format!("{}@example.test", Uuid::now_v7().simple()))
    .execute(&mut *tx)
    .await
    .expect("insert users row");
    sqlx::query(
        "INSERT INTO intake_sources (id, org_id, kind, name, created_by) \
         VALUES ($1, $2, 'csv_upload', $3, $4)",
    )
    .bind(source_id)
    .bind(org_id)
    .bind(format!("Test source {}", Uuid::now_v7().simple()))
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .expect("insert intake_sources row");
    sqlx::query(
        "INSERT INTO submission_batches (id, org_id, source_id, trigger, created_by) \
         VALUES ($1, $2, $3, 'upload', $4)",
    )
    .bind(batch_id)
    .bind(org_id)
    .bind(source_id)
    .bind(user_id)
    .execute(&mut *tx)
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
    .execute(&mut *tx)
    .await
    .expect("insert submissions row");
    sqlx::query(
        "INSERT INTO availability_windows \
           (id, org_id, participation_id, kind, period, source_submission_id) \
         VALUES ($1, $2, $3, 'available', tstzrange($4::timestamptz, $5::timestamptz), $6)",
    )
    .bind(window_id)
    .bind(org_id)
    .bind(participation_id)
    .bind(start)
    .bind(end)
    .bind(submission_id)
    .execute(&mut *tx)
    .await
    .expect("insert a submission-derived window");
    tx.commit().await.expect("commit fixture transaction");

    window_id.to_string()
}

fn availability_path(org_id: Uuid, event_id: &str, participation_id: &str) -> String {
    format!(
        "/api/v1/orgs/{org_id}/events/{event_id}/participations/{participation_id}/availability"
    )
}

#[tokio::test]
async fn a_coordinator_replaces_availability_and_reads_it_back() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let participation_id = seed_participation(&pool, org_id, &event_id).await;
    let path = availability_path(org_id, &event_id, &participation_id);

    let written = Call::new("PUT", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "windows": [
                {
                    "kind": "available",
                    "start": "2026-07-04T09:00:00Z",
                    "end": "2026-07-04T17:00:00Z",
                    "note": "mornings only after the 5th"
                }
            ]
        }))
        .send(&router)
        .await;
    assert_eq!(written.status, StatusCode::OK, "{:?}", written.body);
    assert!(
        written.body["operation_id"].is_string(),
        "every mutating request returns an operation id (ADR-0024): {:?}",
        written.body
    );
    let windows = written.body["windows"].as_array().expect("windows array");
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["kind"], "available");
    assert_eq!(windows[0]["provenance"], "declared");
    assert_eq!(windows[0]["note"], json!("mornings only after the 5th"));

    let read = Call::new("GET", &path)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);
    let windows = read.body["windows"].as_array().expect("windows array");
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["provenance"], "declared");
}

#[tokio::test]
async fn a_second_replace_removes_the_first_declared_set() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let participation_id = seed_participation(&pool, org_id, &event_id).await;
    let path = availability_path(org_id, &event_id, &participation_id);

    Call::new("PUT", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "windows": [
                { "kind": "available", "start": "2026-07-04T09:00:00Z", "end": "2026-07-04T17:00:00Z" }
            ]
        }))
        .send(&router)
        .await;

    let second = Call::new("PUT", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "windows": [
                { "kind": "unavailable", "start": "2026-07-05T09:00:00Z", "end": "2026-07-05T12:00:00Z" }
            ]
        }))
        .send(&router)
        .await;
    assert_eq!(second.status, StatusCode::OK, "{:?}", second.body);

    let read = Call::new("GET", &path)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    let windows = read.body["windows"].as_array().expect("windows array");
    assert_eq!(
        windows.len(),
        1,
        "the second replace must remove the first declared window, not add to it"
    );
    assert_eq!(windows[0]["kind"], "unavailable");
}

/// The critical regression test: a coordinator's replace must never delete,
/// mutate or hide a volunteer's submitted window, even when the coordinator's
/// new declared window overlaps it in time — that overlap is the override the
/// provenance-scoped exclusion constraint exists to allow.
#[tokio::test]
async fn replacing_declared_windows_leaves_a_submitted_window_untouched() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let participation_id = seed_participation(&pool, org_id, &event_id).await;
    let submitted_window_id = seed_submitted_window(
        &pool,
        org_id,
        &participation_id,
        "2026-07-04T08:00:00Z",
        "2026-07-04T20:00:00Z",
    )
    .await;
    let path = availability_path(org_id, &event_id, &participation_id);

    // Overlaps the submitted window in time: the coordinator overriding part
    // of what the volunteer submitted.
    let written = Call::new("PUT", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "windows": [
                { "kind": "unavailable", "start": "2026-07-04T14:00:00Z", "end": "2026-07-04T18:00:00Z" }
            ]
        }))
        .send(&router)
        .await;
    assert_eq!(
        written.status,
        StatusCode::OK,
        "a declared window overlapping a submitted one must be accepted: {:?}",
        written.body
    );

    let read = Call::new("GET", &path)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);
    let windows = read.body["windows"].as_array().expect("windows array");
    assert_eq!(windows.len(), 2, "both provenances must be present");

    let submitted = windows
        .iter()
        .find(|window| window["id"] == json!(submitted_window_id))
        .expect("the submitted window must survive, with the same id");
    assert_eq!(submitted["provenance"], "submitted");
    assert_eq!(submitted["kind"], "available");
    assert_eq!(submitted["period"]["start"], "2026-07-04T08:00:00Z");
    assert_eq!(submitted["period"]["end"], "2026-07-04T20:00:00Z");

    let declared = windows
        .iter()
        .find(|window| window["id"] != json!(submitted_window_id))
        .expect("the declared window is the other one");
    assert_eq!(declared["provenance"], "declared");
    assert_eq!(declared["kind"], "unavailable");

    // Clearing every declared window entirely must still leave the
    // submission there.
    let cleared = Call::new("PUT", &path)
        .signed_in_as(&cookie)
        .body(json!({ "windows": [] }))
        .send(&router)
        .await;
    assert_eq!(cleared.status, StatusCode::OK, "{:?}", cleared.body);

    let read = Call::new("GET", &path)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    let windows = read.body["windows"].as_array().expect("windows array");
    assert_eq!(
        windows.len(),
        1,
        "only the submitted window remains once every declared window is cleared"
    );
    assert_eq!(windows[0]["id"], json!(submitted_window_id));
}

#[tokio::test]
async fn two_overlapping_windows_in_one_request_are_refused_with_a_422() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let participation_id = seed_participation(&pool, org_id, &event_id).await;
    let path = availability_path(org_id, &event_id, &participation_id);

    let written = Call::new("PUT", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "windows": [
                { "kind": "available", "start": "2026-07-04T09:00:00Z", "end": "2026-07-04T17:00:00Z" },
                { "kind": "unavailable", "start": "2026-07-04T12:00:00Z", "end": "2026-07-04T14:00:00Z" }
            ]
        }))
        .send(&router)
        .await;
    assert_eq!(
        written.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        written.body
    );
}

#[tokio::test]
async fn a_zone_lead_may_read_availability_but_not_replace_it() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, coordinator_cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &coordinator_cookie).await;
    let participation_id = seed_participation(&pool, org_id, &event_id).await;
    let path = availability_path(org_id, &event_id, &participation_id);

    let zone_lead_cookie = add_member(&pool, org_id, "zone_lead").await;

    let read = Call::new("GET", &path)
        .signed_in_as(&zone_lead_cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);

    let write = Call::new("PUT", &path)
        .signed_in_as(&zone_lead_cookie)
        .body(json!({
            "windows": [
                { "kind": "available", "start": "2026-07-04T09:00:00Z", "end": "2026-07-04T17:00:00Z" }
            ]
        }))
        .send(&router)
        .await;
    assert_eq!(write.status, StatusCode::FORBIDDEN, "{:?}", write.body);
    assert_eq!(write.body["type"], "https://evp.example/errors/forbidden");
}

#[tokio::test]
async fn a_participation_of_another_event_is_not_found() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let other_event_id = seed_event(&router, org_id, &cookie).await;
    let participation_id = seed_participation(&pool, org_id, &event_id).await;

    let path = availability_path(org_id, &other_event_id, &participation_id);
    let read = Call::new("GET", &path)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::NOT_FOUND, "{:?}", read.body);

    let write = Call::new("PUT", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "windows": [
                { "kind": "available", "start": "2026-07-04T09:00:00Z", "end": "2026-07-04T17:00:00Z" }
            ]
        }))
        .send(&router)
        .await;
    assert_eq!(write.status, StatusCode::NOT_FOUND, "{:?}", write.body);
}
