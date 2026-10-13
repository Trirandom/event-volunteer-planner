// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/events/{event}/locations` — the zone/post tree (docs/03 §3.4, docs/04
//! §"Events, locations, shifts").
//!
//! The hierarchy is exactly two levels and the schema says so with a `CHECK`;
//! what the schema cannot say is that a post's zone must belong to the **same
//! event**, because the composite foreign key carries `org_id` and not
//! `event_id`. That gap is the most interesting thing in this file: without
//! the handler check, "Bar" under the Open Air could be parented to a zone of
//! Dub & 2step, and the board would render one event's post inside another
//! event's zone.

mod support;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support::{Call, create_event_body, pool, router, seed_member};

/// Creates an event and returns its id.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed_event(router: &axum::Router, org_id: uuid::Uuid, cookie: &str) -> String {
    let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(cookie)
        .body(create_event_body("Location Event"))
        .send(router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    created
        .body
        .pointer("/event/id")
        .and_then(Value::as_str)
        .expect("a created event carries a string id")
        .to_owned()
}

fn id_of(answer: &support::Answer) -> String {
    answer
        .body
        .pointer("/location/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn the_tree_comes_back_nested_with_posts_under_their_zone() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let path = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let zone = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar", "colour": "#c04a2f" }))
        .send(&router)
        .await;
    assert_eq!(zone.status, StatusCode::CREATED, "{:?}", zone.body);
    assert!(
        zone.body["operation_id"].is_string(),
        "every mutating request returns an operation id (ADR-0024): {:?}",
        zone.body
    );
    let zone_id = id_of(&zone);

    for (order, name) in ["Bar 1", "Bar 2"].iter().enumerate() {
        let post = Call::new("POST", &path)
            .signed_in_as(&cookie)
            .body(json!({
                "kind": "post", "name": name, "parent_id": zone_id, "sort_order": order
            }))
            .send(&router)
            .await;
        assert_eq!(post.status, StatusCode::CREATED, "{:?}", post.body);
    }

    let tree = Call::new("GET", &path)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(tree.status, StatusCode::OK, "{:?}", tree.body);
    assert_eq!(tree.body["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(tree.body.pointer("/data/0/name"), Some(&json!("Bar")));
    assert_eq!(tree.body.pointer("/data/0/colour"), Some(&json!("#c04a2f")));

    let posts = tree
        .body
        .pointer("/data/0/posts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let names: Vec<&str> = posts
        .iter()
        .filter_map(|post| post["name"].as_str())
        .collect();
    assert_eq!(
        names,
        vec!["Bar 1", "Bar 2"],
        "posts come back under their zone, in sort_order: {:?}",
        tree.body
    );
}

#[tokio::test]
async fn a_post_needs_a_zone_and_a_zone_may_not_have_one() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let path = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let orphan = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "post", "name": "Nowhere" }))
        .send(&router)
        .await;
    assert_eq!(
        orphan.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a post with no zone must be refused: {:?}",
        orphan.body
    );

    let zone = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Entrée" }))
        .send(&router)
        .await;
    let zone_id = id_of(&zone);

    let nested_zone = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Deeper", "parent_id": zone_id }))
        .send(&router)
        .await;
    assert_eq!(
        nested_zone.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "the hierarchy is exactly two levels (docs/03 §3.4): {:?}",
        nested_zone.body
    );
}

/// `exact_address`, `latitude` and `longitude` are zone-only — a post is
/// reached through its own zone, and never gets its own pin.
#[tokio::test]
async fn a_post_may_not_carry_an_exact_address_or_coordinates() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let path = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let zone = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar" }))
        .send(&router)
        .await;
    let zone_id = id_of(&zone);

    let post = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "kind": "post",
            "name": "Till 1",
            "parent_id": zone_id,
            "exact_address": "12 Rue de la Paix",
        }))
        .send(&router)
        .await;
    assert_eq!(
        post.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a post has no exact address of its own: {:?}",
        post.body
    );

    let pinned_post = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "kind": "post",
            "name": "Till 1",
            "parent_id": zone_id,
            "latitude": 48.8566,
            "longitude": 2.3522,
        }))
        .send(&router)
        .await;
    assert_eq!(
        pinned_post.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a post has no coordinates of its own: {:?}",
        pinned_post.body
    );
}

/// `latitude` and `longitude` name one point together; one without the other
/// names nothing.
#[tokio::test]
async fn latitude_and_longitude_must_be_sent_together() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let path = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let lopsided = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Backstage field", "latitude": 48.8566 }))
        .send(&router)
        .await;
    assert_eq!(
        lopsided.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "latitude with no longitude names no point: {:?}",
        lopsided.body
    );

    let zone = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({
            "kind": "zone",
            "name": "Backstage field",
            "latitude": 48.8566,
            "longitude": 2.3522,
        }))
        .send(&router)
        .await;
    assert_eq!(zone.status, StatusCode::CREATED, "{:?}", zone.body);
    assert_eq!(
        zone.body.pointer("/location/latitude"),
        Some(&json!(48.8566))
    );
    assert_eq!(
        zone.body.pointer("/location/longitude"),
        Some(&json!(2.3522))
    );
}

