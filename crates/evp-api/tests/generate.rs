// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `POST …/events/{event}/shifts/generate` (docs/04 §"Generating shifts").
//!
//! The wall-clock walk itself is unit-tested in `evp_domain::generate`, where
//! every DST case is a value in and a value out. What is tested here is the
//! part that needs a database: pattern resolution most-specific-first, the
//! per-item `skipped` convention, the dry run writing nothing, and the whole
//! run being one operation (ADR-0024).

mod support;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support::{Call, pool, router, seed_member};

/// An event in Europe/Paris over 2026-03-28 → 2026-03-31 — chosen so the
/// spring-forward day (the 29th) is inside it — plus one zone and two posts.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed(router: &axum::Router, org_id: uuid::Uuid, cookie: &str) -> (String, String, String) {
    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(cookie)
        .body(json!({
            "name": "Generation Event",
            "slug": format!("gen-{}", uuid::Uuid::now_v7().simple()),
            "timezone": "Europe/Paris",
            "period": { "start": "2026-03-27T00:00:00Z", "end": "2026-04-01T00:00:00Z" }
        }))
        .send(router)
        .await;
    assert_eq!(event.status, StatusCode::CREATED, "{:?}", event.body);
    let event_id = event
        .body
        .pointer("/event/id")
        .and_then(Value::as_str)
        .expect("a created event carries a string id")
        .to_owned();

    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");
    let zone = Call::new("POST", &base)
        .signed_in_as(cookie)
        .body(json!({ "kind": "zone", "name": "Bar" }))
        .send(router)
        .await;
    let zone_id = zone
        .body
        .pointer("/location/id")
        .and_then(Value::as_str)
        .expect("zone id")
        .to_owned();

    let mut posts = Vec::new();
    for name in ["Bar 1", "Bar 2"] {
        let post = Call::new("POST", &base)
            .signed_in_as(cookie)
            .body(json!({ "kind": "post", "name": name, "parent_id": zone_id }))
            .send(router)
            .await;
        posts.push(
            post.body
                .pointer("/location/id")
                .and_then(Value::as_str)
                .expect("post id")
                .to_owned(),
        );
    }
    let mut posts = posts.into_iter();
    let first = posts.next().expect("two posts were created");
    let second = posts.next().expect("two posts were created");
    (event_id, first, second)
}

/// Creates a pattern and returns its id.
async fn pattern(
    router: &axum::Router,
    org_id: uuid::Uuid,
    cookie: &str,
    segments: Value,
) -> String {
    let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(cookie)
        .body(json!({
            "name": format!("P {}", uuid::Uuid::now_v7().simple()),
            "repeat": "tile",
            "segments": segments
        }))
        .send(router)
        .await;
    created
        .body
        .pointer("/shift_pattern/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn count(body: &Value, key: &str) -> usize {
    body[key].as_array().map_or(0, Vec::len)
}

#[tokio::test]
async fn a_run_creates_one_shift_per_slot_per_location_per_day() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, first_post, second_post) = seed(&router, org_id, &cookie).await;
    let pattern_id = pattern(
        &router,
        org_id,
        &cookie,
        json!([{ "duration_minutes": 120 }]),
    )
    .await;

    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts/generate"),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "locations": [first_post, second_post],
        "days": ["2026-03-30", "2026-03-31"],
        "window": { "start": "09:00", "end": "15:00" },
        "pattern_id": pattern_id,
        "required_count": 2
    }))
    .send(&router)
    .await;

    assert_eq!(answer.status, StatusCode::OK, "{:?}", answer.body);
    assert_eq!(
        count(&answer.body, "created"),
        12,
        "2 locations × 2 days × 3 slots: {:?}",
        answer.body
    );
    assert_eq!(count(&answer.body, "skipped"), 0);
    assert_eq!(answer.body["remainder_minutes"], 0);
    assert!(
        answer.body["operation_id"].is_string(),
        "the whole run is one operation, so Ctrl+Z removes all twelve \
         (ADR-0024): {:?}",
        answer.body
    );

    let listed = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert_eq!(listed.body["data"].as_array().map(Vec::len), Some(12));
    assert_eq!(
        listed.body.pointer("/data/0/required_count"),
        Some(&json!(2))
    );
}

