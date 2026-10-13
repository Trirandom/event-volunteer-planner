// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `GET /api/v1/public/forms/{slug}` and `POST …/submissions` — the volunteer
//! form, with no session (docs/04 §"Public and unauthenticated", docs/09).
//!
//! Driven through the real router as `evp_api`, like every suite here. The
//! shape asserted is `apps/form/src/api/publicForm.ts`'s schema, which is the
//! contract the bundle parses; the statuses are docs/04's. Every form here is
//! set up the way a coordinator would — festival, event, missions, form,
//! publish — through the authenticated API, so what is served is what the
//! admin app would have produced.

mod support;

use axum::Router;
use axum::http::{StatusCode, header};
use serde_json::{Value, json};
use sqlx::Row as _;
use support::{Call, create_event_body, pool, router, seed_member};
use uuid::Uuid;

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// A coordinator's published festival form, and what a test needs of it.
struct Live {
    org_id: Uuid,
    cookie: String,
    form_id: String,
    slug: String,
    version_id: String,
    festival_id: String,
    event_id: String,
    questions: Vec<Value>,
}

impl Live {
    fn question_id(&self, pick: impl Fn(&Value) -> bool) -> String {
        self.questions
            .iter()
            .find(|question| pick(question))
            .map(|question| str_at(question, "/id").to_owned())
            .unwrap_or_default()
    }

    fn by_target(&self, target: &str) -> String {
        self.question_id(|question| question["target_path"] == target)
    }

    fn get(&self) -> String {
        format!("/api/v1/public/forms/{}", self.slug)
    }

    fn post(&self) -> String {
        format!("/api/v1/public/forms/{}/submissions", self.slug)
    }

    /// What the coordinator's submissions page reads.
    fn submissions(&self) -> String {
        format!(
            "/api/v1/orgs/{}/festivals/{}/submissions",
            self.org_id, self.festival_id
        )
    }

    fn label(&self, id: &str) -> String {
        self.questions
            .iter()
            .find(|question| str_at(question, "/id") == id)
            .map(|question| str_at(question, "/label/fr").to_owned())
            .unwrap_or_default()
    }

    /// A submission the version accepts: every required answer, every consent
    /// given, one available range inside the event, and a solved captcha
    /// from a fresh load of the form — as the bundle does it.
    async fn valid_body(&self, router: &Router) -> Value {
        let mut body = self.answers_body();
        let captcha = self.solved_captcha(router).await;
        if let Some(fields) = body.as_object_mut() {
            fields.insert("captcha".to_owned(), captcha);
        }
        body
    }

    /// Loads the form and solves the challenge it came with.
    async fn solved_captcha(&self, router: &Router) -> Value {
        let served = Call::new("GET", self.get()).send(router).await;
        if served.status != StatusCode::OK {
            // A form that is not served has no challenge; the submission is
            // a 404 before the captcha is read, which is what such a test
            // asserts.
            return Value::Null;
        }
        let challenge = served.body.get("captcha").cloned().unwrap_or_default();
        let number = evp_domain::captcha::solve(
            str_at(&challenge, "/salt"),
            str_at(&challenge, "/challenge"),
            challenge
                .get("maxnumber")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        );
        json!({
            "challenge": str_at(&challenge, "/challenge"),
            "salt": str_at(&challenge, "/salt"),
            "number": number,
            "signature": str_at(&challenge, "/signature"),
        })
    }

    fn answers_body(&self) -> Value {
        let mut answers = serde_json::Map::new();
        for question in &self.questions {
            let id = str_at(question, "/id").to_owned();
            let value = match str_at(question, "/kind") {
                "consent" => json!(true),
                "missions" | "multi_choice" => json!([]),
                "email" => json!("ada@example.org"),
                "short_text" if question["target_path"] == "volunteer.first_name" => json!("Ada"),
                "short_text" | "long_text" | "phone" | "date" => json!(""),
                _ => continue,
            };
            answers.insert(id, value);
        }
        json!({
            "form_version_id": self.version_id,
            "locale": "fr",
            "answers": answers,
            "availability": [{
                "event_id": self.event_id,
                "kind": "available",
                "start": "2026-07-04T08:00:00Z",
                "end": "2026-07-04T14:00:00Z"
            }],
            "website": "",
            "elapsed_ms": 45_000
        })
    }
}

