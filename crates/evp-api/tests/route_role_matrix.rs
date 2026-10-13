// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Drives the real router — org extractor, RLS transaction, and the
//! festival/event handlers — through `tower::ServiceExt::oneshot`, exactly as
//! a real request would arrive. Nothing here is mocked: the pool is a live
//! PostgreSQL connection as `evp_api`, the same role and the same RLS
//! policies a deployment runs under (docs/13 §1).
//!
//! Covers the route × role matrix (docs/04 §4: owner and coordinator may
//! create, a zone lead may only read), the two example endpoints (creates on
//! an empty org, `409` on a non-empty one, safe to call twice), and that a
//! caller outside the organisation gets the same `404` a caller who mistyped
//! the id would (docs/04 §2).

mod support;

use axum::Router;
use axum::http::StatusCode;
use serde_json::Value;
use support::{Call, pool, router, seed_member};
use uuid::Uuid;

fn create_festival_body() -> Value {
    serde_json::json!({
        "name": "Route Matrix Festival",
        "slug": format!("route-matrix-{}", Uuid::now_v7().simple()),
        "timezone": "Europe/Paris",
        "period": { "start": "2026-09-05T00:00:00Z", "end": "2026-09-15T00:00:00Z" }
    })
}

/// Thin shim onto [`support::Call`], so the assertions below keep reading as
/// `(status, body)` pairs — headers are what the events suite cares about,
/// not this one.
async fn send(
    router: &Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<&Value>,
) -> (StatusCode, Value) {
    let mut call = Call::new(method, path);
    if let Some(cookie) = cookie {
        call = call.signed_in_as(cookie);
    }
    if let Some(body) = body {
        call = call.body(body.clone());
    }
    let answer = call.send(router).await;
    (answer.status, answer.body)
}

#[tokio::test]
async fn reading_festivals_is_open_to_every_role_but_writing_needs_coordinator_or_above() {
    let pool = pool().await;
    let router = router(pool.clone());

    for role in ["owner", "coordinator", "zone_lead"] {
        let (org_id, cookie) = seed_member(&pool, role).await;
        let path = format!("/api/v1/orgs/{org_id}/festivals");

        let (status, _body) = send(&router, "GET", &path, Some(&cookie), None).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "role {role} could not read festivals"
        );

        let (status, body) = send(
            &router,
            "POST",
            &path,
            Some(&cookie),
            Some(&create_festival_body()),
        )
        .await;
        if role == "zone_lead" {
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "zone_lead was allowed to create a festival: {body:?}"
            );
            assert_eq!(body["type"], "https://evp.example/errors/forbidden");
        } else {
            assert_eq!(
                status,
                StatusCode::CREATED,
                "role {role} could not create a festival: {body:?}"
            );
            assert!(body["operation_id"].is_string());
            assert_eq!(body["festival"]["name"], "Route Matrix Festival");
        }
    }
}

#[tokio::test]
async fn no_session_is_unauthenticated() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, _cookie) = seed_member(&pool, "owner").await;

    let (status, body) = send(
        &router,
        "GET",
        &format!("/api/v1/orgs/{org_id}/festivals"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["type"], "https://evp.example/errors/unauthenticated");
}

#[tokio::test]
async fn a_member_of_another_org_gets_not_found_not_forbidden() {
    let pool = pool().await;
    let router = router(pool.clone());

    let (_org_a, _cookie_a) = seed_member(&pool, "owner").await;
    let (org_b, _cookie_b) = seed_member(&pool, "owner").await;
    // A third, unrelated member — belongs to neither org A nor org B.
    let (_org_c, cookie_c) = seed_member(&pool, "owner").await;

    let (status, body) = send(
        &router,
        "GET",
        &format!("/api/v1/orgs/{org_b}/festivals"),
        Some(&cookie_c),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a non-member saw something other than 404 for an org they do not belong to: {body:?}"
    );
    assert_eq!(body["type"], "https://evp.example/errors/not-found");
}

#[tokio::test]
async fn the_example_endpoint_creates_the_structure_once_and_refuses_a_second_load() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let (status, body) = send(
        &router,
        "POST",
        &format!("/api/v1/orgs/{org_id}/festivals/example"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    assert_eq!(body["festival"]["name"], "Soundclash 26");
    assert_eq!(body["festival"]["event_count"], 6);

    let (status, body) = send(
        &router,
        "POST",
        &format!("/api/v1/orgs/{org_id}/festivals/example"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "loading the example twice must be refused, not duplicated: {body:?}"
    );
    assert_eq!(body["type"], "https://evp.example/errors/conflict");
}

#[tokio::test]
async fn a_zone_lead_may_not_load_the_example() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "zone_lead").await;

    let (status, body) = send(
        &router,
        "POST",
        &format!("/api/v1/orgs/{org_id}/festivals/example"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
}

#[tokio::test]
async fn a_standalone_event_omits_festival_id_entirely_rather_than_sending_null() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "owner").await;

    // Per the frontend contract: the key is absent, never `null`.
    let body = serde_json::json!({
        "name": "Standalone Gig",
        "slug": format!("standalone-{}", Uuid::now_v7().simple()),
        "timezone": "Europe/Paris",
        "period": { "start": "2026-09-05T00:00:00Z", "end": "2026-09-06T00:00:00Z" }
    });
    assert!(body.get("festival_id").is_none());

    let (status, response) = send(
        &router,
        "POST",
        &format!("/api/v1/orgs/{org_id}/events"),
        Some(&cookie),
        Some(&body),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{response:?}");
    assert!(response["event"]["festival_id"].is_null());
}

#[tokio::test]
async fn reading_submissions_needs_coordinator_or_above_and_a_zone_lead_is_forbidden() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, coordinator_cookie) = seed_member(&pool, "coordinator").await;

    let (status, body) = send(
        &router,
        "POST",
        &format!("/api/v1/orgs/{org_id}/festivals/example"),
        Some(&coordinator_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let festival_id = body["festival"]["id"]
        .as_str()
        .expect("the created festival carries an id")
        .to_owned();

    for role in ["owner", "coordinator"] {
        let cookie = if role == "coordinator" {
            coordinator_cookie.clone()
        } else {
            support::add_member(&pool, org_id, role).await
        };
        let (status, body) = send(
            &router,
            "GET",
            &format!("/api/v1/orgs/{org_id}/festivals/{festival_id}/submissions"),
            Some(&cookie),
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "role {role} could not read submissions: {body:?}"
        );
        let submissions = body["submissions"]
            .as_array()
            .expect("submissions is an array");
        assert!(
            !submissions.is_empty(),
            "the worked example always ships with volunteers"
        );
        assert!(submissions[0]["display_name"].is_string());
        assert!(submissions[0]["submitted_at"].is_string());
        assert!(submissions[0]["answers"].is_array());
        assert!(submissions[0]["availability"].is_array());
    }

    let zone_lead_cookie = support::add_member(&pool, org_id, "zone_lead").await;
    let (status, body) = send(
        &router,
        "GET",
        &format!("/api/v1/orgs/{org_id}/festivals/{festival_id}/submissions"),
        Some(&zone_lead_cookie),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "zone_lead was allowed to read submissions: {body:?}"
    );
}

#[tokio::test]
async fn submissions_of_a_nonexistent_festival_is_not_found() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let (status, body) = send(
        &router,
        "GET",
        &format!(
            "/api/v1/orgs/{org_id}/festivals/{}/submissions",
            Uuid::now_v7()
        ),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body:?}");
}
