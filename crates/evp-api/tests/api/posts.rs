// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! A post is a role within its zone's shifts (ADR-0052), through the real
//! router.
//!
//! The two rules are proved in `crates/evp-db/tests/db/posts.rs`, which attempts
//! each and asserts its SQLSTATE. What is proved here is this crate's half:
//! an assignment carries `post_id` in and out, and both refusals arrive as a
//! `422` that says what to do instead of a `500`.

use crate::support::{Call, create_event_body, pool, router, seed_member};
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
fn id_at(body: &Value, pointer: &str) -> String {
    body.pointer(pointer)
        .and_then(Value::as_str)
        .expect("the API answered with a string id")
        .to_owned()
}

struct Night {
    event_id: String,
    /// On the Bar zone, 18:00–20:00.
    shift_id: String,
    bar_manager: String,
    /// A post of the Entrance zone, not the bar's.
    cashier: String,
}

async fn location(
    router: &axum::Router,
    org_id: Uuid,
    cookie: &str,
    event_id: &str,
    body: Value,
) -> String {
    let created = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/locations"),
    )
    .signed_in_as(cookie)
    .body(body)
    .send(router)
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    id_at(&created.body, "/location/id")
}

async fn seed_night(router: &axum::Router, org_id: Uuid, cookie: &str) -> Night {
    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(cookie)
        .body(create_event_body("Post Night"))
        .send(router)
        .await;
    assert_eq!(event.status, StatusCode::CREATED, "{:?}", event.body);
    let event_id = id_at(&event.body, "/event/id");

    let bar = location(
        router,
        org_id,
        cookie,
        &event_id,
        json!({ "kind": "zone", "name": "Bar" }),
    )
    .await;
    let bar_manager = location(
        router,
        org_id,
        cookie,
        &event_id,
        json!({ "kind": "post", "name": "Bar manager", "parent_id": bar }),
    )
    .await;
    let entrance = location(
        router,
        org_id,
        cookie,
        &event_id,
        json!({ "kind": "zone", "name": "Entrance" }),
    )
    .await;
    let cashier = location(
        router,
        org_id,
        cookie,
        &event_id,
        json!({ "kind": "post", "name": "Cashier", "parent_id": entrance }),
    )
    .await;

    let shift = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(cookie)
    .body(json!({
        "location_id": bar,
        "period": { "start": "2026-07-04T18:00:00Z", "end": "2026-07-04T20:00:00Z" },
    }))
    .send(router)
    .await;
    assert_eq!(shift.status, StatusCode::CREATED, "{:?}", shift.body);

    Night {
        event_id,
        shift_id: id_at(&shift.body, "/shift/id"),
        bar_manager,
        cashier,
    }
}

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
    sqlx::query("INSERT INTO volunteers (id, org_id, display_name) VALUES ($1, $2, 'Alex')")
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

fn assert_refused_saying(response: &crate::support::Answer, words: &str) {
    assert_eq!(
        response.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        response.body
    );
    assert!(
        response
            .body
            .pointer("/detail")
            .and_then(Value::as_str)
            .is_some_and(|detail| detail.contains(words)),
        "the refusal has to say what is wrong ({words:?}): {:?}",
        response.body
    );
}

#[tokio::test]
async fn a_volunteer_is_rostered_into_a_post_of_the_shifts_zone() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let night = seed_night(&router, org_id, &cookie).await;
    let participation_id = seed_participation(&pool, org_id, &night.event_id).await;
    let base = format!(
        "/api/v1/orgs/{org_id}/events/{}/assignments",
        night.event_id
    );

    let created = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({
            "shift_id": night.shift_id,
            "participation_id": participation_id,
            "post_id": night.bar_manager,
        }))
        .send(&router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    assert_eq!(
        created.body.pointer("/assignment/post_id"),
        Some(&json!(night.bar_manager))
    );

    let listed = Call::new("GET", &base)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(
        listed.body.pointer("/data/0/post_id"),
        Some(&json!(night.bar_manager)),
        "{:?}",
        listed.body
    );
}

/// Omitted is the ordinary case, and it reads back as an explicit `null`
/// rather than a missing key, so a client never has to guess which it got.
#[tokio::test]
async fn an_assignment_without_a_post_reads_back_as_null() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let night = seed_night(&router, org_id, &cookie).await;
    let participation_id = seed_participation(&pool, org_id, &night.event_id).await;

    let created = Call::new(
        "POST",
        format!(
            "/api/v1/orgs/{org_id}/events/{}/assignments",
            night.event_id
        ),
    )
    .signed_in_as(&cookie)
    .body(json!({ "shift_id": night.shift_id, "participation_id": participation_id }))
    .send(&router)
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    assert_eq!(
        created.body.pointer("/assignment/post_id"),
        Some(&Value::Null)
    );
}

#[tokio::test]
async fn a_post_of_another_zone_is_refused_with_a_remedy() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let night = seed_night(&router, org_id, &cookie).await;
    let participation_id = seed_participation(&pool, org_id, &night.event_id).await;

    let refused = Call::new(
        "POST",
        format!(
            "/api/v1/orgs/{org_id}/events/{}/assignments",
            night.event_id
        ),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "shift_id": night.shift_id,
        "participation_id": participation_id,
        "post_id": night.cashier,
    }))
    .send(&router)
    .await;

    assert_refused_saying(&refused, "post of the shift's zone");
}

#[tokio::test]
async fn a_shift_on_a_post_is_refused_with_a_remedy() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let night = seed_night(&router, org_id, &cookie).await;

    let refused = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{}/shifts", night.event_id),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "location_id": night.bar_manager,
        "period": { "start": "2026-07-04T18:00:00Z", "end": "2026-07-04T20:00:00Z" },
    }))
    .send(&router)
    .await;

    assert_refused_saying(&refused, "zone's shifts");
}

#[tokio::test]
async fn generating_on_a_post_is_refused_with_a_remedy() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let night = seed_night(&router, org_id, &cookie).await;
    // A pattern, so the run reaches the insert instead of skipping the day as
    // `no_pattern`: the refusal under test is the schema's, not the walk's.
    let pattern = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(json!({
            "name": format!("P {}", Uuid::now_v7().simple()),
            "repeat": "tile",
            "segments": [{ "duration_minutes": 60 }],
        }))
        .send(&router)
        .await;
    assert_eq!(pattern.status, StatusCode::CREATED, "{:?}", pattern.body);
    let pattern_id = id_at(&pattern.body, "/shift_pattern/id");

    let refused = Call::new(
        "POST",
        format!(
            "/api/v1/orgs/{org_id}/events/{}/shifts/generate",
            night.event_id
        ),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "locations": [night.bar_manager],
        "days": ["2026-07-04"],
        "window": { "start": "18:00", "end": "20:00" },
        "pattern_id": pattern_id,
    }))
    .send(&router)
    .await;

    assert_refused_saying(&refused, "zone's shifts");
}
