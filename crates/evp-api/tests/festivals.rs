// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Deleting a festival through the real router (ADR-0053): owner only, like
//! deleting an event (docs/04 §4), behind `If-Match`, with its cost readable
//! first. What the delete does to the rows underneath is
//! `crates/evp-db/tests/catalog.rs`'s to prove; this suite proves who may ask
//! and what they are told.

mod support;

use axum::Router;
use axum::http::StatusCode;
use support::{Call, pool, router, seed_member};
use uuid::Uuid;

/// Loads the worked example as the owner and returns its festival's id and
/// current `ETag`.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn example_festival(router: &Router, org_id: Uuid, owner: &str) -> (String, String) {
    let loaded = Call::new("POST", format!("/api/v1/orgs/{org_id}/festivals/example"))
        .signed_in_as(owner)
        .send(router)
        .await;
    assert_eq!(loaded.status, StatusCode::CREATED, "{:?}", loaded.body);
    let id = loaded.body["festival"]["id"]
        .as_str()
        .expect("the created festival has an id")
        .to_owned();
    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/festivals/{id}"))
        .signed_in_as(owner)
        .send(router)
        .await;
    (id, read.etag())
}

#[tokio::test]
async fn only_an_owner_may_read_the_cost_of_deleting_a_festival_or_delete_it() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, owner) = seed_member(&pool, "owner").await;
    let (festival_id, etag) = example_festival(&router, org_id, &owner).await;
    let festival = format!("/api/v1/orgs/{org_id}/festivals/{festival_id}");
    let deletion = format!("{festival}/deletion");

    for role in ["coordinator", "zone_lead"] {
        let cookie = support::add_member(&pool, org_id, role).await;
        let read = Call::new("GET", &deletion)
            .signed_in_as(&cookie)
            .send(&router)
            .await;
        assert_eq!(read.status, StatusCode::FORBIDDEN, "{role}: {:?}", read.body);
        let delete = Call::new("DELETE", &festival)
            .signed_in_as(&cookie)
            .if_match(&etag)
            .send(&router)
            .await;
        assert_eq!(delete.status, StatusCode::FORBIDDEN, "{role}: {:?}", delete.body);
    }

    let read = Call::new("GET", &deletion)
        .signed_in_as(&owner)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);
}

#[tokio::test]
async fn the_cost_of_deleting_a_festival_is_counted_before_anything_goes() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, owner) = seed_member(&pool, "owner").await;
    let (festival_id, _etag) = example_festival(&router, org_id, &owner).await;

    let read = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/festivals/{festival_id}/deletion"),
    )
    .signed_in_as(&owner)
    .send(&router)
    .await;

    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);
    assert_eq!(read.body["events"], 6, "{:?}", read.body);
    assert_eq!(read.body["forms"], 1, "{:?}", read.body);
    assert!(read.body["submissions"].is_number(), "{:?}", read.body);
}

#[tokio::test]
async fn deleting_a_festival_needs_if_match_and_leaves_its_events_standalone() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, owner) = seed_member(&pool, "owner").await;
    let (festival_id, etag) = example_festival(&router, org_id, &owner).await;
    let festival = format!("/api/v1/orgs/{org_id}/festivals/{festival_id}");

    let unconditional = Call::new("DELETE", &festival)
        .signed_in_as(&owner)
        .send(&router)
        .await;
    assert_eq!(
        unconditional.status,
        StatusCode::PRECONDITION_REQUIRED,
        "{:?}",
        unconditional.body
    );

    let deleted = Call::new("DELETE", &festival)
        .signed_in_as(&owner)
        .if_match(&etag)
        .send(&router)
        .await;
    assert_eq!(deleted.status, StatusCode::OK, "{:?}", deleted.body);
    assert!(deleted.body["operation_id"].is_string(), "{:?}", deleted.body);
    assert_eq!(deleted.body["events_ungrouped"], 6, "{:?}", deleted.body);
    assert_eq!(deleted.body["forms_deleted"], 1, "{:?}", deleted.body);
    assert!(deleted.body["submissions_deleted"].is_number());

    let gone = Call::new("GET", &festival)
        .signed_in_as(&owner)
        .send(&router)
        .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);

    let events = Call::new("GET", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(&owner)
        .send(&router)
        .await;
    let listed = events.body["data"]
        .as_array()
        .or_else(|| events.body.as_array())
        .cloned()
        .unwrap_or_default();
    assert_eq!(listed.len(), 6, "every event stays: {:?}", events.body);
    assert!(
        listed
            .iter()
            .all(|event| event.get("festival_id").is_none_or(serde_json::Value::is_null)),
        "each is standalone now: {listed:?}"
    );
}
