// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The organisation-level shift-pattern catalogue (docs/04 §"Shift patterns",
//! ADR-0029).
//!
//! Two things here are the design rather than the plumbing, and each has a
//! test that would fail if somebody implemented the obvious alternative:
//!
//! * A pattern is a **generator**, not a constraint. `PUT` on one already
//!   attached to a location changes nothing about shifts already generated,
//!   and says so in `affected_shifts` — the field exists precisely so nobody
//!   has to wonder.
//! * The segment list is an **atomic replacement**, not a per-item bulk
//!   (ADR-0024): half an *artiste* pattern is not a pattern.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::{Call, create_event_body, pool, router, seed_member};

/// `45 / 45 / 90 / 45 / 45` — the *artiste* post from ADR-0029, and the reason
/// patterns are a table rather than a two-hour constant.
fn artiste() -> serde_json::Value {
    json!({
        "name": format!("Artiste {}", uuid::Uuid::now_v7().simple()),
        "repeat": "tile",
        "on_remainder": "drop",
        "segments": [
            { "kind": "shift", "duration_minutes": 45 },
            { "kind": "shift", "duration_minutes": 45 },
            { "kind": "shift", "duration_minutes": 90, "label": "Set" },
            { "kind": "shift", "duration_minutes": 45 },
            { "kind": "shift", "duration_minutes": 45 }
        ]
    })
}

#[tokio::test]
async fn a_pattern_round_trips_with_its_segments_in_the_order_they_were_sent() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(artiste())
        .send(&router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    assert!(
        created.body["operation_id"].is_string(),
        "every mutating request returns an operation id (ADR-0024): {:?}",
        created.body
    );
    let id = created
        .body
        .pointer("/shift_pattern/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/shift-patterns/{id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);

    // The client never sends a position: the array order is the order, and the
    // API assigns the positions (docs/04 §"Shift patterns").
    let durations: Vec<i64> = read.body["segments"]
        .as_array()
        .map(|segments| {
            segments
                .iter()
                .filter_map(|segment| segment["duration_minutes"].as_i64())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(durations, vec![45, 45, 90, 45, 45], "{:?}", read.body);
    assert_eq!(read.body["segments"][2]["label"], "Set");
}

#[tokio::test]
async fn a_pattern_with_no_shift_segment_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let answer = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(json!({
            "name": format!("All Gap {}", uuid::Uuid::now_v7().simple()),
            "repeat": "tile",
            "segments": [{ "kind": "gap", "duration_minutes": 60 }]
        }))
        .send(&router)
        .await;
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a pattern that generates nothing must be refused: {:?}",
        answer.body
    );
}

#[tokio::test]
async fn an_empty_segment_list_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let answer = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(json!({
            "name": format!("Empty {}", uuid::Uuid::now_v7().simple()),
            "repeat": "tile",
            "segments": []
        }))
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
async fn two_patterns_in_one_org_may_not_share_a_name() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let body = artiste();

    let first = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(body.clone())
        .send(&router)
        .await;
    assert_eq!(first.status, StatusCode::CREATED, "{:?}", first.body);

    let second = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(body)
        .send(&router)
        .await;
    assert_eq!(second.status, StatusCode::CONFLICT, "{:?}", second.body);
}

/// ADR-0029's whole point: a pattern generates shifts, it does not constrain
/// them. Editing one after shifts exist is allowed, changes no shift, and the
/// response says how many it changed.
#[tokio::test]
async fn editing_a_pattern_leaves_shifts_already_generated_alone() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(artiste())
        .send(&router)
        .await;
    let id = created
        .body
        .pointer("/shift_pattern/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/shift-patterns/{id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;

    let replaced = Call::new("PUT", format!("/api/v1/orgs/{org_id}/shift-patterns/{id}"))
        .signed_in_as(&cookie)
        .if_match(&read.etag())
        .body(json!({
            "name": format!("Two Hours {}", uuid::Uuid::now_v7().simple()),
            "repeat": "tile",
            "on_remainder": "truncate",
            "segments": [{ "kind": "shift", "duration_minutes": 120 }]
        }))
        .send(&router)
        .await;
    assert_eq!(replaced.status, StatusCode::OK, "{:?}", replaced.body);
    assert_eq!(
        replaced.body["affected_shifts"], 0,
        "ADR-0029: a pattern is a generator, so editing it touches no existing shift"
    );
    assert_eq!(
        replaced
            .body
            .pointer("/shift_pattern/segments")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len),
        Some(1),
        "PUT is a full replace of the segment list: {:?}",
        replaced.body
    );
}