/// Festival → event (4–7 July, Europe/Paris) → a zone and a post → a
/// festival form → its seeded draft published.
async fn live_form(router: &Router, pool: &sqlx::PgPool) -> Live {
    let slug = format!("benevoles-{}", Uuid::now_v7().simple());
    let (live, publish) = publish_form(router, pool, &slug).await;
    assert_eq!(publish.status, StatusCode::OK, "{:?}", publish.body);
    live
}

/// [`live_form`]'s setup with a chosen slug, handing back the publish
/// response for a test that expects it to be refused.
async fn publish_form(router: &Router, pool: &sqlx::PgPool, slug: &str) -> (Live, support::Answer) {
    publish_form_with(router, pool, slug, None).await
}

/// [`publish_form`], with `zone_patch` sent to the zone after the draft is
/// seeded and before it is published. That is when a coordinator who seeds
/// the form first and reviews the missions afterwards would change it.
async fn publish_form_with(
    router: &Router,
    pool: &sqlx::PgPool,
    slug: &str,
    zone_patch: Option<Value>,
) -> (Live, support::Answer) {
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

    let form = Call::new("POST", format!("/api/v1/orgs/{org_id}/forms"))
        .signed_in_as(&cookie)
        .body(json!({ "name": "Bénévoles", "slug": slug, "festival_id": festival_id }))
        .send(router)
        .await;
    assert_eq!(form.status, StatusCode::CREATED, "{:?}", form.body);
    let form_id = str_at(&form.body, "/id").to_owned();
    let version_id = str_at(&form.body, "/versions/0/id").to_owned();

    if let Some(patch) = zone_patch {
        let zone_url = format!("{locations}/{}", str_at(&zone.body, "/location/id"));
        let patched = Call::new("PATCH", &zone_url)
            .signed_in_as(&cookie)
            .if_match(&zone.etag())
            .body(patch)
            .send(router)
            .await;
        assert_eq!(patched.status, StatusCode::OK, "{:?}", patched.body);
    }

    let path = format!("/api/v1/orgs/{org_id}/forms/{form_id}/versions/{version_id}");
    let draft = Call::new("GET", &path)
        .signed_in_as(&cookie)
        .send(router)
        .await;
    assert_eq!(draft.status, StatusCode::OK, "{:?}", draft.body);
    let publish = Call::new("POST", format!("{path}/publish"))
        .signed_in_as(&cookie)
        .if_match(&draft.etag())
        .send(router)
        .await;

    let live = Live {
        org_id,
        cookie,
        form_id,
        slug: slug.to_owned(),
        version_id,
        festival_id,
        event_id,
        questions: publish
            .body
            .get("questions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    };
    (live, publish)
}

/// `(state, errors)` of every submission stored against the live version,
/// read back as `evp_api` in the form's organisation.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a read that fails is a broken test, not a runtime case"
)]
async fn stored(pool: &sqlx::PgPool, live: &Live) -> Vec<(String, Option<Value>, Value)> {
    let mut tx = pool.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(live.org_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("scope");
    let version: Uuid = live.version_id.parse().expect("a version id");
    let rows = sqlx::query(
        "SELECT s.state::text AS state, s.errors, p.raw \
           FROM submissions s JOIN submission_payloads p ON p.submission_id = s.id \
          WHERE s.form_version_id = $1 ORDER BY s.id",
    )
    .bind(version)
    .fetch_all(&mut *tx)
    .await
    .expect("read submissions");
    rows.iter()
        .map(|row| (row.get("state"), row.get("errors"), row.get("raw")))
        .collect()
}

#[tokio::test]
async fn the_live_version_is_served_in_the_shape_the_bundle_parses() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    // No cookie: this is a stranger on the internet.
    let served = Call::new("GET", live.get()).send(&router).await;
    assert_eq!(served.status, StatusCode::OK, "{:?}", served.body);
    assert_eq!(
        served
            .headers
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    let body = &served.body;
    assert_eq!(
        body["form"],
        json!({ "slug": live.slug, "name": "Bénévoles", "default_locale": "fr" })
    );
    assert_eq!(body["version"]["id"], json!(live.version_id));
    assert_eq!(body["version"]["version"], 1);
    assert_eq!(body["version"]["privacy_notice_version"], Value::Null);
    assert_eq!(body["prefill"], Value::Null);

    let questions = body["version"]["questions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ids: Vec<&str> = questions.iter().map(|q| str_at(q, "/id")).collect();
    let admin_ids: Vec<&str> = live.questions.iter().map(|q| str_at(q, "/id")).collect();
    assert_eq!(ids, admin_ids, "every question, in position order");
    for question in &questions {
        let mut keys: Vec<&str> = question
            .as_object()
            .map(|fields| fields.keys().map(String::as_str).collect())
            .unwrap_or_default();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "consent_purpose",
                "help_text",
                "id",
                "is_required",
                "is_sensitive",
                "kind",
                "label",
                "options",
                "target_path"
            ],
            "no position, builtin or skill ids: {question:?}"
        );
    }
    let missions = questions
        .iter()
        .find(|q| q["kind"] == "missions")
        .expect("the seeded missions question");
    assert_eq!(
        missions["options"],
        json!([
            {
                "value": "bar", "label": { "fr": "Bar" },
                "checked_by_default": true, "adults_only": false
            },
            {
                "value": "site", "label": { "fr": "Site" },
                "checked_by_default": true, "adults_only": false
            }
        ])
    );

    assert_eq!(
        body["events"],
        json!([{
            "id": live.event_id,
            "name": "Open Air",
            "timezone": "Europe/Paris",
            "period": { "start": "2026-07-04T06:00:00Z", "end": "2026-07-07T06:00:00Z" },
            "public_period": null,
            "availability_step_minutes": 30,
            "slot_options": []
        }])
    );

    // Token links are not built: `?t=` changes nothing, in either direction.
    let with_token = Call::new("GET", format!("{}?t=anything", live.get()))
        .send(&router)
        .await;
    assert_eq!(with_token.status, StatusCode::OK);
    // Everything but the captcha, which is fresh on every load (ADR-0043).
    let without_captcha = |body: &Value| {
        let mut body = body.clone();
        if let Some(fields) = body.as_object_mut() {
            fields.remove("captcha");
        }
        body
    };
    assert_eq!(
        without_captcha(&with_token.body),
        without_captcha(&served.body)
    );
}

