// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/orgs/{org}/forms` — authoring, versioning and publishing the
//! first-party form (docs/04 §"The volunteer form").
//!
//! Driven through the real router as `evp_api`, like every suite here. What
//! these assert is the contract the admin Formulaire page is written
//! against: paths, field names, statuses, the seeded draft, and the shape of
//! a `422` — `problems`, each naming a position and a code.

mod support;

use axum::Router;
use axum::http::StatusCode;
use serde_json::{Value, json};
use support::{Call, add_member, create_event_body, pool, router, seed_member};
use uuid::Uuid;

struct Scope {
    org_id: Uuid,
    cookie: String,
    festival_id: String,
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// A coordinator, a festival with one event, and two missions on it.
async fn festival_with_missions(router: &Router, pool: &sqlx::PgPool) -> Scope {
    let (org_id, cookie) = seed_member(pool, "coordinator").await;
    let festival = Call::new("POST", format!("/api/v1/orgs/{org_id}/festivals"))
        .signed_in_as(&cookie)
        .body(json!({
            "name": "Soundclash",
            "slug": format!("soundclash-{}", Uuid::now_v7().simple()),
            "timezone": "Europe/Paris",
            "period": { "start": "2026-07-01T06:00:00Z", "end": "2026-07-10T06:00:00Z" }
        }))
        .send(router)
        .await;
    assert_eq!(festival.status, StatusCode::CREATED, "{:?}", festival.body);
    let festival_id = str_at(&festival.body, "/festival/id").to_owned();

    let mut event_body = create_event_body("Open Air");
    if let Some(fields) = event_body.as_object_mut() {
        fields.insert("festival_id".to_owned(), json!(festival_id));
    }
    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(&cookie)
        .body(event_body)
        .send(router)
        .await;
    assert_eq!(event.status, StatusCode::CREATED, "{:?}", event.body);
    let event_id = str_at(&event.body, "/event/id").to_owned();

    let locations = format!("/api/v1/orgs/{org_id}/events/{event_id}/locations");
    let zone = Call::new("POST", &locations)
        .signed_in_as(&cookie)
        .body(json!({ "kind": "zone", "name": "Site" }))
        .send(router)
        .await;
    assert_eq!(zone.status, StatusCode::CREATED, "{:?}", zone.body);
    let post = Call::new("POST", &locations)
        .signed_in_as(&cookie)
        .body(json!({
            "kind": "post", "name": "Bar", "parent_id": str_at(&zone.body, "/location/id")
        }))
        .send(router)
        .await;
    assert_eq!(post.status, StatusCode::CREATED, "{:?}", post.body);

    Scope {
        org_id,
        cookie,
        festival_id,
    }
}

async fn create_form(router: &Router, org_id: Uuid, cookie: &str, scope: Value) -> Value {
    let mut body = json!({
        "name": "Bénévoles",
        "slug": format!("benevoles-{}", Uuid::now_v7().simple()),
    });
    if let (Some(body), Some(scope)) = (body.as_object_mut(), scope.as_object()) {
        body.extend(scope.clone());
    }
    let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/forms"))
        .signed_in_as(cookie)
        .body(body)
        .send(router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    created.body
}

fn version_path(org_id: Uuid, form: &Value) -> String {
    format!(
        "/api/v1/orgs/{org_id}/forms/{}/versions/{}",
        str_at(form, "/id"),
        str_at(form, "/versions/0/id")
    )
}

/// The draft's questions as `PUT` would take them back, and its `ETag`.
async fn read_draft(router: &Router, path: &str, cookie: &str) -> (Vec<Value>, String) {
    let read = Call::new("GET", path)
        .signed_in_as(cookie)
        .send(router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);
    let questions = read
        .body
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    (questions, read.etag())
}

fn problem_codes(body: &Value) -> Vec<(Value, String)> {
    body.get("problems")
        .and_then(Value::as_array)
        .map(|problems| {
            problems
                .iter()
                .map(|problem| {
                    (
                        problem.get("position").cloned().unwrap_or_default(),
                        str_at(problem, "/code").to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one form's whole life — seed, edit, publish, freeze, next draft — told in order; split, each half would have to rebuild the other's state"
)]
async fn a_festival_form_is_seeded_edited_published_and_versioned() {
    let pool = pool().await;
    let router = router(pool.clone());
    let scope = festival_with_missions(&router, &pool).await;
    let org_id = scope.org_id;
    let cookie = scope.cookie.as_str();

    let form = create_form(
        &router,
        org_id,
        cookie,
        json!({ "festival_id": scope.festival_id }),
    )
    .await;
    assert!(form["operation_id"].is_string(), "{form:?}");
    assert_eq!(form["festival_id"], json!(scope.festival_id));
    assert_eq!(form["event_id"], Value::Null);
    assert_eq!(form["default_locale"], "fr");
    assert_eq!(form["public_open"], true);
    assert_eq!(form["live_version_id"], Value::Null);
    assert_eq!(form["versions"][0]["version"], 1);
    assert_eq!(form["versions"][0]["published_at"], Value::Null);
    assert_eq!(form["versions"][0]["question_count"], 9);
    let form_id = str_at(&form, "/id").to_owned();

    // The seed, in the documented order.
    let path = version_path(org_id, &form);
    let (questions, etag) = read_draft(&router, &path, cookie).await;
    let kinds: Vec<&str> = questions
        .iter()
        .map(|question| question["kind"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        kinds,
        vec![
            "section",
            "short_text",
            "short_text",
            "email",
            "phone",
            "availability",
            "missions",
            "consent",
            "consent"
        ]
    );
    assert_eq!(questions[1]["target_path"], "volunteer.first_name");
    assert_eq!(
        questions[1]["label"],
        json!({ "fr": "Comment veux-tu qu'on t'appelle ?" })
    );
    assert_eq!(questions[1]["is_required"], true);
    assert_eq!(questions[2]["is_required"], false);
    assert_eq!(questions[0]["builtin"], false);
    assert_eq!(questions[5]["builtin"], true);
    assert_eq!(questions[5]["target_path"], Value::Null);
    // The commitment names the organisation the form belongs to (ADR-0040).
    assert_eq!(questions[7]["consent_purpose"], "commitment");
    assert_eq!(questions[7]["is_required"], true);
    assert_eq!(questions[7]["builtin"], true);
    assert_eq!(
        questions[7]["label"],
        json!({
            "fr": "Je confirme mon engagement bénévole auprès de Test Org pour cet événement.",
            "en": "I confirm my volunteer commitment to Test Org for this event."
        })
    );
    assert_eq!(questions[8]["consent_purpose"], "processing");
    assert_eq!(questions[8]["is_required"], true);
    let mission_values: Vec<&str> = questions[6]["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .map(|option| option["value"].as_str().unwrap_or_default())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(mission_values, vec!["bar", "site"]);

    let options = Call::new(
        "GET",
        format!("/api/v1/orgs/{org_id}/forms/{form_id}/mission-options"),
    )
    .signed_in_as(cookie)
    .send(&router)
    .await;
    assert_eq!(options.status, StatusCode::OK, "{:?}", options.body);
    assert_eq!(options.body["options"][0]["value"], "bar");
    assert_eq!(options.body["options"][0]["label"], "Bar");
    assert_eq!(
        options.body["options"][0]["event_ids"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );

    // A custom question, sent back alongside what was read.
    let mut edited = questions.clone();
    edited.push(json!({
        "kind": "boolean",
        "target_path": null,
        "consent_purpose": null,
        "label": { "fr": "Je veux rejoindre l'équipe fly" },
        "help_text": null,
        "options": null,
        "is_required": false,
        "is_sensitive": true
    }));
    let put = Call::new("PUT", &path)
        .signed_in_as(cookie)
        .if_match(&etag)
        .body(json!({ "privacy_notice_version": "2026-09", "questions": edited }))
        .send(&router)
        .await;
    assert_eq!(put.status, StatusCode::OK, "{:?}", put.body);
    assert!(put.body["operation_id"].is_string());
    assert_eq!(put.body["questions"].as_array().map(Vec::len), Some(10));
    assert_eq!(put.body["questions"][9]["builtin"], false);
    assert_eq!(put.body["questions"][9]["position"], 9);
    assert_eq!(put.body["privacy_notice_version"], "2026-09");
    assert_ne!(put.etag(), etag, "every PUT moves the draft's ETag");

    // The old ETag is now stale.
    let stale = Call::new("PUT", &path)
        .signed_in_as(cookie)
        .if_match(&etag)
        .body(json!({ "questions": edited }))
        .send(&router)
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT, "{:?}", stale.body);

    let publish = Call::new("POST", format!("{path}/publish"))
        .signed_in_as(cookie)
        .if_match(&put.etag())
        .send(&router)
        .await;
    assert_eq!(publish.status, StatusCode::OK, "{:?}", publish.body);
    assert!(publish.body["published_at"].is_string());
    assert!(publish.body["operation_id"].is_string());

    let live = Call::new("GET", format!("/api/v1/orgs/{org_id}/forms/{form_id}"))
        .signed_in_as(cookie)
        .send(&router)
        .await;
    assert_eq!(live.body["live_version_id"], form["versions"][0]["id"]);

    // Frozen: a PUT is 409 whatever the ETag says.
    let frozen = Call::new("PUT", &path)
        .signed_in_as(cookie)
        .if_match("*")
        .body(json!({ "questions": edited }))
        .send(&router)
        .await;
    assert_eq!(frozen.status, StatusCode::CONFLICT, "{:?}", frozen.body);

    let versions = format!("/api/v1/orgs/{org_id}/forms/{form_id}/versions");
    let v2 = Call::new("POST", &versions)
        .signed_in_as(cookie)
        .send(&router)
        .await;
    assert_eq!(v2.status, StatusCode::CREATED, "{:?}", v2.body);
    assert_eq!(v2.body["version"], 2);
    assert_eq!(v2.body["published_at"], Value::Null);
    assert_eq!(v2.body["questions"].as_array().map(Vec::len), Some(10));
    assert_eq!(v2.body["privacy_notice_version"], "2026-09");

    let again = Call::new("POST", &versions)
        .signed_in_as(cookie)
        .send(&router)
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT, "{:?}", again.body);

    // `{v}` also takes the version number.
    let by_number = Call::new("GET", format!("{versions}/2"))
        .signed_in_as(cookie)
        .send(&router)
        .await;
    assert_eq!(by_number.status, StatusCode::OK, "{:?}", by_number.body);
    assert_eq!(by_number.body["id"], v2.body["id"]);

    // Published once, so it cannot be deleted.
    let delete = Call::new("DELETE", format!("/api/v1/orgs/{org_id}/forms/{form_id}"))
        .signed_in_as(cookie)
        .if_match(&live.etag())
        .send(&router)
        .await;
    assert_eq!(delete.status, StatusCode::CONFLICT, "{:?}", delete.body);
}

#[tokio::test]
async fn put_names_each_problem_by_position() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let form = create_form(&router, org_id, &cookie, json!({})).await;
    let path = version_path(org_id, &form);
    let (mut questions, etag) = read_draft(&router, &path, &cookie).await;

    // A second first_name, an availability on a pool form, a label with no
    // French, and a required pool-retention consent.
    questions.push(json!({
        "kind": "short_text", "target_path": "volunteer.first_name",
        "label": { "fr": "Encore ?" }
    }));
    questions.push(json!({ "kind": "availability", "label": { "fr": "Dispos" } }));
    questions.push(json!({ "kind": "long_text", "label": { "fr": " ", "en": "Notes" } }));
    questions.push(json!({
        "kind": "consent", "consent_purpose": "pool_retention", "is_required": true,
        "label": { "fr": "Garder mes infos" }
    }));

    let put = Call::new("PUT", &path)
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(json!({ "questions": questions }))
        .send(&router)
        .await;
    assert_eq!(
        put.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        put.body
    );
    assert_eq!(
        put.body["type"],
        "https://evp.example/errors/validation-failed"
    );
    assert_eq!(
        problem_codes(&put.body),
        vec![
            (json!(7), "duplicate_target".to_owned()),
            (json!(8), "scope_required".to_owned()),
            (json!(9), "label_missing_fr".to_owned()),
            (json!(10), "pool_retention_required".to_owned()),
        ]
    );
    assert!(put.body["problems"][0]["message"].is_string());

    // Nothing was written: the ETag still matches.
    let (after, etag_after) = read_draft(&router, &path, &cookie).await;
    assert_eq!(etag_after, etag);
    assert_eq!(after.len(), 7);
}

#[tokio::test]
async fn an_unknown_kind_or_target_is_refused_before_validation() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let form = create_form(&router, org_id, &cookie, json!({})).await;
    let path = version_path(org_id, &form);
    let (_questions, etag) = read_draft(&router, &path, &cookie).await;

    for question in [
        json!({ "kind": "file_upload", "label": { "fr": "Pièce" } }),
        json!({ "kind": "date", "target_path": "volunteer.birthdate", "label": { "fr": "Né le" } }),
    ] {
        let put = Call::new("PUT", &path)
            .signed_in_as(&cookie)
            .if_match(&etag)
            .body(json!({ "questions": [question] }))
            .send(&router)
            .await;
        assert_eq!(
            put.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{:?}",
            put.body
        );
        assert_eq!(
            put.body["type"],
            "https://evp.example/errors/invalid-request"
        );
    }
}

#[tokio::test]
async fn publish_lists_what_is_missing() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let form = create_form(&router, org_id, &cookie, json!({})).await;
    let path = version_path(org_id, &form);
    let (questions, etag) = read_draft(&router, &path, &cookie).await;

    // Drop both consents and make first_name optional.
    let mut edited: Vec<Value> = questions
        .into_iter()
        .filter(|question| question["kind"] != "consent")
        .collect();
    edited[1]["is_required"] = json!(false);
    let put = Call::new("PUT", &path)
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(json!({ "questions": edited }))
        .send(&router)
        .await;
    assert_eq!(
        put.status,
        StatusCode::OK,
        "a draft need not be publishable: {:?}",
        put.body
    );

    let publish = Call::new("POST", format!("{path}/publish"))
        .signed_in_as(&cookie)
        .if_match(&put.etag())
        .send(&router)
        .await;
    assert_eq!(
        publish.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        publish.body
    );
    assert_eq!(
        problem_codes(&publish.body),
        vec![
            (Value::Null, "processing_consent_missing".to_owned()),
            (Value::Null, "commitment_missing".to_owned()),
            (json!(1), "first_name_optional".to_owned()),
        ]
    );

    // Still a draft.
    let read = Call::new("GET", &path)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(read.body["published_at"], Value::Null);
}

#[tokio::test]
async fn publish_refuses_a_mission_the_scope_no_longer_has_and_an_english_gap() {
    let pool = pool().await;
    let router = router(pool.clone());
    let scope = festival_with_missions(&router, &pool).await;
    let org_id = scope.org_id;
    let cookie = scope.cookie.as_str();
    let form = create_form(
        &router,
        org_id,
        cookie,
        json!({ "festival_id": scope.festival_id }),
    )
    .await;
    let form_id = str_at(&form, "/id").to_owned();
    let path = version_path(org_id, &form);
    let (mut questions, etag) = read_draft(&router, &path, cookie).await;

    questions[6]["options"] = json!([
        { "value": "bar", "label": { "fr": "Bar" } },
        { "value": "vestiaire", "label": { "fr": "Vestiaire" } }
    ]);
    let put = Call::new("PUT", &path)
        .signed_in_as(cookie)
        .if_match(&etag)
        .body(json!({ "questions": questions }))
        .send(&router)
        .await;
    assert_eq!(put.status, StatusCode::OK, "{:?}", put.body);

    let form_path = format!("/api/v1/orgs/{org_id}/forms/{form_id}");
    let form_etag = Call::new("GET", &form_path)
        .signed_in_as(cookie)
        .send(&router)
        .await
        .etag();
    let patched = Call::new("PATCH", &form_path)
        .signed_in_as(cookie)
        .if_match(&form_etag)
        .body(json!({ "default_locale": "en", "name": "Volunteers" }))
        .send(&router)
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{:?}", patched.body);
    assert_eq!(patched.body["default_locale"], "en");
    assert_eq!(patched.body["name"], "Volunteers");
    assert!(patched.body["operation_id"].is_string());

    let publish = Call::new("POST", format!("{path}/publish"))
        .signed_in_as(cookie)
        .if_match(&put.etag())
        .send(&router)
        .await;
    assert_eq!(
        publish.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        publish.body
    );
    let codes = problem_codes(&publish.body);
    assert!(
        codes.contains(&(json!(6), "mission_option_unresolved".to_owned())),
        "{codes:?}"
    );
    assert!(
        codes.contains(&(json!(1), "label_missing_locale".to_owned())),
        "every French-only label is missing English on an English form: {codes:?}"
    );
}

#[tokio::test]
async fn writes_need_if_match() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let form = create_form(&router, org_id, &cookie, json!({})).await;
    let path = version_path(org_id, &form);
    let form_path = format!("/api/v1/orgs/{org_id}/forms/{}", str_at(&form, "/id"));

    for call in [
        Call::new("PUT", &path).body(json!({ "questions": [] })),
        Call::new("POST", format!("{path}/publish")),
        Call::new("PATCH", &form_path).body(json!({ "name": "X" })),
        Call::new("DELETE", &form_path),
    ] {
        let answer = call.signed_in_as(&cookie).send(&router).await;
        assert_eq!(
            answer.status,
            StatusCode::PRECONDITION_REQUIRED,
            "{:?}",
            answer.body
        );
    }
}

#[tokio::test]
async fn a_never_published_form_deletes_with_an_operation_id() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let form = create_form(&router, org_id, &cookie, json!({})).await;
    let form_path = format!("/api/v1/orgs/{org_id}/forms/{}", str_at(&form, "/id"));

    let deleted = Call::new("DELETE", &form_path)
        .signed_in_as(&cookie)
        .if_match(&format!("\"{}\"", form["version"]))
        .send(&router)
        .await;
    assert_eq!(deleted.status, StatusCode::OK, "{:?}", deleted.body);
    assert!(deleted.body["operation_id"].is_string());

    let gone = Call::new("GET", &form_path)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn creating_refuses_two_scopes_a_bad_slug_and_a_taken_one() {
    let pool = pool().await;
    let router = router(pool.clone());
    let scope = festival_with_missions(&router, &pool).await;
    let path = format!("/api/v1/orgs/{}/forms", scope.org_id);

    let both = Call::new("POST", &path)
        .signed_in_as(&scope.cookie)
        .body(json!({
            "name": "Both", "slug": "both",
            "festival_id": scope.festival_id, "event_id": Uuid::now_v7().to_string()
        }))
        .send(&router)
        .await;
    assert_eq!(
        both.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        both.body
    );

    let bad_slug = Call::new("POST", &path)
        .signed_in_as(&scope.cookie)
        .body(json!({ "name": "Bad", "slug": "Pas un slug" }))
        .send(&router)
        .await;
    assert_eq!(
        bad_slug.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        bad_slug.body
    );

    let unknown = Call::new("POST", &path)
        .signed_in_as(&scope.cookie)
        .body(
            json!({ "name": "Nowhere", "slug": "nowhere", "event_id": Uuid::now_v7().to_string() }),
        )
        .send(&router)
        .await;
    assert_eq!(
        unknown.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        unknown.body
    );

    let first = Call::new("POST", &path)
        .signed_in_as(&scope.cookie)
        .body(json!({ "name": "One", "slug": "taken" }))
        .send(&router)
        .await;
    assert_eq!(first.status, StatusCode::CREATED, "{:?}", first.body);
    let second = Call::new("POST", &path)
        .signed_in_as(&scope.cookie)
        .body(json!({ "name": "Two", "slug": "taken" }))
        .send(&router)
        .await;
    assert_eq!(second.status, StatusCode::CONFLICT, "{:?}", second.body);

    let listed = Call::new("GET", format!("{path}?festival={}", scope.festival_id))
        .signed_in_as(&scope.cookie)
        .send(&router)
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{:?}", listed.body);
    assert_eq!(listed.body["data"].as_array().map(Vec::len), Some(0));
    let all = Call::new("GET", &path)
        .signed_in_as(&scope.cookie)
        .send(&router)
        .await;
    assert_eq!(all.body["data"].as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn zone_leads_are_forbidden_and_other_orgs_see_nothing() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let form = create_form(&router, org_id, &cookie, json!({})).await;
    let form_path = format!("/api/v1/orgs/{org_id}/forms/{}", str_at(&form, "/id"));

    let zone_lead = add_member(&pool, org_id, "zone_lead").await;
    for path in [format!("/api/v1/orgs/{org_id}/forms"), form_path.clone()] {
        let answer = Call::new("GET", &path)
            .signed_in_as(&zone_lead)
            .send(&router)
            .await;
        assert_eq!(
            answer.status,
            StatusCode::FORBIDDEN,
            "{path}: {:?}",
            answer.body
        );
    }

    let owner = add_member(&pool, org_id, "owner").await;
    let answer = Call::new("GET", &form_path)
        .signed_in_as(&owner)
        .send(&router)
        .await;
    assert_eq!(answer.status, StatusCode::OK, "{:?}", answer.body);

    // A coordinator of another org naming their own org and this form's id.
    let (other_org, other_cookie) = seed_member(&pool, "coordinator").await;
    let answer = Call::new(
        "GET",
        format!("/api/v1/orgs/{other_org}/forms/{}", str_at(&form, "/id")),
    )
    .signed_in_as(&other_cookie)
    .send(&router)
    .await;
    assert_eq!(answer.status, StatusCode::NOT_FOUND, "{:?}", answer.body);
}
