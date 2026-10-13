// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `GET /orgs/{org}/festivals/{festival}/submissions`, driven through the
//! real router exactly as the route-role-matrix suite does (docs/13 §1):
//! sorting, the shape of `answers[]`/`availability[]`, and the two cases the
//! worked example fixture does not itself exercise — a volunteer whose
//! `first_name`/`last_name` are populated (every fixture volunteer's are
//! `NULL`, on purpose — see `evp_domain::example`'s module doc) and a
//! submission with no availability windows at all, rendered as `[]` rather
//! than being missing.

mod support;

use axum::http::StatusCode;
use jiff::Timestamp;
use serde_json::Value;
use sqlx::Row as _;
use support::{Call, pool, router, seed_member};
use uuid::Uuid;

async fn load_example(org_id: Uuid, cookie: &str, router: &axum::Router) -> Value {
    let answer = Call::new("POST", format!("/api/v1/orgs/{org_id}/festivals/example"))
        .signed_in_as(cookie)
        .send(router)
        .await;
    assert_eq!(answer.status, StatusCode::CREATED, "{:?}", answer.body);
    answer.body
}

async fn submissions_of(
    router: &axum::Router,
    org_id: Uuid,
    festival_id: &str,
    cookie: &str,
) -> Value {
    let answer = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/festivals/{festival_id}/submissions"),
    )
    .signed_in_as(cookie)
    .send(router)
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{:?}", answer.body);
    answer.body
}

#[tokio::test]
async fn submissions_are_sorted_and_carry_event_ids_on_every_window() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let created = load_example(org_id, &cookie, &router).await;
    let festival_id = created["festival"]["id"].as_str().expect("festival id");

    let body = submissions_of(&router, org_id, festival_id, &cookie).await;
    let submissions = body["submissions"].as_array().expect("submissions array");
    assert!(
        submissions.len() >= 20,
        "expected the fixture's ~25 volunteers, got {}",
        submissions.len()
    );

    let timestamps: Vec<Timestamp> = submissions
        .iter()
        .map(|submission| {
            submission["submitted_at"]
                .as_str()
                .expect("submitted_at is a string")
                .parse()
                .expect("submitted_at is RFC 3339")
        })
        .collect();
    assert!(
        timestamps.windows(2).all(|pair| pair[0] <= pair[1]),
        "submissions must be sorted by submitted_at ascending: {timestamps:?}"
    );

    let mut saw_a_window = false;
    for submission in submissions {
        for window in submission["availability"]
            .as_array()
            .expect("availability array")
        {
            saw_a_window = true;
            let event_id = window["event_id"]
                .as_str()
                .expect("event_id is present and a string");
            assert!(
                Uuid::parse_str(event_id).is_ok(),
                "event_id {event_id} is not a UUID"
            );
            let start: Timestamp = window["start"]
                .as_str()
                .expect("start is a string")
                .parse()
                .expect("start is RFC 3339");
            let end: Timestamp = window["end"]
                .as_str()
                .expect("end is a string")
                .parse()
                .expect("end is RFC 3339");
            assert!(end > start, "window end must be after its start");
        }
    }
    assert!(
        saw_a_window,
        "expected at least one volunteer with a declared window"
    );
}

#[tokio::test]
async fn a_volunteer_with_no_declared_availability_still_renders_an_empty_list() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let created = load_example(org_id, &cookie, &router).await;
    let festival_id = created["festival"]["id"].as_str().expect("festival id");

    let body = submissions_of(&router, org_id, festival_id, &cookie).await;
    let submissions = body["submissions"].as_array().expect("submissions array");

    let weber = submissions
        .iter()
        .find(|submission| submission["display_name"] == "Weber Margot")
        .expect("Weber Margot is one of the fixture volunteers");
    assert_eq!(
        weber["availability"].as_array().expect("array"),
        &Vec::<Value>::new()
    );
    assert!(
        !weber["answers"].as_array().expect("array").is_empty(),
        "Weber Margot answered the form; only her availability is empty"
    );
}

/// Every fixture volunteer's `first_name`/`last_name` are `NULL` (the legacy
/// CSV never asked them separately). This proves the redesigned form's
/// non-null case renders correctly, by inserting one directly rather than by
/// stretching the fixture's provenance (see `evp_domain::example`'s module
/// doc for why).
#[tokio::test]
async fn first_name_and_last_name_render_when_the_volunteer_has_them() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let created = load_example(org_id, &cookie, &router).await;
    let festival_id = created["festival"]["id"].as_str().expect("festival id");

    // A volunteer who came through the two-question form (ADR-0012), inserted
    // directly onto the existing intake source/batch the example load just
    // created — reusing them rather than fabricating a second source is what
    // keeps this test about the rendering, not about intake plumbing.
    let mut tx = pool.begin().await.expect("begin fixture transaction");
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("set app.current_org_id");

    let source_id: Uuid = sqlx::query("SELECT id FROM intake_sources WHERE org_id = $1 LIMIT 1")
        .bind(org_id)
        .fetch_one(&mut *tx)
        .await
        .expect("the example load created one intake source")
        .try_get("id")
        .expect("id column");
    let batch_id: Uuid = sqlx::query("SELECT id FROM submission_batches WHERE org_id = $1 LIMIT 1")
        .bind(org_id)
        .fetch_one(&mut *tx)
        .await
        .expect("the example load created one submission batch")
        .try_get("id")
        .expect("id column");

    let volunteer_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO volunteers (id, org_id, display_name, first_name, last_name) \
         VALUES ($1, $2, 'Marie Dupont', 'Marie', 'Dupont')",
    )
    .bind(volunteer_id)
    .bind(org_id)
    .execute(&mut *tx)
    .await
    .expect("insert volunteers row");

    let submission_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO submissions \
           (id, org_id, source_id, batch_id, external_id, submitted_at, state, volunteer_id, \
            match_kind, applied_at) \
         VALUES ($1, $2, $3, $4, 'test-marie-dupont', now(), 'applied', $5, 'new', now())",
    )
    .bind(submission_id)
    .bind(org_id)
    .bind(source_id)
    .bind(batch_id)
    .bind(volunteer_id)
    .execute(&mut *tx)
    .await
    .expect("insert submissions row");
    tx.commit().await.expect("commit fixture transaction");

    let body = submissions_of(&router, org_id, festival_id, &cookie).await;
    let submissions = body["submissions"].as_array().expect("submissions array");
    let marie = submissions
        .iter()
        .find(|submission| submission["display_name"] == "Marie Dupont")
        .expect("Marie Dupont was inserted directly and must appear");
    assert_eq!(marie["first_name"], "Marie");
    assert_eq!(marie["last_name"], "Dupont");
}

#[tokio::test]
async fn a_zone_lead_cookie_is_forbidden_from_reading_submissions() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, coordinator_cookie) = seed_member(&pool, "coordinator").await;
    let created = load_example(org_id, &coordinator_cookie, &router).await;
    let festival_id = created["festival"]["id"]
        .as_str()
        .expect("festival id")
        .to_owned();

    let zone_lead_cookie = support::add_member(&pool, org_id, "zone_lead").await;
    let answer = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/festivals/{festival_id}/submissions"),
    )
    .signed_in_as(&zone_lead_cookie)
    .send(&router)
    .await;
    assert_eq!(answer.status, StatusCode::FORBIDDEN, "{:?}", answer.body);
}