/// The composite FK on `locations` carries `org_id`, not `event_id`, so the
/// database alone would allow this. Nothing else in the stack catches it.
#[tokio::test]
async fn a_post_may_not_be_parented_to_a_zone_of_another_event() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let first_event = seed_event(&router, org_id, &cookie).await;
    let second_event = seed_event(&router, org_id, &cookie).await;

    let zone = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{first_event}/locations"),
    )
    .signed_in_as(&cookie)
    .body(json!({ "kind": "zone", "name": "Bar" }))
    .send(&router)
    .await;
    let zone_id = id_of(&zone);

    let smuggled = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{second_event}/locations"),
    )
    .signed_in_as(&cookie)
    .body(json!({ "kind": "post", "name": "Bar 1", "parent_id": zone_id }))
    .send(&router)
    .await;
    assert_eq!(
        smuggled.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a post's zone must belong to the same event: {:?}",
        smuggled.body
    );
}

#[tokio::test]
async fn two_posts_under_one_zone_may_not_share_a_name() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let path = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let zone = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar" }))
        .send(&router)
        .await;
    let zone_id = id_of(&zone);
    let post = json!({ "kind": "post", "name": "Bar 1", "parent_id": zone_id });

    let first = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(post.clone())
        .send(&router)
        .await;
    assert_eq!(first.status, StatusCode::CREATED, "{:?}", first.body);

    let second = Call::new("POST", &path)
        .signed_in_as(&cookie)
        .body(post)
        .send(&router)
        .await;
    assert_eq!(second.status, StatusCode::CONFLICT, "{:?}", second.body);
}

#[tokio::test]
async fn renaming_a_location_needs_the_current_etag() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let zone = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar" }))
        .send(&router)
        .await;
    let zone_id = id_of(&zone);
    let etag = zone.etag();

    let without = Call::new("PATCH", format!("{base}/{zone_id}"))
        .signed_in_as(&cookie)
        .body(json!({ "name": "Bar Central" }))
        .send(&router)
        .await;
    assert_eq!(without.status, StatusCode::PRECONDITION_REQUIRED);

    let renamed = Call::new("PATCH", format!("{base}/{zone_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(json!({ "name": "Bar Central" }))
        .send(&router)
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{:?}", renamed.body);
    assert_eq!(renamed.body["location"]["name"], "Bar Central");

    let stale = Call::new("PATCH", format!("{base}/{zone_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(json!({ "name": "Bar Again" }))
        .send(&router)
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT, "{:?}", stale.body);
}

/// Deleting a zone takes its posts with it (`ON DELETE CASCADE`). That is the
/// schema's decision, and this asserts it reaches the API rather than leaving
/// orphaned posts the tree endpoint would silently drop.
#[tokio::test]
async fn deleting_a_zone_takes_its_posts_with_it() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let zone = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar" }))
        .send(&router)
        .await;
    let zone_id = id_of(&zone);
    let post = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "post", "name": "Bar 1", "parent_id": zone_id }))
        .send(&router)
        .await;
    let post_id = id_of(&post);

    let deleted = Call::new("DELETE", format!("{base}/{zone_id}"))
        .signed_in_as(&cookie)
        .if_match(&zone.etag())
        .send(&router)
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{:?}", deleted.body);

    let tree = Call::new("GET", &base)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert!(
        !tree.body.to_string().contains(post_id.as_str()),
        "the post must have gone with its zone: {:?}",
        tree.body
    );
}

/// The same rule as on the event, at the other attachment point docs/04
/// §"Shift patterns" names.
#[tokio::test]
async fn a_location_pattern_finer_than_the_events_step_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let pattern = Call::new("POST", format!("/api/v1/orgs/{org_id}/shift-patterns"))
        .signed_in_as(&cookie)
        .body(json!({
            "name": format!("Artiste {}", uuid::Uuid::now_v7().simple()),
            "repeat": "tile",
            "segments": [
                { "duration_minutes": 45 }, { "duration_minutes": 45 },
                { "duration_minutes": 90 }, { "duration_minutes": 45 },
                { "duration_minutes": 45 }
            ]
        }))
        .send(&router)
        .await;
    let pattern_id = pattern
        .body
        .pointer("/shift_pattern/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let zone = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Scène" }))
        .send(&router)
        .await;
    let zone_id = id_of(&zone);

    // The event defaults to a 30-minute step; 45 is not a multiple of it.
    let refused = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({
            "kind": "post", "name": "Artiste", "parent_id": zone_id,
            "shift_pattern_id": pattern_id
        }))
        .send(&router)
        .await;
    assert_eq!(
        refused.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        refused.body
    );
    assert!(
        refused.body.pointer("/errors/shift_pattern_id").is_some(),
        "the refusal names the field: {:?}",
        refused.body
    );
}

