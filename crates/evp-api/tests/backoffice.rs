// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/api/v1/backoffice/…` through the real router (ADR-0045, docs/04
//! §"Backoffice"): off means 404, a wrong or missing key is 401, a
//! coordinator's session grants nothing, and the operator can create an
//! organisation and an account and make one a member of the other — after
//! which that account can actually sign in and reach the organisation.

mod support;

use axum::Router;
use axum::http::StatusCode;
use serde_json::{Value, json};
use support::{Call, pool, router, router_with_backoffice, seed_member};
use uuid::Uuid;

const KEY: &str = "backoffice-test-key-0123456789abcdef";

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::now_v7().simple())
}

async fn backoffice() -> Router {
    router_with_backoffice(pool().await, Some(KEY))
}

async fn create_org(router: &Router) -> Value {
    let answer = Call::new("POST", "/api/v1/backoffice/organizations")
        .bearer(KEY)
        .body(json!({ "name": "Soundclash", "slug": unique("sc") }))
        .send(router)
        .await;
    assert_eq!(answer.status, StatusCode::CREATED, "{}", answer.body);
    answer.body
}

async fn create_user(router: &Router, email: &str) -> Value {
    let answer = Call::new("POST", "/api/v1/backoffice/users")
        .bearer(KEY)
        .body(json!({
            "email": email,
            "display_name": "Camille",
            "password": "correct horse battery",
        }))
        .send(router)
        .await;
    assert_eq!(answer.status, StatusCode::CREATED, "{}", answer.body);
    answer.body
}

