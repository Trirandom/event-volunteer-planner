// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/events/{event}/assignments` and `/events/{event}/participations` — the
//! roster, through the real router (docs/04 §"Assignments").
//!
//! What the database refuses is proved in `crates/evp-db/tests/assignments.rs`,
//! which attempts each hard rule and asserts its SQLSTATE. What is proved here
//! is the half that is this crate's: that those refusals arrive as a `422` a
//! coordinator can act on rather than a `500`, that a zone lead can read the
//! roster and not write it, and that a cancellation frees the slot.
//!
//! Volunteers and participations are inserted with SQL rather than through an
//! endpoint because there is no endpoint: enrolling is a documented write that
//! nothing in this slice performs (`evp_api::participations`). The insert runs
//! with the same three GUCs `evp-api::org` sets, so RLS applies to the fixture
//! exactly as it does to the requests under test.

mod support;

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{Call, add_member, create_event_body, pool, router, seed_member};
use uuid::Uuid;

/// An event, a post, and one shift on it running 18:00–20:00.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed_shift(
    router: &axum::Router,
    org_id: Uuid,
    cookie: &str,
    start: &str,
    end: &str,
) -> (String, String) {
    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(cookie)
        .body(create_event_body("Roster Event"))
        .send(router)
        .await;
    assert_eq!(event.status, StatusCode::CREATED, "{:?}", event.body);
    let event_id = event
        .body
        .pointer("/event/id")
        .and_then(Value::as_str)
        .expect("a created event carries a string id")
        .to_owned();

    let zone = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/locations"),
    )
    .signed_in_as(cookie)
    .body(json!({ "kind": "zone", "name": "Bar" }))
    .send(router)
    .await;
    let zone_id = zone
        .body
        .pointer("/location/id")
        .and_then(Value::as_str)
        .expect("a created zone carries a string id")
        .to_owned();

    let shift = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(cookie)
    .body(json!({
        "location_id": zone_id,
        "period": { "start": start, "end": end },
        "required_count": 2
    }))
    .send(router)
    .await;
    assert_eq!(shift.status, StatusCode::CREATED, "{:?}", shift.body);
    let shift_id = shift
        .body
        .pointer("/shift/id")
        .and_then(Value::as_str)
        .expect("a created shift carries a string id")
        .to_owned();

    (event_id, shift_id)
}

/// One more shift on the same event, at its own hours.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn add_shift(
    router: &axum::Router,
    org_id: Uuid,
    cookie: &str,
    event_id: &str,
    start: &str,
    end: &str,
) -> String {
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");
    let zone = Call::new("POST", &base)
        .signed_in_as(cookie)
        .body(json!({ "kind": "zone", "name": format!("Post {}", Uuid::now_v7().simple()) }))
        .send(router)
        .await;
    let zone_id = zone
        .body
        .pointer("/location/id")
        .and_then(Value::as_str)
        .expect("a created zone carries a string id")
        .to_owned();

    let shift = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(cookie)
    .body(json!({
        "location_id": zone_id,
        "period": { "start": start, "end": end },
    }))
    .send(router)
    .await;
    assert_eq!(shift.status, StatusCode::CREATED, "{:?}", shift.body);
    shift
        .body
        .pointer("/shift/id")
        .and_then(Value::as_str)
        .expect("a created shift carries a string id")
        .to_owned()
}

/// A volunteer enrolled on `event_id`, inserted directly. Returns the
/// participation id, which is what the POST body names.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed_participation(pool: &PgPool, org_id: Uuid, event_id: &str, name: &str) -> String {
    let event_id: Uuid = event_id.parse().expect("the API answered with a UUID");
    let volunteer_id = Uuid::now_v7();
    let participation_id = Uuid::now_v7();

    let mut tx = pool.begin().await.expect("begin fixture transaction");
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("set app.current_org_id");
    sqlx::query("INSERT INTO volunteers (id, org_id, display_name) VALUES ($1, $2, $3)")
        .bind(volunteer_id)
        .bind(org_id)
        .bind(name)
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

fn assignments_path(org_id: Uuid, event_id: &str) -> String {
    format!("/api/v1/orgs/{org_id}/events/{event_id}/assignments")
}