#[tokio::test]
async fn a_zone_lead_may_read_the_tree_but_not_change_it() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, owner_cookie) = seed_member(&pool, "owner").await;
    let lead_cookie = support::add_member(&pool, org_id, "zone_lead").await;
    let event_id = seed_event(&router, org_id, &owner_cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let read = Call::new("GET", &base)
        .signed_in_as(&lead_cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);

    let refused = Call::new("POST", &base)
        .signed_in_as(&lead_cookie)
        .body(json!({ "kind": "zone", "name": "Not Mine" }))
        .send(&router)
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{:?}", refused.body);
}

#[tokio::test]
async fn locations_of_an_event_in_another_org_are_not_found() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_a, cookie_a) = seed_member(&pool, "owner").await;
    let (org_b, cookie_b) = seed_member(&pool, "owner").await;
    let event_in_a = seed_event(&router, org_a, &cookie_a).await;

    // A member of B, naming B's org but A's event: RLS hides the row, and the
    // handler must not turn that into a 500 or a silent empty tree it would
    // then let a caller write into.
    let read = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_b}/events/{event_in_a}/locations"),
    )
    .signed_in_as(&cookie_b)
    .send(&router)
    .await;
    assert_eq!(read.status, StatusCode::NOT_FOUND, "{:?}", read.body);
}

/// `min_volunteers`/`max_volunteers` round-trip on a post (they are not
/// zone-only, unlike the map data), and a PATCH is tri-state per side: a
/// number sets, `null` clears, an absent key leaves the stored value.
#[tokio::test]
async fn volunteer_bounds_are_created_set_and_cleared() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let zone = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar" }))
        .send(&router)
        .await;
    assert_eq!(zone.status, StatusCode::CREATED, "{:?}", zone.body);
    assert!(
        zone.body["location"].get("min_volunteers").is_none()
            && zone.body["location"].get("max_volunteers").is_none(),
        "unset bounds are skipped, not sent as null or 0: {:?}",
        zone.body
    );

    let post = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({
            "kind": "post",
            "name": "Till 1",
            "parent_id": id_of(&zone),
            "min_volunteers": 2,
            "max_volunteers": 4,
        }))
        .send(&router)
        .await;
    assert_eq!(post.status, StatusCode::CREATED, "{:?}", post.body);
    assert_eq!(post.body["location"]["min_volunteers"], 2);
    assert_eq!(post.body["location"]["max_volunteers"], 4);
    let post_id = id_of(&post);

    let cleared = Call::new("PATCH", format!("{base}/{post_id}"))
        .signed_in_as(&cookie)
        .if_match(&post.etag())
        .body(json!({ "min_volunteers": null, "max_volunteers": 6 }))
        .send(&router)
        .await;
    assert_eq!(cleared.status, StatusCode::OK, "{:?}", cleared.body);
    assert!(
        cleared.body["location"].get("min_volunteers").is_none(),
        "null clears the floor: {:?}",
        cleared.body
    );
    assert_eq!(cleared.body["location"]["max_volunteers"], 6);

    let untouched = Call::new("PATCH", format!("{base}/{post_id}"))
        .signed_in_as(&cookie)
        .if_match(&cleared.etag())
        .body(json!({ "min_volunteers": 3 }))
        .send(&router)
        .await;
    assert_eq!(untouched.status, StatusCode::OK, "{:?}", untouched.body);
    assert_eq!(untouched.body["location"]["min_volunteers"], 3);
    assert_eq!(
        untouched.body["location"]["max_volunteers"], 6,
        "an absent key leaves the stored ceiling alone: {:?}",
        untouched.body
    );
}

