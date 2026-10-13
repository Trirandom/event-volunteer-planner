// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `GET`/`PUT /api/v1/orgs/{org}/sms-settings` (ADR-0034, docs/04 §"SMS
//! settings"): the 404-before-any-save contract the frontend relies on
//! (`apps/admin/src/api/smsSettings.ts`), the owner-only permission, that a
//! save never echoes the secret back, and that an omitted secret on update
//! keeps the value already stored.

mod support;

use serde_json::json;
use support::{Call, pool, router, seed_member};

#[tokio::test]
async fn no_settings_yet_is_404() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "owner").await;

    let answer = Call::new("GET", format!("/api/v1/orgs/{org_id}/sms-settings"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;

    assert_eq!(answer.status, axum::http::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn owner_saves_settings_and_never_gets_the_secret_back() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "owner").await;

    let answer = Call::new("PUT", format!("/api/v1/orgs/{org_id}/sms-settings"))
        .signed_in_as(&cookie)
        .body(json!({
            "provider": "ovh",
            "service_name": "sms-xxxxx-1",
            "sender": "MyOrg",
            "application_key": "abc123",
            "application_secret": "xyz",
            "consumer_key": "cons-xyz",
        }))
        .send(&router)
        .await;

    assert_eq!(answer.status, axum::http::StatusCode::OK);
    assert_eq!(answer.body["provider"], "ovh");
    assert_eq!(answer.body["service_name"], "sms-xxxxx-1");
    assert_eq!(answer.body["sender"], "MyOrg");
    assert_eq!(answer.body["application_key"], "abc123");
    assert_eq!(answer.body["has_application_secret"], true);
    assert_eq!(answer.body["has_consumer_key"], true);
    assert!(answer.body.get("application_secret").is_none());
    assert!(answer.body.get("consumer_key").is_none());
    assert!(
        answer.body["operation_id"].is_string(),
        "a mutating endpoint must record its inverse and return an operation id (ADR-0024)"
    );

    let get_answer = Call::new("GET", format!("/api/v1/orgs/{org_id}/sms-settings"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(get_answer.status, axum::http::StatusCode::OK);
    assert_eq!(get_answer.body["has_application_secret"], true);
    assert_eq!(get_answer.body["has_consumer_key"], true);
    assert!(get_answer.body.get("application_secret").is_none());
}

#[tokio::test]
async fn first_save_without_a_secret_is_rejected() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "owner").await;

    let answer = Call::new("PUT", format!("/api/v1/orgs/{org_id}/sms-settings"))
        .signed_in_as(&cookie)
        .body(json!({
            "provider": "ovh",
            "service_name": "sms-xxxxx-1",
            "sender": "MyOrg",
            "application_key": "abc123",
        }))
        .send(&router)
        .await;

    assert_eq!(answer.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        answer.body["type"],
        "https://evp.example/errors/validation-failed"
    );
}

#[tokio::test]
async fn updating_without_resending_the_secret_keeps_it_set() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "owner").await;

    Call::new("PUT", format!("/api/v1/orgs/{org_id}/sms-settings"))
        .signed_in_as(&cookie)
        .body(json!({
            "provider": "ovh",
            "service_name": "sms-xxxxx-1",
            "sender": "MyOrg",
            "application_key": "abc123",
            "application_secret": "xyz",
            "consumer_key": "cons-xyz",
        }))
        .send(&router)
        .await;

    // Only the sender changes; both secrets are omitted, as a `PUT` from a
    // form where the coordinator left those fields blank would send.
    let answer = Call::new("PUT", format!("/api/v1/orgs/{org_id}/sms-settings"))
        .signed_in_as(&cookie)
        .body(json!({
            "provider": "ovh",
            "service_name": "sms-xxxxx-1",
            "sender": "Renamed",
            "application_key": "abc123",
        }))
        .send(&router)
        .await;

    assert_eq!(answer.status, axum::http::StatusCode::OK);
    assert_eq!(answer.body["sender"], "Renamed");
    assert_eq!(
        answer.body["has_application_secret"], true,
        "an omitted secret on update must not clear the value already stored"
    );
    assert_eq!(answer.body["has_consumer_key"], true);
}

#[tokio::test]
async fn coordinator_is_forbidden() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let answer = Call::new("GET", format!("/api/v1/orgs/{org_id}/sms-settings"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;

    assert_eq!(answer.status, axum::http::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn zone_lead_is_forbidden() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "zone_lead").await;

    let answer = Call::new("PUT", format!("/api/v1/orgs/{org_id}/sms-settings"))
        .signed_in_as(&cookie)
        .body(json!({
            "provider": "ovh",
            "service_name": "sms-xxxxx-1",
            "sender": "MyOrg",
            "application_key": "abc123",
            "application_secret": "xyz",
            "consumer_key": "cons-xyz",
        }))
        .send(&router)
        .await;

    assert_eq!(answer.status, axum::http::StatusCode::FORBIDDEN);
}