#[tokio::test]
async fn a_dry_run_returns_the_same_body_and_writes_nothing() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post, _other) = seed(&router, org_id, &cookie).await;
    let pattern_id = pattern(
        &router,
        org_id,
        &cookie,
        json!([{ "duration_minutes": 120 }]),
    )
    .await;

    let body = json!({
        "locations": [post],
        "days": ["2026-03-30"],
        "window": { "start": "09:00", "end": "14:00" },
        "pattern_id": pattern_id,
        "dry_run": true
    });
    let preview = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts/generate"),
    )
    .signed_in_as(&cookie)
    .body(body)
    .send(&router)
    .await;

    assert_eq!(preview.status, StatusCode::OK, "{:?}", preview.body);
    assert_eq!(count(&preview.body, "created"), 2, "09–11 and 11–13");
    assert_eq!(
        preview.body["remainder_minutes"], 60,
        "the dropped 13–14 hour is reported, never rounded up"
    );
    assert!(
        preview.body["operation_id"].is_null(),
        "a dry run writes nothing, so it is not an operation: {:?}",
        preview.body
    );

    let listed = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert_eq!(
        listed.body["data"].as_array().map(Vec::len),
        Some(0),
        "a preview that wrote rows is not a preview"
    );
}

/// Resolution is most-specific-first: the argument, then the location's, then
/// the event's. A location with no pattern anywhere in that chain is
/// `skipped` with `no_pattern` rather than silently given two-hour slots.
#[tokio::test]
async fn a_location_with_no_pattern_anywhere_is_skipped_rather_than_guessed_at() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post, _other) = seed(&router, org_id, &cookie).await;

    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts/generate"),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "locations": [post],
        "days": ["2026-03-30"],
        "window": { "start": "09:00", "end": "15:00" }
    }))
    .send(&router)
    .await;

    assert_eq!(answer.status, StatusCode::OK, "{:?}", answer.body);
    assert_eq!(count(&answer.body, "created"), 0);
    assert_eq!(
        answer.body.pointer("/skipped/0/reason"),
        Some(&json!("no_pattern")),
        "{:?}",
        answer.body
    );
}

#[tokio::test]
async fn the_locations_own_pattern_wins_over_the_events_default() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post, _other) = seed(&router, org_id, &cookie).await;

    let two_hours = pattern(
        &router,
        org_id,
        &cookie,
        json!([{ "duration_minutes": 120 }]),
    )
    .await;
    let one_hour = pattern(
        &router,
        org_id,
        &cookie,
        json!([{ "duration_minutes": 60 }]),
    )
    .await;

    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    let attached = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&read.etag())
        .body(json!({ "default_shift_pattern_id": two_hours }))
        .send(&router)
        .await;
    assert_eq!(attached.status, StatusCode::OK, "{:?}", attached.body);

    // `If-Match: *` rather than a tag: the tree is a collection and carries no
    // ETag of its own. A client that has just read the tree builds the tag for
    // one location from the `version` on that entry.
    let overridden = Call::new(
        "PATCH",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/locations/{post}"),
    )
    .signed_in_as(&cookie)
    .if_match("*")
    .body(json!({ "shift_pattern_id": one_hour }))
    .send(&router)
    .await;
    assert_eq!(overridden.status, StatusCode::OK, "{:?}", overridden.body);

    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts/generate"),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "locations": [post],
        "days": ["2026-03-30"],
        "window": { "start": "09:00", "end": "15:00" }
    }))
    .send(&router)
    .await;

    assert_eq!(
        count(&answer.body, "created"),
        6,
        "the location's own hourly division, not the event's two-hour default: {:?}",
        answer.body
    );
}

/// Per-item, per the bulk convention: the day that already holds overlapping
/// shifts is reported, and the rest are created (ADR-0024).
#[tokio::test]
async fn a_second_run_skips_the_days_it_already_filled_and_creates_the_rest() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post, _other) = seed(&router, org_id, &cookie).await;
    let pattern_id = pattern(
        &router,
        org_id,
        &cookie,
        json!([{ "duration_minutes": 120 }]),
    )
    .await;
    let path = format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts/generate");

    let first = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "locations": [post], "days": ["2026-03-30"],
            "window": { "start": "09:00", "end": "15:00" },
            "pattern_id": pattern_id
        }))
        .send(&router)
        .await;
    assert_eq!(count(&first.body, "created"), 3, "{:?}", first.body);

    let second = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "locations": [post], "days": ["2026-03-30", "2026-03-31"],
            "window": { "start": "09:00", "end": "15:00" },
            "pattern_id": pattern_id
        }))
        .send(&router)
        .await;
    assert_eq!(second.status, StatusCode::OK, "{:?}", second.body);
    assert_eq!(
        count(&second.body, "created"),
        3,
        "the 31st is still empty and must be filled: {:?}",
        second.body
    );
    assert_eq!(
        second.body.pointer("/skipped/0/reason"),
        Some(&json!("overlaps_existing")),
        "{:?}",
        second.body
    );
    assert_eq!(
        second.body.pointer("/skipped/0/day"),
        Some(&json!("2026-03-30"))
    );
}

