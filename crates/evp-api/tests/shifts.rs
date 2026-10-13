// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/events/{event}/shifts` — the schedule grid (docs/04 §"Events, locations,
//! shifts").
//!
//! Two of the six hard rules (docs/02 §5, docs/05 §2) are reachable from this
//! endpoint and each has a test that *attempts the violation* rather than
//! asserting the happy path: a shift outside its event, and a shift longer
//! than a day. Both are constraint triggers or `CHECK`s in migration
//! `…101500`, and what is asserted here is that they surface as a `422` a
//! coordinator can act on rather than a `500`.

mod support;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support::{Call, create_event_body, pool, router, seed_member};

/// An event running 2026-07-04T06:00Z → 2026-07-07T06:00Z, one zone and one
/// post inside it. Returns `(event_id, post_id)`.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed_event_with_post(
    router: &axum::Router,
    org_id: uuid::Uuid,
    cookie: &str,
) -> (String, String) {
    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(cookie)
        .body(create_event_body("Shift Event"))
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
        .expect("a created zone carries a string id")
        .to_owned();

    let post = Call::new("POST", &base)
        .signed_in_as(cookie)
        .body(json!({ "kind": "post", "name": "Bar 1", "parent_id": zone_id }))
        .send(router)
        .await;
    let post_id = post
        .body
        .pointer("/location/id")
        .and_then(Value::as_str)
        .expect("a created post carries a string id")
        .to_owned();

    (event_id, post_id)
}

fn shift_body(location_id: &str, start: &str, end: &str) -> Value {
    json!({
        "location_id": location_id,
        "period": { "start": start, "end": end },
        "required_count": 2
    })
}

#[tokio::test]
async fn a_shift_inside_its_event_is_created_and_listed() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post_id) = seed_event_with_post(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts");

    let created = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(shift_body(
            &post_id,
            "2026-07-04T18:00:00Z",
            "2026-07-04T20:00:00Z",
        ))
        .send(&router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    assert_eq!(created.body["shift"]["required_count"], 2);
    assert!(
        created.body["operation_id"].is_string(),
        "every mutating request returns an operation id (ADR-0024): {:?}",
        created.body
    );

    let listed = Call::new("GET", &base)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{:?}", listed.body);
    assert_eq!(listed.body["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        listed.body.pointer("/data/0/location_id"),
        Some(&json!(post_id))
    );
}

/// One of the six hard rules: a shift cannot fall outside its event
/// (docs/02 §5). Enforced by the `shifts_within_event` constraint trigger.
#[tokio::test]
async fn a_shift_outside_its_event_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post_id) = seed_event_with_post(&router, org_id, &cookie).await;

    // The event starts on the 4th; this is the day before.
    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(&cookie)
    .body(shift_body(
        &post_id,
        "2026-07-03T18:00:00Z",
        "2026-07-03T20:00:00Z",
    ))
    .send(&router)
    .await;
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a shift before its event must be refused, not stored: {:?}",
        answer.body
    );
    assert_eq!(
        answer.body["type"],
        "https://evp.example/errors/validation-failed"
    );
}

#[tokio::test]
async fn a_shift_longer_than_a_day_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post_id) = seed_event_with_post(&router, org_id, &cookie).await;

    // Inside the event, and 25 hours long: `shifts_period_sane`.
    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(&cookie)
    .body(shift_body(
        &post_id,
        "2026-07-04T07:00:00Z",
        "2026-07-05T08:00:00Z",
    ))
    .send(&router)
    .await;
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        answer.body
    );
}

#[tokio::test]
async fn an_empty_or_inverted_period_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post_id) = seed_event_with_post(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts");

    for (start, end) in [
        ("2026-07-04T18:00:00Z", "2026-07-04T18:00:00Z"),
        ("2026-07-04T20:00:00Z", "2026-07-04T18:00:00Z"),
    ] {
        let answer = Call::new("POST", &base)
            .signed_in_as(&cookie)
            .body(shift_body(&post_id, start, end))
            .send(&router)
            .await;
        assert_eq!(
            answer.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{start}..{end} must be refused: {:?}",
            answer.body
        );
    }
}

#[tokio::test]
async fn max_count_below_required_count_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post_id) = seed_event_with_post(&router, org_id, &cookie).await;

    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(&cookie)
    .body(json!({
        "location_id": post_id,
        "period": { "start": "2026-07-04T18:00:00Z", "end": "2026-07-04T20:00:00Z" },
        "required_count": 4,
        "max_count": 2
    }))
    .send(&router)
    .await;
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a ceiling below the floor is not a staffing level: {:?}",
        answer.body
    );
}