/// A ceiling below the floor is a 422 naming `max_volunteers` — on create,
/// and on a PATCH that sends only one side, where the other side is the
/// stored value rather than nothing. The same goes for a negative floor and
/// a zero ceiling.
#[tokio::test]
async fn volunteer_bounds_out_of_order_are_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let inverted = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar", "min_volunteers": 5, "max_volunteers": 3 }))
        .send(&router)
        .await;
    assert_eq!(
        inverted.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        inverted.body
    );
    assert_eq!(
        inverted.body["type"],
        "https://evp.example/errors/validation-failed"
    );
    assert!(
        inverted.body.pointer("/errors/max_volunteers").is_some(),
        "the refusal names the field: {:?}",
        inverted.body
    );

    for (body, field) in [
        (
            json!({ "kind": "zone", "name": "Neg", "min_volunteers": -1 }),
            "min_volunteers",
        ),
        (
            json!({ "kind": "zone", "name": "Zero", "max_volunteers": 0 }),
            "max_volunteers",
        ),
    ] {
        let refused = Call::new("POST", &base)
            .signed_in_as(&cookie)
            .body(body)
            .send(&router)
            .await;
        assert_eq!(
            refused.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{:?}",
            refused.body
        );
        assert!(
            refused.body.pointer(&format!("/errors/{field}")).is_some(),
            "{:?}",
            refused.body
        );
    }

    let zone = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar", "min_volunteers": 4 }))
        .send(&router)
        .await;
    assert_eq!(zone.status, StatusCode::CREATED, "{:?}", zone.body);
    let zone_id = id_of(&zone);

    let below_stored_floor = Call::new("PATCH", format!("{base}/{zone_id}"))
        .signed_in_as(&cookie)
        .if_match(&zone.etag())
        .body(json!({ "max_volunteers": 2 }))
        .send(&router)
        .await;
    assert_eq!(
        below_stored_floor.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a ceiling sent alone is compared against the stored floor: {:?}",
        below_stored_floor.body
    );
    assert!(
        below_stored_floor
            .body
            .pointer("/errors/max_volunteers")
            .is_some(),
        "{:?}",
        below_stored_floor.body
    );

    let with_floor_cleared = Call::new("PATCH", format!("{base}/{zone_id}"))
        .signed_in_as(&cookie)
        .if_match(&zone.etag())
        .body(json!({ "min_volunteers": null, "max_volunteers": 2 }))
        .send(&router)
        .await;
    assert_eq!(
        with_floor_cleared.status,
        StatusCode::OK,
        "clearing the floor in the same request makes the ceiling coherent: {:?}",
        with_floor_cleared.body
    );
}

/// The form flags default to the common case on a zone, round-trip through a
/// PATCH, and are absent on a post, which takes its zone's.
#[tokio::test]
async fn zone_form_flags_default_and_patch_and_are_absent_on_posts() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let zone = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Son" }))
        .send(&router)
        .await;
    assert_eq!(zone.status, StatusCode::CREATED, "{:?}", zone.body);
    assert_eq!(zone.body["location"]["checked_by_default"], true);
    assert_eq!(zone.body["location"]["adults_only"], false);

    let flagged = Call::new("PATCH", format!("{base}/{}", id_of(&zone)))
        .signed_in_as(&cookie)
        .if_match(&zone.etag())
        .body(json!({ "checked_by_default": false, "adults_only": true }))
        .send(&router)
        .await;
    assert_eq!(flagged.status, StatusCode::OK, "{:?}", flagged.body);
    assert_eq!(flagged.body["location"]["checked_by_default"], false);
    assert_eq!(flagged.body["location"]["adults_only"], true);

    let created = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar", "adults_only": true }))
        .send(&router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    assert_eq!(created.body["location"]["checked_by_default"], true);
    assert_eq!(created.body["location"]["adults_only"], true);

    let post = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "post", "name": "Console", "parent_id": id_of(&zone) }))
        .send(&router)
        .await;
    assert_eq!(post.status, StatusCode::CREATED, "{:?}", post.body);
    assert!(
        post.body["location"].get("checked_by_default").is_none()
            && post.body["location"].get("adults_only").is_none(),
        "a post has no flags of its own to show: {:?}",
        post.body
    );
}

/// `checked_by_default` and `adults_only` are zone-only. Refused on a post at
/// creation and on a PATCH, before the constraint would be reached.
#[tokio::test]
async fn a_post_may_not_carry_form_flags() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let event_id = seed_event(&router, org_id, &cookie).await;
    let base = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");

    let zone = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Bar" }))
        .send(&router)
        .await;
    let zone_id = id_of(&zone);

    for flag in [
        json!({ "checked_by_default": false }),
        json!({ "adults_only": true }),
    ] {
        let mut body = json!({ "kind": "post", "name": "Till 1", "parent_id": zone_id });
        if let (Some(fields), Some(extra)) = (body.as_object_mut(), flag.as_object()) {
            fields.extend(extra.clone());
        }
        let refused = Call::new("POST", &base)
            .signed_in_as(&cookie)
            .body(body)
            .send(&router)
            .await;
        assert_eq!(
            refused.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{flag}: {:?}",
            refused.body
        );
    }

    let post = Call::new("POST", &base)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "post", "name": "Till 1", "parent_id": zone_id }))
        .send(&router)
        .await;
    let patched = Call::new("PATCH", format!("{base}/{}", id_of(&post)))
        .signed_in_as(&cookie)
        .if_match(&post.etag())
        .body(json!({ "adults_only": true }))
        .send(&router)
        .await;
    assert_eq!(
        patched.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        patched.body
    );
}
