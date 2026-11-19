// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `POST …/publish/test` (ADR-0054): the whole schedule email run, rendered
//! by the server, every message sent to one address the coordinator names.
//!
//! The relay is the in-memory sink, so what is asserted is exactly what would
//! have been handed to SMTP. Who is in the run is proved against the database
//! in `crates/evp-db/tests/db/schedule.rs`; this suite proves the route's
//! half: the address, the subject, the rendering, the counts, and who may.

use std::sync::Arc;

use crate::support::{Call, add_member, create_event_body, pool, router_with_mail, seed_member};
use axum::http::StatusCode;
use evp_worker::mail::MemoryMailSender;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
fn id_at(body: &Value, pointer: &str) -> String {
    body.pointer(pointer)
        .and_then(Value::as_str)
        .expect("the API answered with an id")
        .to_owned()
}

/// An event with one zone, "Bar", and one 18:00–20:00 UTC shift on it.
async fn seed_event(
    router: &axum::Router,
    org_id: Uuid,
    cookie: &str,
    festival_id: Option<&str>,
) -> (String, String) {
    let mut body = create_event_body("Saturday");
    if let Some(festival_id) = festival_id {
        set(&mut body, "festival_id", json!(festival_id));
    }
    let event = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(cookie)
        .body(body)
        .send(router)
        .await;
    assert_eq!(event.status, StatusCode::CREATED, "{:?}", event.body);
    let event_id = id_at(&event.body, "/event/id");

    let zone = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/locations"),
    )
    .signed_in_as(cookie)
    .body(json!({ "kind": "zone", "name": "Bar" }))
    .send(router)
    .await;
    let zone_id = id_at(&zone.body, "/location/id");

    let shift = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(cookie)
    .body(json!({
        "location_id": zone_id,
        "period": { "start": "2026-07-04T18:00:00Z", "end": "2026-07-04T20:00:00Z" },
        "required_count": 2
    }))
    .send(router)
    .await;
    assert_eq!(shift.status, StatusCode::CREATED, "{:?}", shift.body);
    (event_id, id_at(&shift.body, "/shift/id"))
}

/// A volunteer enrolled on `event_id`, inserted with the GUCs the org
/// extractor sets, since no endpoint enrols anyone yet. Returns the
/// participation id.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed_volunteer(
    pool: &PgPool,
    org_id: Uuid,
    event_id: &str,
    name: &str,
    email: Option<&str>,
    notify_email: bool,
) -> String {
    let event_id: Uuid = event_id.parse().expect("a UUID");
    let volunteer_id = Uuid::now_v7();
    let participation_id = Uuid::now_v7();
    let mut tx = pool.begin().await.expect("begin fixture transaction");
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("set app.current_org_id");
    sqlx::query(
        "INSERT INTO volunteers (id, org_id, display_name, first_name, email, notify_email) \
         VALUES ($1, $2, $3, $3, $4::citext, $5)",
    )
    .bind(volunteer_id)
    .bind(org_id)
    .bind(name)
    .bind(email)
    .bind(notify_email)
    .execute(&mut *tx)
    .await
    .expect("insert volunteers row");
    sqlx::query(
        "INSERT INTO participations (id, org_id, event_id, volunteer_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(participation_id)
    .bind(org_id)
    .bind(event_id)
    .bind(volunteer_id)
    .execute(&mut *tx)
    .await
    .expect("insert participations row");
    tx.commit().await.expect("commit fixture transaction");
    participation_id.to_string()
}

fn set(body: &mut Value, field: &str, value: Value) {
    if let Some(object) = body.as_object_mut() {
        object.insert(field.to_owned(), value);
    }
}

fn request(recipient: &str) -> Value {
    json!({
        "test_recipient": recipient,
        "locale": "fr",
        "template": {
            "subject": "Tes créneaux – {{eventName|festivalName}}",
            "body_html": "<p>Bonjour {{firstName}},</p>{{assignations}}<p>{{organizationName}}</p>"
        }
    })
}

async fn send_test(
    router: &axum::Router,
    path: &str,
    cookie: &str,
    body: Value,
) -> crate::support::Answer {
    Call::new("POST", path)
        .signed_in_as(cookie)
        .body(body)
        .send(router)
        .await
}

#[tokio::test]
async fn every_reachable_message_goes_to_the_test_address_and_nowhere_else() {
    let pool = pool().await;
    let (router, sink): (axum::Router, Arc<MemoryMailSender>) = router_with_mail(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, shift_id) = seed_event(&router, org_id, &cookie, None).await;

    let aurel = seed_volunteer(
        &pool,
        org_id,
        &event_id,
        "Aurel",
        Some("aurel@example.test"),
        true,
    )
    .await;
    seed_volunteer(
        &pool,
        org_id,
        &event_id,
        "Bea",
        Some("bea@example.test"),
        true,
    )
    .await;
    seed_volunteer(
        &pool,
        org_id,
        &event_id,
        "Opted",
        Some("opted@example.test"),
        false,
    )
    .await;
    seed_volunteer(&pool, org_id, &event_id, "Nomail", None, true).await;
    let placed = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/assignments"),
    )
    .signed_in_as(&cookie)
    .body(json!({ "shift_id": shift_id, "participation_id": aurel }))
    .send(&router)
    .await;
    assert_eq!(placed.status, StatusCode::CREATED, "{:?}", placed.body);

    let answer = send_test(
        &router,
        &format!("/api/v1/orgs/{org_id}/events/{event_id}/publish/test"),
        &cookie,
        request("coordinator@example.test"),
    )
    .await;

    assert_eq!(answer.status, StatusCode::OK, "{:?}", answer.body);
    assert_eq!(answer.body["sent"], 2, "{:?}", answer.body);
    assert_eq!(answer.body["skipped_opted_out"], 1);
    assert_eq!(answer.body["no_address"], json!(["Nomail"]));
    assert_eq!(answer.body["failed"], Value::Null);

    let sent = sink.sent();
    assert_eq!(sent.len(), 2);
    assert!(
        sent.iter()
            .all(|mail| mail.to == "coordinator@example.test"),
        "a test send must never reach a volunteer: {sent:?}"
    );
    let aurel_mail = sent
        .iter()
        .find(|mail| mail.subject.starts_with("[Test: Aurel]"))
        .expect("Aurel's message says whose it is");
    assert_eq!(aurel_mail.subject, "[Test: Aurel] Tes créneaux – Saturday");
    assert!(
        aurel_mail.html.contains("Bonjour Aurel"),
        "{}",
        aurel_mail.html
    );
    assert!(aurel_mail.html.contains("Bar"), "{}", aurel_mail.html);
    assert!(aurel_mail.html.contains("Test Org"), "{}", aurel_mail.html);
    assert!(
        aurel_mail.text.contains("Bonjour Aurel"),
        "{}",
        aurel_mail.text
    );
    assert_eq!(aurel_mail.from_name.as_deref(), Some("Test Org"));

    let bea_mail = sent
        .iter()
        .find(|mail| mail.subject.starts_with("[Test: Bea]"))
        .expect("Bea, enrolled without a shift, is told so rather than skipped");
    assert!(!bea_mail.html.contains("Bar"), "{}", bea_mail.html);
}