fn id(value: &Value) -> &str {
    value["id"].as_str().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

#[tokio::test]
async fn without_a_configured_key_every_route_is_not_found() {
    let router = router(pool().await);

    for (method, path) in [
        ("GET", "/api/v1/backoffice/organizations"),
        ("POST", "/api/v1/backoffice/organizations"),
        ("GET", "/api/v1/backoffice/users"),
    ] {
        // Even presenting a key: there is nothing for it to open.
        let answer = Call::new(method, path)
            .bearer(KEY)
            .body(json!({}))
            .send(&router)
            .await;
        assert_eq!(answer.status, StatusCode::NOT_FOUND, "{method} {path}");
    }
}

#[tokio::test]
async fn a_missing_key_is_unauthenticated() {
    let answer = Call::new("GET", "/api/v1/backoffice/organizations")
        .send(&backoffice().await)
        .await;
    assert_eq!(answer.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        answer.body["type"],
        "https://evp.example/errors/unauthenticated"
    );
}

#[tokio::test]
async fn a_wrong_key_is_unauthenticated() {
    let answer = Call::new("GET", "/api/v1/backoffice/organizations")
        .bearer("backoffice-test-key-0123456789abcdee")
        .send(&backoffice().await)
        .await;
    assert_eq!(answer.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_owners_session_grants_nothing_here() {
    let pool = pool().await;
    let router = router_with_backoffice(pool.clone(), Some(KEY));
    let (_org_id, cookie) = seed_member(&pool, "owner").await;

    let answer = Call::new("GET", "/api/v1/backoffice/organizations")
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(answer.status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_created_organisation_is_listed_with_no_members() {
    let router = backoffice().await;
    let created = create_org(&router).await;
    assert_eq!(created["timezone"], "Europe/Paris");
    assert_eq!(created["member_count"], 0);

    let listed = Call::new("GET", "/api/v1/backoffice/organizations")
        .bearer(KEY)
        .send(&router)
        .await;
    assert_eq!(listed.status, StatusCode::OK);
    let found = listed.body["data"]
        .as_array()
        .is_some_and(|orgs| orgs.iter().any(|org| org["id"] == created["id"]));
    assert!(found, "the new organisation is not in the list");
}

#[tokio::test]
async fn a_taken_slug_is_a_conflict() {
    let router = backoffice().await;
    let created = create_org(&router).await;

    let answer = Call::new("POST", "/api/v1/backoffice/organizations")
        .bearer(KEY)
        .body(json!({ "name": "Again", "slug": created["slug"] }))
        .send(&router)
        .await;
    assert_eq!(answer.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn a_malformed_slug_an_unknown_timezone_and_a_blank_name_are_refused() {
    let router = backoffice().await;

    for body in [
        json!({ "name": "Org", "slug": "Not A Slug" }),
        json!({ "name": "Org", "slug": unique("tz"), "timezone": "Mars/Olympus_Mons" }),
        json!({ "name": "  ", "slug": unique("blank") }),
    ] {
        let answer = Call::new("POST", "/api/v1/backoffice/organizations")
            .bearer(KEY)
            .body(body.clone())
            .send(&router)
            .await;
        assert_eq!(answer.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(
            answer.body["type"],
            "https://evp.example/errors/validation-failed"
        );
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_short_password_and_a_non_address_are_refused() {
    let router = backoffice().await;

    for body in [
        json!({ "email": format!("{}@example.test", unique("p")), "display_name": "A", "password": "short" }),
        json!({ "email": "not-an-address", "display_name": "A", "password": "long enough password" }),
    ] {
        let answer = Call::new("POST", "/api/v1/backoffice/users")
            .bearer(KEY)
            .body(body.clone())
            .send(&router)
            .await;
        assert_eq!(answer.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
}

#[tokio::test]
async fn a_taken_address_is_a_conflict() {
    let router = backoffice().await;
    let email = format!("{}@example.test", unique("dup"));
    create_user(&router, &email).await;

    let answer = Call::new("POST", "/api/v1/backoffice/users")
        .bearer(KEY)
        .body(json!({ "email": email, "display_name": "B", "password": "another long password" }))
        .send(&router)
        .await;
    assert_eq!(answer.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn a_created_account_never_carries_its_password_back() {
    let router = backoffice().await;
    let user = create_user(&router, &format!("{}@example.test", unique("np"))).await;

    assert!(user.get("password").is_none());
    assert!(user.get("password_hash").is_none());
    assert_eq!(user["last_login_at"], Value::Null);
    assert_eq!(user["memberships"], json!([]));
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_assigned_coordinator_can_sign_in_and_reach_the_organisation() {
    // The end-to-end reason the backoffice exists: nothing created here is
    // worth anything unless the account can then do its job.
    let router = backoffice().await;
    let org = create_org(&router).await;
    let email = format!("{}@example.test", unique("coord"));
    let user = create_user(&router, &email).await;

    let assigned = Call::new(
        "PUT",
        format!(
            "/api/v1/backoffice/organizations/{}/members/{}",
            id(&org),
            id(&user)
        ),
    )
    .bearer(KEY)
    .body(json!({ "role": "coordinator" }))
    .send(&router)
    .await;
    assert_eq!(assigned.status, StatusCode::OK, "{}", assigned.body);
    assert_eq!(assigned.body["role"], "coordinator");
    assert_eq!(assigned.body["email"], email.as_str());

    let login = Call::new("POST", "/api/v1/auth/login")
        .body(json!({ "email": email, "password": "correct horse battery" }))
        .send(&router)
        .await;
    assert_eq!(login.status, StatusCode::OK, "{}", login.body);
    assert_eq!(login.body["memberships"][0]["org_id"], org["id"]);
    assert_eq!(login.body["memberships"][0]["role"], "coordinator");
}

#[tokio::test]
async fn reassigning_changes_the_role_and_removing_twice_is_not_found() {
    let router = backoffice().await;
    let org = create_org(&router).await;
    let user = create_user(&router, &format!("{}@example.test", unique("re"))).await;
    let path = format!(
        "/api/v1/backoffice/organizations/{}/members/{}",
        id(&org),
        id(&user)
    );

    for role in ["coordinator", "owner"] {
        let answer = Call::new("PUT", path.clone())
            .bearer(KEY)
            .body(json!({ "role": role }))
            .send(&router)
            .await;
        assert_eq!(answer.status, StatusCode::OK);
        assert_eq!(answer.body["role"], role);
    }

    let members = Call::new(
        "GET",
        format!("/api/v1/backoffice/organizations/{}/members", id(&org)),
    )
    .bearer(KEY)
    .send(&router)
    .await;
    assert_eq!(members.body["data"].as_array().map(Vec::len), Some(1));

    let first = Call::new("DELETE", path.clone())
        .bearer(KEY)
        .send(&router)
        .await;
    assert_eq!(first.status, StatusCode::NO_CONTENT);
    let second = Call::new("DELETE", path).bearer(KEY).send(&router).await;
    assert_eq!(second.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_unknown_role_is_refused_and_unknown_ids_are_not_found() {
    let router = backoffice().await;
    let org = create_org(&router).await;
    let user = create_user(&router, &format!("{}@example.test", unique("ids"))).await;

    let bad_role = Call::new(
        "PUT",
        format!(
            "/api/v1/backoffice/organizations/{}/members/{}",
            id(&org),
            id(&user)
        ),
    )
    .bearer(KEY)
    .body(json!({ "role": "volunteer" }))
    .send(&router)
    .await;
    assert_eq!(bad_role.status, StatusCode::UNPROCESSABLE_ENTITY);

    for path in [
        format!(
            "/api/v1/backoffice/organizations/{}/members/{}",
            id(&org),
            Uuid::now_v7()
        ),
        format!(
            "/api/v1/backoffice/organizations/{}/members/{}",
            Uuid::now_v7(),
            id(&user)
        ),
        format!(
            "/api/v1/backoffice/organizations/not-a-uuid/members/{}",
            id(&user)
        ),
    ] {
        let answer = Call::new("PUT", path.clone())
            .bearer(KEY)
            .body(json!({ "role": "coordinator" }))
            .send(&router)
            .await;
        assert_eq!(answer.status, StatusCode::NOT_FOUND, "{path}");
    }

    let unknown_org = Call::new(
        "GET",
        format!(
            "/api/v1/backoffice/organizations/{}/members",
            Uuid::now_v7()
        ),
    )
    .bearer(KEY)
    .send(&router)
    .await;
    assert_eq!(unknown_org.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_user_list_shows_each_accounts_memberships() {
    let router = backoffice().await;
    let org = create_org(&router).await;
    let user = create_user(&router, &format!("{}@example.test", unique("list"))).await;
    Call::new(
        "PUT",
        format!(
            "/api/v1/backoffice/organizations/{}/members/{}",
            id(&org),
            id(&user)
        ),
    )
    .bearer(KEY)
    .body(json!({ "role": "zone_lead" }))
    .send(&router)
    .await;

    let users = Call::new("GET", "/api/v1/backoffice/users")
        .bearer(KEY)
        .send(&router)
        .await;
    assert_eq!(users.status, StatusCode::OK);
    let listed = users.body["data"]
        .as_array()
        .and_then(|all| all.iter().find(|candidate| candidate["id"] == user["id"]))
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(listed["memberships"][0]["org_id"], org["id"]);
    assert_eq!(listed["memberships"][0]["role"], "zone_lead");
}