#[tokio::test]
async fn a_volunteer_is_rostered_and_appears_on_the_roster() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, shift_id) = seed_shift(
        &router,
        org_id,
        &cookie,
        "2026-07-04T18:00:00Z",
        "2026-07-04T20:00:00Z",
    )
    .await;
    let participation_id = seed_participation(&pool, org_id, &event_id, "Camille").await;
    let base = assignments_path(org_id, &event_id);

    let created = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "shift_id": shift_id, "participation_id": participation_id }))
        .send(&router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    assert_eq!(created.body["assignment"]["shift_id"], json!(shift_id));
    assert_eq!(created.body["assignment"]["status"], "draft");
    assert!(
        created.body["operation_id"].is_string(),
        "every mutating request returns an operation id (ADR-0024): {:?}",
        created.body
    );
    // The period is the shift's, taken from the shift rather than from the
    // request — which is what the exclusion constraint compares.
    assert_eq!(
        created.body.pointer("/assignment/period/start"),
        Some(&json!("2026-07-04T18:00:00Z"))
    );

    let listed = Call::new("GET", &base)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{:?}", listed.body);
    assert_eq!(listed.body["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        listed.body.pointer("/data/0/participation_id"),
        Some(&json!(participation_id))
    );

    // And the person is on the event's roster with the name a coordinator
    // typed, which is what the board's dropdown reads.
    let people = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/participations"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert_eq!(people.status, StatusCode::OK, "{:?}", people.body);
    assert_eq!(
        people.body.pointer("/data/0/display_name"),
        Some(&json!("Camille"))
    );
    assert_eq!(
        people.body.pointer("/data/0/status"),
        Some(&json!("invited"))
    );
    let listed_id = people
        .body
        .pointer("/data/0/id")
        .and_then(Value::as_str)
        .expect("a participation carries a string id");
    assert_eq!(listed_id, participation_id);
}

/// One of the six hard rules: nobody is in two places at once (docs/02 §5).
/// Enforced by the `assignments_no_double_booking` exclusion constraint, and
/// what is asserted here is that it surfaces as a `422` naming the remedy.
#[tokio::test]
async fn a_double_booking_is_refused_with_a_remedy() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, bar_shift) = seed_shift(
        &router,
        org_id,
        &cookie,
        "2026-07-04T18:00:00Z",
        "2026-07-04T22:00:00Z",
    )
    .await;
    let door_shift = add_shift(
        &router,
        org_id,
        &cookie,
        &event_id,
        "2026-07-04T20:00:00Z",
        "2026-07-05T00:00:00Z",
    )
    .await;
    let participation_id = seed_participation(&pool, org_id, &event_id, "Aurel").await;
    let base = assignments_path(org_id, &event_id);

    let first = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "shift_id": bar_shift, "participation_id": participation_id }))
        .send(&router)
        .await;
    assert_eq!(first.status, StatusCode::CREATED, "{:?}", first.body);

    let clash = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "shift_id": door_shift, "participation_id": participation_id }))
        .send(&router)
        .await;
    assert_eq!(
        clash.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "an overlapping placement must be a 422, not a 500: {:?}",
        clash.body
    );
    assert_eq!(
        clash.body["type"],
        "https://evp.example/errors/validation-failed"
    );
    assert!(
        clash.body["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("already working")),
        "the refusal has to say what is wrong: {:?}",
        clash.body
    );
}

/// The same rule's other face: the same volunteer twice on one shift. It trips
/// the same constraint (the hours are identical), and the point of the test is
/// that the endpoint refuses it rather than quietly rostering somebody twice.
#[tokio::test]
async fn the_same_volunteer_twice_on_one_shift_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, shift_id) = seed_shift(
        &router,
        org_id,
        &cookie,
        "2026-07-04T18:00:00Z",
        "2026-07-04T20:00:00Z",
    )
    .await;
    let participation_id = seed_participation(&pool, org_id, &event_id, "Moustache").await;
    let base = assignments_path(org_id, &event_id);
    let body = json!({ "shift_id": shift_id, "participation_id": participation_id });

    let first = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(body.clone())
        .send(&router)
        .await;
    assert_eq!(first.status, StatusCode::CREATED, "{:?}", first.body);

    let again = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(body)
        .send(&router)
        .await;
    assert_eq!(
        again.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        again.body
    );
}