/// A zone flagged after the draft was seeded is served flagged. Publishing
/// stamps the flags from the zones as they are then, not from the seed. The
/// zone's post ("Bar") carries its zone's flags, and an adults-only mission is
/// never pre-ticked, whatever `checked_by_default` says.
#[tokio::test]
async fn zone_flags_set_before_publishing_are_served_on_its_missions() {
    let pool = pool().await;
    let router = router(pool.clone());
    let slug = format!("benevoles-{}", Uuid::now_v7().simple());
    let (live, publish) = publish_form_with(
        &router,
        &pool,
        &slug,
        Some(json!({ "checked_by_default": true, "adults_only": true })),
    )
    .await;
    assert_eq!(publish.status, StatusCode::OK, "{:?}", publish.body);

    let served = Call::new("GET", format!("/api/v1/public/forms/{}", live.slug))
        .send(&router)
        .await;
    assert_eq!(served.status, StatusCode::OK, "{:?}", served.body);
    let missions = served.body["version"]["questions"]
        .as_array()
        .and_then(|questions| questions.iter().find(|q| q["kind"] == "missions"))
        .cloned()
        .unwrap_or_default();
    let flags: Vec<(&str, &Value, &Value)> = missions["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .map(|o| {
                    (
                        str_at(o, "/value"),
                        &o["checked_by_default"],
                        &o["adults_only"],
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        flags,
        vec![
            ("bar", &json!(false), &json!(true)),
            ("site", &json!(false), &json!(true)),
        ]
    );
}

#[tokio::test]
async fn an_unknown_slug_a_draft_and_a_closed_form_are_one_indistinguishable_404() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let unknown = Call::new(
        "GET",
        format!("/api/v1/public/forms/nope-{}", Uuid::now_v7().simple()),
    )
    .send(&router)
    .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(
        unknown
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/problem+json")
    );

    // A draft-only form in the same organisation.
    let draft_slug = format!("brouillon-{}", Uuid::now_v7().simple());
    let draft = Call::new("POST", format!("/api/v1/orgs/{}/forms", live.org_id))
        .signed_in_as(&live.cookie)
        .body(json!({ "name": "Brouillon", "slug": draft_slug }))
        .send(&router)
        .await;
    assert_eq!(draft.status, StatusCode::CREATED, "{:?}", draft.body);
    let unpublished = Call::new("GET", format!("/api/v1/public/forms/{draft_slug}"))
        .send(&router)
        .await;
    assert_eq!(unpublished.status, StatusCode::NOT_FOUND);
    assert_eq!(unpublished.body, unknown.body);

    // The live one, with its public route closed.
    let form_path = format!("/api/v1/orgs/{}/forms/{}", live.org_id, live.form_id);
    let read = Call::new("GET", &form_path)
        .signed_in_as(&live.cookie)
        .send(&router)
        .await;
    let close = Call::new("PATCH", &form_path)
        .signed_in_as(&live.cookie)
        .if_match(&read.etag())
        .body(json!({ "public_open": false }))
        .send(&router)
        .await;
    assert_eq!(close.status, StatusCode::OK, "{:?}", close.body);
    let closed = Call::new("GET", live.get()).send(&router).await;
    assert_eq!(closed.status, StatusCode::NOT_FOUND);
    assert_eq!(closed.body, unknown.body);
    let refused = Call::new("POST", live.post())
        .body(live.valid_body(&router).await)
        .send(&router)
        .await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND);
    assert_eq!(refused.body, unknown.body);
    assert!(stored(&pool, &live).await.is_empty());
}