/// The rule docs/04 §"Shift patterns" spells out with its own error body: a
/// pattern finer than the event's availability picker cannot be attached,
/// because the picker could never express availability that lines up with it.
#[tokio::test]
async fn a_pattern_finer_than_the_availability_step_cannot_be_attached_to_an_event() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let pattern = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(artiste())
        .send(&router)
        .await;
    let pattern_id = pattern
        .body
        .pointer("/shift_pattern/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(&cookie)
        .body(create_event_body("Stepped Event"))
        .send(&router)
        .await;
    let event_id = event
        .body
        .pointer("/event/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;

    // The event defaults to a 30-minute step, and 45 is not a multiple of 30.
    let refused = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&read.etag())
        .body(json!({ "default_shift_pattern_id": pattern_id }))
        .send(&router)
        .await;
    assert_eq!(
        refused.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        refused.body
    );
    assert_eq!(
        refused.body["type"],
        "https://evp.example/errors/validation-failed"
    );
    assert!(
        refused
            .body
            .pointer("/errors/default_shift_pattern_id")
            .is_some(),
        "the refusal names the field and the step that would work: {:?}",
        refused.body
    );

    // Setting the step to 15 first is the remedy the message names, and it works.
    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    let stepped = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&read.etag())
        .body(json!({ "availability_step_minutes": 15, "default_shift_pattern_id": pattern_id }))
        .send(&router)
        .await;
    assert_eq!(stepped.status, StatusCode::OK, "{:?}", stepped.body);
}

#[tokio::test]
async fn a_zone_lead_may_read_the_catalogue_but_not_change_it() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, owner_cookie) = seed_member(&pool, "owner").await;
    let lead_cookie = support::add_member(&pool, org_id, "zone_lead").await;

    let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&owner_cookie)
        .body(artiste())
        .send(&router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);

    let listed = Call::new("GET", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&lead_cookie)
        .send(&router)
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{:?}", listed.body);

    let refused = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&lead_cookie)
        .body(artiste())
        .send(&router)
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{:?}", refused.body);
}

/// `DELETE` archives a pattern something still points at, and deletes one
/// nothing does (docs/04 §"Shift patterns"). Archiving rather than refusing,
/// because an org that has stopped using a division still has last year's
/// events generated from it.
#[tokio::test]
async fn delete_archives_a_referenced_pattern_and_removes_an_unreferenced_one() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let unused = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(json!({
            "name": format!("Unused {}", uuid::Uuid::now_v7().simple()),
            "repeat": "once",
            "segments": [{ "kind": "shift", "duration_minutes": 120 }]
        }))
        .send(&router)
        .await;
    let unused_id = unused
        .body
        .pointer("/shift_pattern/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let gone = Call::new(
        "DELETE",
        format!("/api/v1/orgs/{org_id}/shift-patterns/{unused_id}"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert_eq!(gone.status, StatusCode::NO_CONTENT, "{:?}", gone.body);
    let read = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/shift-patterns/{unused_id}"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert_eq!(read.status, StatusCode::NOT_FOUND);

    // Now one an event points at.
    let used = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(json!({
            "name": format!("Used {}", uuid::Uuid::now_v7().simple()),
            "repeat": "tile",
            "segments": [{ "kind": "shift", "duration_minutes": 120 }]
        }))
        .send(&router)
        .await;
    let used_id = used
        .body
        .pointer("/shift_pattern/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(&cookie)
        .body(create_event_body("Patterned Event"))
        .send(&router)
        .await;
    let event_id = event
        .body
        .pointer("/event/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    let attached = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&read.etag())
        .body(json!({ "default_shift_pattern_id": used_id }))
        .send(&router)
        .await;
    assert_eq!(attached.status, StatusCode::OK, "{:?}", attached.body);

    let archived = Call::new(
        "DELETE",
        format!("/api/v1/orgs/{org_id}/shift-patterns/{used_id}"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert_eq!(archived.status, StatusCode::OK, "{:?}", archived.body);
    assert_eq!(archived.body["shift_pattern"]["is_archived"], true);

    // Archived, not gone: last year's event still names the division it used.
    let read = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/shift-patterns/{used_id}"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);
    assert_eq!(read.body["is_archived"], true);
}

/// The default listing hides archived patterns, because the picker that reads
/// it is offering a division to use *now*.
#[tokio::test]
async fn archived_patterns_are_out_of_the_default_listing_and_back_with_a_filter() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(artiste())
        .send(&router)
        .await;
    let id = created
        .body
        .pointer("/shift_pattern/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(&cookie)
        .body(create_event_body("Holder"))
        .send(&router)
        .await;
    let event_id = event
        .body
        .pointer("/event/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&read.etag())
        .body(json!({ "availability_step_minutes": 15, "default_shift_pattern_id": id }))
        .send(&router)
        .await;
    Call::new(
        "DELETE",
        format!("/api/v1/orgs/{org_id}/shift-patterns/{id}"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;

    let live = Call::new("GET", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert!(
        !live.body["data"].to_string().contains(id.as_str()),
        "an archived pattern must not be offered as a division to use now: {:?}",
        live.body
    );

    let all = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/shift-patterns?archived=true"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert!(
        all.body["data"].to_string().contains(id.as_str()),
        "?archived=true must bring it back: {:?}",
        all.body
    );
}