#[tokio::test]
async fn a_festival_run_covers_its_days_and_greets_with_the_festival() {
    let pool = pool().await;
    let (router, sink) = router_with_mail(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let festival = Call::new("POST", format!("/api/v1/orgs/{org_id}/festivals"))
        .signed_in_as(&cookie)
        .body(json!({
            "name": "Soundclash",
            "slug": format!("sc-{}", Uuid::now_v7().simple()),
            "timezone": "Europe/Paris",
            "period": { "start": "2026-07-01T00:00:00Z", "end": "2026-07-10T00:00:00Z" }
        }))
        .send(&router)
        .await;
    assert_eq!(festival.status, StatusCode::CREATED, "{:?}", festival.body);
    let festival_id = id_at(&festival.body, "/festival/id");
    let (event_id, _shift) = seed_event(&router, org_id, &cookie, Some(&festival_id)).await;
    seed_volunteer(
        &pool,
        org_id,
        &event_id,
        "Aurel",
        Some("aurel@example.test"),
        true,
    )
    .await;

    let answer = send_test(
        &router,
        &format!("/api/v1/orgs/{org_id}/festivals/{festival_id}/publish/test"),
        &cookie,
        request("coordinator@example.test"),
    )
    .await;

    assert_eq!(answer.status, StatusCode::OK, "{:?}", answer.body);
    assert_eq!(answer.body["sent"], 1);
    assert_eq!(
        sink.sent()[0].subject,
        "[Test: Aurel] Tes créneaux – Soundclash"
    );
}

#[tokio::test]
async fn a_test_address_that_is_not_one_is_refused_before_anything_is_sent() {
    let pool = pool().await;
    let (router, sink) = router_with_mail(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, _shift) = seed_event(&router, org_id, &cookie, None).await;
    seed_volunteer(
        &pool,
        org_id,
        &event_id,
        "Aurel",
        Some("aurel@example.test"),
        true,
    )
    .await;
    let path = format!("/api/v1/orgs/{org_id}/events/{event_id}/publish/test");

    for bad in ["", "not an address", "two@example.test, three@example.test"] {
        let answer = send_test(&router, &path, &cookie, request(bad)).await;
        assert_eq!(
            answer.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{bad:?}: {:?}",
            answer.body
        );
    }
    let mut unknown_locale = request("coordinator@example.test");
    set(&mut unknown_locale, "locale", json!("de"));
    let answer = send_test(&router, &path, &cookie, unknown_locale).await;
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        answer.body
    );
    assert!(sink.sent().is_empty());
}

#[tokio::test]
async fn a_zone_lead_may_not_send_and_an_unknown_scope_is_not_found() {
    let pool = pool().await;
    let (router, sink) = router_with_mail(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, _shift) = seed_event(&router, org_id, &cookie, None).await;
    seed_volunteer(
        &pool,
        org_id,
        &event_id,
        "Aurel",
        Some("aurel@example.test"),
        true,
    )
    .await;
    let zone_lead = add_member(&pool, org_id, "zone_lead").await;

    let answer = send_test(
        &router,
        &format!("/api/v1/orgs/{org_id}/events/{event_id}/publish/test"),
        &zone_lead,
        request("lead@example.test"),
    )
    .await;
    assert_eq!(answer.status, StatusCode::FORBIDDEN, "{:?}", answer.body);

    let nobody = Uuid::now_v7();
    for path in [
        format!("/api/v1/orgs/{org_id}/events/{nobody}/publish/test"),
        format!("/api/v1/orgs/{org_id}/festivals/{nobody}/publish/test"),
    ] {
        let answer = send_test(&router, &path, &cookie, request("c@example.test")).await;
        assert_eq!(
            answer.status,
            StatusCode::NOT_FOUND,
            "{path}: {:?}",
            answer.body
        );
    }
    assert!(sink.sent().is_empty());
}