#[tokio::test]
async fn a_valid_submission_is_accepted_stored_and_applied() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let sent = Call::new("POST", live.post())
        .body(live.valid_body(&router).await)
        .send(&router)
        .await;
    assert_eq!(sent.status, StatusCode::ACCEPTED, "{:?}", sent.body);
    assert_eq!(sent.body, Value::Null, "202 carries no body");

    let rows = stored(&pool, &live).await;
    assert_eq!(rows.len(), 1);
    let (state, errors, raw) = &rows[0];
    assert_eq!(
        state, "applied",
        "reconciled on the same transaction (ADR-0042)"
    );
    assert_eq!(*errors, None);
    assert_eq!(
        raw["answers"][live.by_target("volunteer.first_name")],
        "Ada"
    );
    assert_eq!(raw["availability"][0]["event_id"], json!(live.event_id));
    assert!(raw.get("website").is_none(), "the honeypot is not kept");
}

/// The bug this pipeline closes: a volunteer sent the form and the
/// coordinator's submissions page never showed it.
#[tokio::test]
async fn a_submission_appears_on_the_coordinators_submissions_page() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let sent = Call::new("POST", live.post())
        .body(live.valid_body(&router).await)
        .send(&router)
        .await;
    assert_eq!(sent.status, StatusCode::ACCEPTED, "{:?}", sent.body);

    let listed = Call::new("GET", live.submissions())
        .signed_in_as(&live.cookie)
        .send(&router)
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{:?}", listed.body);
    let submissions = listed.body["submissions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(submissions.len(), 1, "{:?}", listed.body);
    let submission = &submissions[0];
    assert_eq!(submission["display_name"], "Ada");
    assert_eq!(submission["first_name"], "Ada");
    assert!(
        submission.get("last_name").is_none(),
        "left blank, so absent"
    );

    let answers: Vec<(&str, &str)> = submission["answers"]
        .as_array()
        .map(|answers| {
            answers
                .iter()
                .map(|answer| (str_at(answer, "/question"), str_at(answer, "/value")))
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        answers,
        vec![
            (
                live.label(&live.by_target("volunteer.first_name")).as_str(),
                "Ada"
            ),
            (
                live.label(&live.by_target("volunteer.email")).as_str(),
                "ada@example.org"
            ),
        ],
        "in the form's order, labelled, without blanks, consents or availability"
    );

    let windows = submission["availability"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(windows.len(), 1, "{windows:?}");
    assert_eq!(windows[0]["event_id"], json!(live.event_id));
    let start: jiff::Timestamp = str_at(&windows[0], "/start").parse().expect("RFC 3339");
    let end: jiff::Timestamp = str_at(&windows[0], "/end").parse().expect("RFC 3339");
    assert_eq!(
        start,
        "2026-07-04T08:00:00Z"
            .parse::<jiff::Timestamp>()
            .expect("instant")
    );
    assert_eq!(
        end,
        "2026-07-04T14:00:00Z"
            .parse::<jiff::Timestamp>()
            .expect("instant")
    );
}

/// docs/08 §8: sending the form again revises the volunteer rather than
/// adding a second one, and the page shows what they said last.
#[tokio::test]
async fn sending_the_form_again_replaces_the_first_answer() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let sent = Call::new("POST", live.post())
        .body(live.valid_body(&router).await)
        .send(&router)
        .await;
    assert_eq!(sent.status, StatusCode::ACCEPTED, "{:?}", sent.body);

    let mut again = live.valid_body(&router).await;
    again["answers"][live.by_target("volunteer.email")] = json!(" ADA@example.org ");
    again["answers"][live.by_target("volunteer.phone")] = json!("06 12 34 56 78");
    again["availability"][0]["start"] = json!("2026-07-05T08:00:00Z");
    again["availability"][0]["end"] = json!("2026-07-05T12:00:00Z");
    let sent = Call::new("POST", live.post())
        .body(again)
        .send(&router)
        .await;
    assert_eq!(sent.status, StatusCode::ACCEPTED, "{:?}", sent.body);

    let states: Vec<String> = stored(&pool, &live)
        .await
        .into_iter()
        .map(|(state, _, _)| state)
        .collect();
    assert_eq!(states, vec!["superseded", "applied"]);

    let listed = Call::new("GET", live.submissions())
        .signed_in_as(&live.cookie)
        .send(&router)
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{:?}", listed.body);
    let submissions = listed.body["submissions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(submissions.len(), 1, "one person, once: {:?}", listed.body);
    let windows = submissions[0]["availability"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        windows.len(),
        1,
        "the first answer's window is replaced: {windows:?}"
    );
    let start: jiff::Timestamp = str_at(&windows[0], "/start").parse().expect("RFC 3339");
    assert_eq!(
        start,
        "2026-07-05T08:00:00Z"
            .parse::<jiff::Timestamp>()
            .expect("instant")
    );
    assert!(
        submissions[0]["answers"]
            .as_array()
            .is_some_and(|answers| answers
                .iter()
                .any(|answer| answer["value"] == "06 12 34 56 78")),
        "{:?}",
        submissions[0]["answers"]
    );
}

#[tokio::test]
async fn a_version_that_is_no_longer_live_is_a_conflict() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let mut body = live.valid_body(&router).await;
    body["form_version_id"] = json!(Uuid::now_v7().to_string());
    let stale = Call::new("POST", live.post())
        .body(body)
        .send(&router)
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT, "{:?}", stale.body);
    assert_eq!(
        str_at(&stale.body, "/type"),
        "https://evp.example/errors/conflict",
        "not `…/email-in-use`, which the bundle reads as something else"
    );
    assert!(stored(&pool, &live).await.is_empty());
}