/// Cancelling is what frees the slot, and it needs `If-Match` like every other
/// write on a versioned row (docs/02 §7).
#[tokio::test]
async fn cancelling_frees_the_slot() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, shift_id) = seed_shift(
        &router,
        org_id,
        &cookie,
        "2026-07-04T18:00:00Z",
        "2026-07-04T20:00:00Z",
    )
    .await;
    let participation_id = seed_participation(&pool, org_id, &event_id, "Soline").await;
    let base = assignments_path(org_id, &event_id);
    let body = json!({ "shift_id": shift_id, "participation_id": participation_id });

    let created = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(body.clone())
        .send(&router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    let etag = created.etag();
    let assignment_id = created
        .body
        .pointer("/assignment/id")
        .and_then(Value::as_str)
        .expect("a created assignment carries a string id")
        .to_owned();

    let without_precondition = Call::new("DELETE", format!("{base}/{assignment_id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(
        without_precondition.status,
        StatusCode::PRECONDITION_REQUIRED,
        "a write with no If-Match is refused outright (docs/04 §1): {:?}",
        without_precondition.body
    );

    let cancelled = Call::new("DELETE", format!("{base}/{assignment_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .send(&router)
        .await;
    assert_eq!(cancelled.status, StatusCode::NO_CONTENT);

    let listed = Call::new("GET", &base)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(
        listed.body["data"].as_array().map(Vec::len),
        Some(0),
        "a cancelled placement leaves the live roster: {:?}",
        listed.body
    );

    // And the slot is free: the same person goes back on the same shift.
    let again = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(body)
        .send(&router)
        .await;
    assert_eq!(again.status, StatusCode::CREATED, "{:?}", again.body);
}

/// A shift of another event is refused before anything is written, because the
/// row's `event_id` comes from the shift and would otherwise be filed under a
/// day the URL did not name.
#[tokio::test]
async fn a_shift_of_another_event_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, _shift_id) = seed_shift(
        &router,
        org_id,
        &cookie,
        "2026-07-04T18:00:00Z",
        "2026-07-04T20:00:00Z",
    )
    .await;
    let (other_event, other_shift) = seed_shift(
        &router,
        org_id,
        &cookie,
        "2026-07-05T18:00:00Z",
        "2026-07-05T20:00:00Z",
    )
    .await;
    let participation_id = seed_participation(&pool, org_id, &event_id, "Nolo").await;
    assert_ne!(event_id, other_event);

    let refused = Call::new("POST", assignments_path(org_id, &event_id))
        .signed_in_as(&cookie)
        .body(json!({ "shift_id": other_shift, "participation_id": participation_id }))
        .send(&router)
        .await;
    assert_eq!(
        refused.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        refused.body
    );
}

/// docs/04 §4: reading is open to every member, writing is not. A zone lead
/// reads the roster of the zone they run and does not staff it.
#[tokio::test]
async fn a_zone_lead_reads_the_roster_but_cannot_write_it() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, shift_id) = seed_shift(
        &router,
        org_id,
        &cookie,
        "2026-07-04T18:00:00Z",
        "2026-07-04T20:00:00Z",
    )
    .await;
    let participation_id = seed_participation(&pool, org_id, &event_id, "Jo").await;
    let lead = add_member(&pool, org_id, "zone_lead").await;
    let base = assignments_path(org_id, &event_id);

    let listed = Call::new("GET", &base)
        .signed_in_as(&lead)
        .send(&router)
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{:?}", listed.body);

    let people = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/participations"),
    )
    .signed_in_as(&lead)
    .send(&router)
    .await;
    assert_eq!(people.status, StatusCode::OK, "{:?}", people.body);

    let refused = Call::new("POST", &base)
        .signed_in_as(&lead)
        .body(json!({ "shift_id": shift_id, "participation_id": participation_id }))
        .send(&router)
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{:?}", refused.body);
    assert_eq!(refused.body["type"], "https://evp.example/errors/forbidden");
}

/// A member of another organisation gets the same `404` a mistyped id does —
/// never a `403`, which would confirm the event exists (docs/04 §2).
#[tokio::test]
async fn another_orgs_member_cannot_read_this_roster() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, _shift_id) = seed_shift(
        &router,
        org_id,
        &cookie,
        "2026-07-04T18:00:00Z",
        "2026-07-04T20:00:00Z",
    )
    .await;
    let (other_org, other_cookie) = seed_member(&pool, "owner").await;

    let refused = Call::new("GET", assignments_path(other_org, &event_id))
        .signed_in_as(&other_cookie)
        .send(&router)
        .await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND, "{:?}", refused.body);
}