/// `shifts`' composite foreign key on `location_id` carries `org_id`, not
/// `event_id` — the same gap the location tree has on `parent_id`. Without a
/// handler check, a shift of the Open Air could be filed under a post of Dub &
/// 2step, and only the `shifts_within_event` trigger would notice, and only if
/// the two events' periods happened not to overlap.
#[tokio::test]
async fn a_shift_may_not_be_filed_under_a_location_of_another_event() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (first_event, first_post) = seed_event_with_post(&router, org_id, &cookie).await;
    let (second_event, _second_post) = seed_event_with_post(&router, org_id, &cookie).await;

    // Both fixture events run over the same days, so the within-event trigger
    // is satisfied and this would otherwise be stored.
    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{second_event}/shifts"),
    )
    .signed_in_as(&cookie)
    .body(shift_body(
        &first_post,
        "2026-07-04T18:00:00Z",
        "2026-07-04T20:00:00Z",
    ))
    .send(&router)
    .await;
    assert_ne!(first_event, second_event);
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a shift's location must belong to the same event: {:?}",
        answer.body
    );
}

#[tokio::test]
async fn moving_a_shift_needs_the_current_etag_and_stays_inside_the_event() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post_id) = seed_event_with_post(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts");

    let created = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(shift_body(
            &post_id,
            "2026-07-04T18:00:00Z",
            "2026-07-04T20:00:00Z",
        ))
        .send(&router)
        .await;
    let shift_id = created
        .body
        .pointer("/shift/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let etag = created.etag();

    let without = Call::new("PATCH", format!("{base}/{shift_id}"))
        .signed_in_as(&cookie)
        .body(json!({ "title": "Service" }))
        .send(&router)
        .await;
    assert_eq!(without.status, StatusCode::PRECONDITION_REQUIRED);

    let moved = Call::new("PATCH", format!("{base}/{shift_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(json!({
            "title": "Service",
            "period": { "start": "2026-07-05T18:00:00Z", "end": "2026-07-05T22:00:00Z" }
        }))
        .send(&router)
        .await;
    assert_eq!(moved.status, StatusCode::OK, "{:?}", moved.body);
    assert_eq!(moved.body["shift"]["title"], "Service");

    // And the trigger still applies to a move, not only to an insert.
    let outside = Call::new("PATCH", format!("{base}/{shift_id}"))
        .signed_in_as(&cookie)
        .if_match(&moved.etag())
        .body(json!({
            "period": { "start": "2026-07-20T18:00:00Z", "end": "2026-07-20T22:00:00Z" }
        }))
        .send(&router)
        .await;
    assert_eq!(
        outside.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "moving a shift out of its event must be refused: {:?}",
        outside.body
    );
}

#[tokio::test]
async fn the_listing_filters_by_window_and_by_location() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post_id) = seed_event_with_post(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts");

    for (start, end) in [
        ("2026-07-04T18:00:00Z", "2026-07-04T20:00:00Z"),
        ("2026-07-06T18:00:00Z", "2026-07-06T20:00:00Z"),
    ] {
        let answer = Call::new("POST", &base)
            .signed_in_as(&cookie)
            .body(shift_body(&post_id, start, end))
            .send(&router)
            .await;
        assert_eq!(answer.status, StatusCode::CREATED, "{:?}", answer.body);
    }

    let day = Call::new(
        "GET",
        format!("{base}?from=2026-07-04T00:00:00Z&to=2026-07-05T00:00:00Z"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert_eq!(day.status, StatusCode::OK, "{:?}", day.body);
    assert_eq!(
        day.body["data"].as_array().map(Vec::len),
        Some(1),
        "?from/?to must be a half-open window over the day asked for: {:?}",
        day.body
    );

    let elsewhere = Call::new("GET", format!("{base}?location={}", uuid::Uuid::now_v7()))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(elsewhere.body["data"].as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn a_zone_lead_may_read_shifts_but_not_write_them() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, owner_cookie) = seed_member(&pool, "owner").await;
    let lead_cookie = support::add_member(&pool, org_id, "zone_lead").await;
    let (event_id, post_id) = seed_event_with_post(&router, org_id, &owner_cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts");

    let read = Call::new("GET", &base)
        .signed_in_as(&lead_cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);

    let refused = Call::new("POST", &base)
        .signed_in_as(&lead_cookie)
        .body(shift_body(
            &post_id,
            "2026-07-04T18:00:00Z",
            "2026-07-04T20:00:00Z",
        ))
        .send(&router)
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{:?}", refused.body);
}

#[tokio::test]
async fn deleting_a_shift_removes_it() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, post_id) = seed_event_with_post(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts");

    let created = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(shift_body(
            &post_id,
            "2026-07-04T18:00:00Z",
            "2026-07-04T20:00:00Z",
        ))
        .send(&router)
        .await;
    let shift_id = created
        .body
        .pointer("/shift/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let deleted = Call::new("DELETE", format!("{base}/{shift_id}"))
        .signed_in_as(&cookie)
        .if_match(&created.etag())
        .send(&router)
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{:?}", deleted.body);

    let listed = Call::new("GET", &base)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(listed.body["data"].as_array().map(Vec::len), Some(0));
}