#[tokio::test]
async fn an_unacceptable_submission_is_refused_field_by_field() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;
    let first_name = live.by_target("volunteer.first_name");
    let email = live.by_target("volunteer.email");
    let processing = live.question_id(|q| q["consent_purpose"] == "processing");

    let mut body = live.valid_body(&router).await;
    body["answers"][&first_name] = json!("  ");
    body["answers"][&email] = json!("ada-at-example");
    body["answers"][&processing] = json!(false);
    body["availability"] = json!([
        {
            "event_id": live.event_id, "kind": "available",
            "start": "2026-07-03T08:00:00Z", "end": "2026-07-04T08:00:00Z"
        },
        {
            "event_id": Uuid::now_v7().to_string(), "kind": "available",
            "start": "2026-07-04T08:00:00Z", "end": "2026-07-04T09:00:00Z"
        },
        {
            "event_id": live.event_id, "kind": "available",
            "start": "tomorrow", "end": "2026-07-04T09:00:00Z"
        }
    ]);
    let refused = Call::new("POST", live.post())
        .body(body)
        .send(&router)
        .await;
    assert_eq!(
        refused.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        refused.body
    );
    assert_eq!(
        str_at(&refused.body, "/type"),
        "https://evp.example/errors/validation-failed"
    );
    assert_eq!(
        refused.body["errors"],
        json!({
            format!("answers.{first_name}"): ["required"],
            format!("answers.{email}"): ["invalid_email"],
            format!("answers.{processing}"): ["consent_required"],
            "availability[0]": ["outside_event"],
            "availability[1]": ["unknown_event"],
            "availability[2]": ["invalid_instant"],
        })
    );
    assert!(stored(&pool, &live).await.is_empty());
}