/// The walk runs in the **event's** zone. Europe/Paris skips 02:00–03:00 on
/// 2026-03-29, and a segment landing there is skipped with the offending local
/// time rather than nudged forward by an hour.
#[tokio::test]
async fn a_day_whose_slots_land_in_a_spring_forward_gap_is_skipped_with_the_local_time() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post, _other) = seed(&router, org_id, &cookie).await;
    let pattern_id = pattern(
        &router,
        org_id,
        &cookie,
        json!([{ "duration_minutes": 60 }]),
    )
    .await;

    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts/generate"),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "locations": [post],
        "days": ["2026-03-29", "2026-03-30"],
        "window": { "start": "01:00", "end": "05:00" },
        "pattern_id": pattern_id
    }))
    .send(&router)
    .await;

    assert_eq!(answer.status, StatusCode::OK, "{:?}", answer.body);
    assert_eq!(
        answer.body.pointer("/skipped/0/reason"),
        Some(&json!("nonexistent_local_time")),
        "{:?}",
        answer.body
    );
    assert!(
        answer
            .body
            .pointer("/skipped/0/detail")
            .and_then(Value::as_str)
            .is_some_and(|detail| detail.contains("02:00")),
        "the skip names the local time that does not exist: {:?}",
        answer.body
    );
    assert_eq!(
        count(&answer.body, "created"),
        4,
        "the 30th is an ordinary day and is still generated: {:?}",
        answer.body
    );
}

/// A `once` pattern that overruns is `422` for the whole run, not a skip: the
/// coordinator's window and their pattern disagree, and that is a mistake to
/// correct rather than a per-item clash to report.
#[tokio::test]
async fn a_once_pattern_overrunning_the_window_fails_the_whole_run() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post, _other) = seed(&router, org_id, &cookie).await;

    let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(json!({
            "name": format!("Once {}", uuid::Uuid::now_v7().simple()),
            "repeat": "once",
            "segments": [{ "duration_minutes": 240 }]
        }))
        .send(&router)
        .await;
    let pattern_id = created
        .body
        .pointer("/shift_pattern/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts/generate"),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "locations": [post],
        "days": ["2026-03-30"],
        "window": { "start": "09:00", "end": "12:00" },
        "pattern_id": pattern_id
    }))
    .send(&router)
    .await;

    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        answer.body
    );
    assert!(
        answer
            .body
            .get("detail")
            .and_then(Value::as_str)
            .is_some_and(|detail| detail.contains("13:00")),
        "the refusal names the local time the pattern would have ended at: {:?}",
        answer.body
    );
}

#[tokio::test]
async fn generated_shifts_must_still_fall_inside_the_event() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post, _other) = seed(&router, org_id, &cookie).await;
    let pattern_id = pattern(
        &router,
        org_id,
        &cookie,
        json!([{ "duration_minutes": 120 }]),
    )
    .await;

    // The event runs 2026-03-27 → 2026-04-01; this day is outside it.
    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts/generate"),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "locations": [post],
        "days": ["2026-05-01"],
        "window": { "start": "09:00", "end": "15:00" },
        "pattern_id": pattern_id
    }))
    .send(&router)
    .await;

    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "generation must not be a way around the within-event rule: {:?}",
        answer.body
    );
}

#[tokio::test]
async fn a_zone_lead_may_not_generate_shifts() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, owner_cookie) = seed_member(&pool, "owner").await;
    let lead_cookie = support::add_member(&pool, org_id, "zone_lead").await;
    let (event_id, post, _other) = seed(&router, org_id, &owner_cookie).await;

    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts/generate"),
    )
    .signed_in_as(&lead_cookie)
    .body(json!({
        "locations": [post], "days": ["2026-03-30"],
        "window": { "start": "09:00", "end": "15:00" }
    }))
    .send(&router)
    .await;
    assert_eq!(answer.status, StatusCode::FORBIDDEN, "{:?}", answer.body);
}