#[tokio::test]
async fn a_filled_honeypot_is_accepted_and_nothing_is_kept() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let mut body = live.valid_body(&router).await;
    body["website"] = json!("https://cheap-watches.example");
    let sent = Call::new("POST", live.post())
        .body(body)
        .send(&router)
        .await;
    assert_eq!(sent.status, StatusCode::ACCEPTED, "{:?}", sent.body);
    assert_eq!(sent.body, Value::Null);
    assert!(stored(&pool, &live).await.is_empty());

    // Even an otherwise invalid one: the bot is told nothing about why.
    let mut junk = live.valid_body(&router).await;
    junk["website"] = json!("x");
    junk["answers"] = json!({ "nope": 42 });
    let sent = Call::new("POST", live.post())
        .body(junk)
        .send(&router)
        .await;
    assert_eq!(sent.status, StatusCode::ACCEPTED);
    assert!(stored(&pool, &live).await.is_empty());
}

#[tokio::test]
async fn a_submission_faster_than_the_timing_floor_is_held_for_review() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let mut body = live.valid_body(&router).await;
    body["elapsed_ms"] = json!(2_999);
    let sent = Call::new("POST", live.post())
        .body(body)
        .send(&router)
        .await;
    assert_eq!(sent.status, StatusCode::ACCEPTED, "{:?}", sent.body);

    let mut body = live.valid_body(&router).await;
    body["elapsed_ms"] = json!(3_000);
    let sent = Call::new("POST", live.post())
        .body(body)
        .send(&router)
        .await;
    assert_eq!(sent.status, StatusCode::ACCEPTED, "{:?}", sent.body);

    let rows = stored(&pool, &live).await;
    let states: Vec<&str> = rows.iter().map(|(state, _, _)| state.as_str()).collect();
    assert_eq!(
        states,
        vec!["needs_review", "applied"],
        "a held submission is not reconciled, whoever it turns out to be"
    );
    assert_eq!(
        rows[0].1.as_ref().map(|errors| errors[0]["code"].clone()),
        Some(json!("too_fast"))
    );
}

#[tokio::test]
async fn a_second_organisation_cannot_publish_a_slug_already_served() {
    let pool = pool().await;
    let router = router(pool.clone());
    let first = live_form(&router, &pool).await;

    let (second, refused) = publish_form(&router, &pool, &first.slug).await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{:?}", refused.body);
    assert_eq!(
        str_at(&refused.body, "/type"),
        "https://evp.example/errors/conflict"
    );
    assert!(
        !str_at(&refused.body, "/detail").contains(&first.org_id.to_string()),
        "the refusal names nobody"
    );

    // The URL still reaches the first organisation's form, untouched.
    let served = Call::new("GET", first.get()).send(&router).await;
    assert_eq!(served.status, StatusCode::OK);
    assert_eq!(served.body["version"]["id"], json!(first.version_id));
    assert_ne!(second.org_id, first.org_id);
}

/// The review page's journey: a submission the timing floor held waits in the
/// queue, a coordinator lets the ladder run, and it joins the submissions
/// page. Resolving it twice is a conflict, not a second volunteer.
#[tokio::test]
async fn a_held_submission_is_reviewed_into_the_submissions_page() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let mut body = live.valid_body(&router).await;
    body["elapsed_ms"] = json!(1_000);
    let sent = Call::new("POST", live.post())
        .body(body)
        .send(&router)
        .await;
    assert_eq!(sent.status, StatusCode::ACCEPTED, "{:?}", sent.body);

    let queue_url = format!(
        "/api/v1/orgs/{}/intake/submissions?state=needs_review",
        live.org_id
    );
    let queue = Call::new("GET", &queue_url)
        .signed_in_as(&live.cookie)
        .send(&router)
        .await;
    assert_eq!(queue.status, StatusCode::OK, "{:?}", queue.body);
    let items = queue.body["submissions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(items.len(), 1, "{:?}", queue.body);
    assert_eq!(items[0]["claimed"]["display_name"], "Ada");
    assert_eq!(items[0]["reasons"][0]["code"], "too_fast");
    let id = str_at(&items[0], "/id").to_owned();

    let unauthenticated = Call::new("GET", &queue_url).send(&router).await;
    assert_eq!(unauthenticated.status, StatusCode::UNAUTHORIZED);

    let resolve_url = format!(
        "/api/v1/orgs/{}/intake/submissions/{id}/resolve",
        live.org_id
    );
    let resolved = Call::new("POST", &resolve_url)
        .signed_in_as(&live.cookie)
        .body(json!({ "action": "reconcile" }))
        .send(&router)
        .await;
    assert_eq!(resolved.status, StatusCode::OK, "{:?}", resolved.body);
    assert_eq!(resolved.body["state"], "applied");
    assert_eq!(resolved.body["match_kind"], "new");
    assert!(resolved.body["operation_id"].is_string(), "ADR-0024");

    let listed = Call::new("GET", live.submissions())
        .signed_in_as(&live.cookie)
        .send(&router)
        .await;
    assert_eq!(
        listed.body["submissions"].as_array().map(Vec::len),
        Some(1),
        "{:?}",
        listed.body
    );

    let again = Call::new("POST", &resolve_url)
        .signed_in_as(&live.cookie)
        .body(json!({ "action": "reject", "reason": "spam" }))
        .send(&router)
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT, "{:?}", again.body);

    let unknown = Call::new(
        "GET",
        format!("{queue_url}&state=applied").replace("?state=needs_review&", "?"),
    )
    .signed_in_as(&live.cookie)
    .send(&router)
    .await;
    assert_eq!(
        unknown.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        unknown.body
    );
}

/// ADR-0043: every load carries a fresh signed challenge.
#[tokio::test]
async fn the_form_is_served_with_a_fresh_proof_of_work() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let first = Call::new("GET", live.get()).send(&router).await;
    let second = Call::new("GET", live.get()).send(&router).await;
    let captcha = &first.body["captcha"];
    assert_eq!(captcha["algorithm"], "SHA-256");
    assert_eq!(captcha["maxnumber"], 50, "the test policy's search space");
    assert!(str_at(captcha, "/salt").contains("?expires="));
    assert_eq!(str_at(captcha, "/signature").len(), 64);
    assert_ne!(
        captcha["challenge"], second.body["captcha"]["challenge"],
        "never the same puzzle twice"
    );
}

/// A script posting straight at the route, without doing the work, is
/// refused with a type the bundle can recognise — and nothing is stored.
#[tokio::test]
async fn a_submission_without_a_valid_proof_of_work_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let mut missing = live.answers_body();
    missing["captcha"] = Value::Null;
    let mut wrong = live.valid_body(&router).await;
    let number = wrong["captcha"]["number"].as_u64().unwrap_or_default();
    wrong["captcha"]["number"] = json!(number.wrapping_add(1) % 51);
    let mut forged = live.valid_body(&router).await;
    forged["captcha"]["signature"] = json!("0".repeat(64));

    for body in [missing, wrong, forged] {
        let refused = Call::new("POST", live.post())
            .body(body)
            .send(&router)
            .await;
        assert_eq!(
            refused.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{:?}",
            refused.body
        );
        assert_eq!(
            str_at(&refused.body, "/type"),
            "https://evp.example/errors/captcha-failed"
        );
    }
    assert!(stored(&pool, &live).await.is_empty());
}

/// One solution, one submission: solving once must not buy a thousand posts.
#[tokio::test]
async fn a_solved_challenge_is_spent_by_the_submission_it_carried() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let body = live.valid_body(&router).await;
    let first = Call::new("POST", live.post())
        .body(body.clone())
        .send(&router)
        .await;
    assert_eq!(first.status, StatusCode::ACCEPTED, "{:?}", first.body);
    let replayed = Call::new("POST", live.post())
        .body(body)
        .send(&router)
        .await;
    assert_eq!(
        replayed.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        replayed.body
    );
    assert_eq!(stored(&pool, &live).await.len(), 1);
}

/// A volunteer sent back to fix an answer keeps the work already done: the
/// solution is spent only by a submission that is stored.
#[tokio::test]
async fn a_refused_answer_does_not_spend_the_solution() {
    let pool = pool().await;
    let router = router(pool.clone());
    let live = live_form(&router, &pool).await;

    let good = live.valid_body(&router).await;
    let mut bad = good.clone();
    bad["answers"][live.by_target("volunteer.email")] = json!("not-an-address");
    let refused = Call::new("POST", live.post()).body(bad).send(&router).await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        str_at(&refused.body, "/type"),
        "https://evp.example/errors/validation-failed"
    );

    let fixed = Call::new("POST", live.post())
        .body(good)
        .send(&router)
        .await;
    assert_eq!(fixed.status, StatusCode::ACCEPTED, "{:?}", fixed.body);
}
