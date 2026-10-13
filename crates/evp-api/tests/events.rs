// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The rest of the event lifecycle: `PATCH` under optimistic concurrency,
//! `archive`, and the owner-only `DELETE` (docs/04 §"Events, locations,
//! shifts", §4).
//!
//! The concurrency cases are the point of this file. docs/04 §1 promises three
//! distinct answers — `428` for no `If-Match`, `409` for a stale one, `200` for
//! a current one — and the failure mode being guarded against is the easy one:
//! an endpoint that accepts the write whatever the caller sent, so two
//! coordinators editing the same event silently produce whichever save landed
//! second.

mod support;

use axum::http::StatusCode;
use support::{Call, create_event_body, pool, router, seed_member};

/// Creates an event as the given member and returns `(event_id, etag)`.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
async fn seed_event(router: &axum::Router, org_id: uuid::Uuid, cookie: &str) -> (String, String) {
    let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(cookie)
        .body(create_event_body("Lifecycle Event"))
        .send(router)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    // `.pointer` rather than indexing: `clippy::indexing_slicing` is relaxed
    // inside `#[test]` bodies (clippy.toml) but not in a free helper like this
    // one, and the lint is right — a shape change here should not panic the
    // fixture, it should fail the assertion above it.
    let id = created
        .body
        .pointer("/event/id")
        .and_then(serde_json::Value::as_str)
        .expect("a created event carries a string id")
        .to_owned();

    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{id}"))
        .signed_in_as(cookie)
        .send(router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);
    (id, read.etag())
}

#[tokio::test]
async fn a_patch_without_if_match_is_refused_rather_than_overwriting_silently() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, _etag) = seed_event(&router, org_id, &cookie).await;

    let answer = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .body(serde_json::json!({ "name": "Renamed" }))
        .send(&router)
        .await;

    assert_eq!(
        answer.status,
        StatusCode::PRECONDITION_REQUIRED,
        "{:?}",
        answer.body
    );
    assert_eq!(
        answer.body["type"],
        "https://evp.example/errors/precondition-required"
    );
}

#[tokio::test]
async fn a_stale_if_match_is_a_conflict_and_the_current_one_succeeds() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, etag) = seed_event(&router, org_id, &cookie).await;
    let path = format!("/api/v1/orgs/{org_id}/events/{event_id}");

    let first = Call::new("PATCH", &path)
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(serde_json::json!({ "name": "Renamed Once" }))
        .send(&router)
        .await;
    assert_eq!(first.status, StatusCode::OK, "{:?}", first.body);
    assert_eq!(first.body["event"]["name"], "Renamed Once");
    assert!(
        first.body["operation_id"].is_string(),
        "every mutating request returns an operation id (ADR-0024): {:?}",
        first.body
    );

    // The same tag a second time: the row moved on, so this is the second
    // coordinator saving over the first, which is the case the header exists
    // to catch.
    let stale = Call::new("PATCH", &path)
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(serde_json::json!({ "name": "Renamed Twice" }))
        .send(&router)
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT, "{:?}", stale.body);
    assert_eq!(stale.body["type"], "https://evp.example/errors/conflict");

    let read = Call::new("GET", &path)
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(
        read.body["name"], "Renamed Once",
        "the refused write must not have landed"
    );
    assert_eq!(
        read.etag(),
        first.etag(),
        "the ETag on the response to a write is the one a re-read hands back"
    );
}

#[tokio::test]
async fn an_if_match_naming_a_version_that_never_existed_is_a_conflict_not_a_500() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, _etag) = seed_event(&router, org_id, &cookie).await;

    for tag in ["\"9999\"", "W/\"1\"", "not-a-tag"] {
        let answer = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
            .signed_in_as(&cookie)
            .if_match(tag)
            .body(serde_json::json!({ "name": "Nope" }))
            .send(&router)
            .await;
        assert_eq!(
            answer.status,
            StatusCode::CONFLICT,
            "If-Match {tag} should be a conflict, not {:?}",
            answer.body
        );
    }
}

#[tokio::test]
async fn if_match_star_matches_whatever_version_the_row_is_at() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, _etag) = seed_event(&router, org_id, &cookie).await;

    let answer = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match("*")
        .body(serde_json::json!({ "name": "Blind But Safe" }))
        .send(&router)
        .await;
    assert_eq!(answer.status, StatusCode::OK, "{:?}", answer.body);
}

#[tokio::test]
async fn archiving_is_coordinator_work_and_leaves_the_event_readable() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, _etag) = seed_event(&router, org_id, &cookie).await;

    let answer = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/archive"),
    )
    .signed_in_as(&cookie)
    .send(&router)
    .await;
    assert_eq!(answer.status, StatusCode::OK, "{:?}", answer.body);
    assert_eq!(answer.body["event"]["status"], "archived");

    // Archiving is not deleting: the history stays readable, which is the
    // whole reason docs/04 offers it as the honest alternative to DELETE.
    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!(read.body["status"], "archived");
}

#[tokio::test]
async fn a_zone_lead_may_read_an_event_but_not_archive_or_patch_it() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, owner_cookie) = seed_member(&pool, "owner").await;
    let (event_id, etag) = seed_event(&router, org_id, &owner_cookie).await;

    // A zone lead in the *same* org: `seed_member` makes its own org, so the
    // membership is inserted directly rather than seeding a second one.
    let lead_cookie = support::add_member(&pool, org_id, "zone_lead").await;

    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&lead_cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);

    let patched = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&lead_cookie)
        .if_match(&etag)
        .body(serde_json::json!({ "name": "Not Mine To Rename" }))
        .send(&router)
        .await;
    assert_eq!(patched.status, StatusCode::FORBIDDEN, "{:?}", patched.body);

    let archived = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/archive"),
    )
    .signed_in_as(&lead_cookie)
    .send(&router)
    .await;
    assert_eq!(
        archived.status,
        StatusCode::FORBIDDEN,
        "{:?}",
        archived.body
    );
}

#[tokio::test]
async fn deleting_an_event_is_owner_only() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, owner_cookie) = seed_member(&pool, "owner").await;
    let (event_id, etag) = seed_event(&router, org_id, &owner_cookie).await;
    let coordinator_cookie = support::add_member(&pool, org_id, "coordinator").await;
    let path = format!("/api/v1/orgs/{org_id}/events/{event_id}");

    let refused = Call::new("DELETE", &path)
        .signed_in_as(&coordinator_cookie)
        .if_match(&etag)
        .send(&router)
        .await;
    assert_eq!(
        refused.status,
        StatusCode::FORBIDDEN,
        "docs/04 §4 reserves 'Delete an event' to owners: {:?}",
        refused.body
    );

    let missing_precondition = Call::new("DELETE", &path)
        .signed_in_as(&owner_cookie)
        .send(&router)
        .await;
    assert_eq!(
        missing_precondition.status,
        StatusCode::PRECONDITION_REQUIRED,
        "{:?}",
        missing_precondition.body
    );

    let deleted = Call::new("DELETE", &path)
        .signed_in_as(&owner_cookie)
        .if_match(&etag)
        .send(&router)
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{:?}", deleted.body);

    let read = Call::new("GET", &path)
        .signed_in_as(&owner_cookie)
        .send(&router)
        .await;
    assert_eq!(read.status, StatusCode::NOT_FOUND);
}

/// The `events_period_covers_shifts` trigger (migration `…101500`), reached
/// the way a coordinator reaches it: by shrinking an event that already holds
/// shifts. It must surface as a `422` naming the problem, not as a `500`.
#[tokio::test]
async fn shrinking_an_event_away_from_its_shifts_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let example = Call::new("POST", format!("/api/v1/orgs/{org_id}/events/example"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert_eq!(example.status, StatusCode::CREATED, "{:?}", example.body);

    let listed = Call::new("GET", format!("/api/v1/orgs/{org_id}/events"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    let event_id = listed
        .body
        .pointer("/data/0/id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let read = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;

    // A minute long, well inside the event: a valid, non-empty period — so
    // what refuses it is the trigger and not `parse_period`, which is the
    // distinction this test exists to make.
    let start: jiff::Timestamp = read.body["period"]["start"]
        .as_str()
        .unwrap_or_default()
        .parse()
        .unwrap_or(jiff::Timestamp::UNIX_EPOCH);
    let end = start
        .checked_add(jiff::SignedDuration::from_mins(1))
        .unwrap_or(start);
    let answer = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&read.etag())
        .body(serde_json::json!({
            "period": { "start": start.to_string(), "end": end.to_string() }
        }))
        .send(&router)
        .await;
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "an event period that excludes its own shifts must be refused: {:?}",
        answer.body
    );
}

/// Widening an event leaves the door times alone.
///
/// This is a regression test for a rule that used to be the opposite. The
/// first version of `public_period` filled itself in: the first time `period`
/// grew, whatever it had been became the published hours. It reads plausible
/// and it is wrong — the period an event holds the moment somebody first drags
/// a bar past the end of it is a number that was still being edited, and
/// because the old rule only fired once, that accident became permanent. The
/// mission board widens events constantly (`apps/admin/src/board/edit.ts`);
/// none of those drags is a statement about when the doors open.
#[tokio::test]
async fn widening_an_event_does_not_invent_door_times() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, etag) = seed_event(&router, org_id, &cookie).await;

    // The crew starts two hours before the doors and stays two hours after.
    let widened = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(serde_json::json!({
            "period": { "start": "2026-07-04T04:00:00Z", "end": "2026-07-07T08:00:00Z" }
        }))
        .send(&router)
        .await;
    assert_eq!(widened.status, StatusCode::OK, "{:?}", widened.body);
    assert!(
        widened.body["event"].get("public_period").is_none(),
        "widening the working hours says nothing about the doors: {:?}",
        widened.body
    );

    let reread = Call::new("GET", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .send(&router)
        .await;
    assert!(
        reread.body.get("public_period").is_none(),
        "and still says nothing about them on the next read: {:?}",
        reread.body
    );
}

/// The doors are typed in, and can be taken back out.
///
/// `null` has to mean something different from omission here: "this edition
/// publishes no door times" is a decision a coordinator can reach after having
/// stated some, and a PATCH that could only ever add them would leave the
/// first guess on the event forever.
#[tokio::test]
async fn door_times_are_set_and_cleared_by_hand() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, etag) = seed_event(&router, org_id, &cookie).await;

    let doors = serde_json::json!({
        "start": "2026-07-04T18:00:00Z",
        "end": "2026-07-07T02:00:00Z"
    });
    let set = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(serde_json::json!({ "public_period": doors }))
        .send(&router)
        .await;
    assert_eq!(set.status, StatusCode::OK, "{:?}", set.body);
    assert_eq!(set.body["event"]["public_period"], doors, "{:?}", set.body);

    // Omitting the key leaves them where they are — the PATCH contract, and
    // the half a tri-state field exists to keep distinct from the next one.
    let renamed = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&set.etag())
        .body(serde_json::json!({ "name": "Still The Same Doors" }))
        .send(&router)
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{:?}", renamed.body);
    assert_eq!(
        renamed.body["event"]["public_period"], doors,
        "a rename must not disturb the doors: {:?}",
        renamed.body
    );

    let cleared = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&renamed.etag())
        .body(serde_json::json!({ "public_period": serde_json::Value::Null }))
        .send(&router)
        .await;
    assert_eq!(cleared.status, StatusCode::OK, "{:?}", cleared.body);
    assert!(
        cleared.body["event"].get("public_period").is_none(),
        "null takes the published hours back off the event: {:?}",
        cleared.body
    );
}

/// `events_public_period_valid`, through the API: the doors are open *during*
/// the event, so they cannot reach outside the operational window.
#[tokio::test]
async fn door_times_outside_the_operational_window_are_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, etag) = seed_event(&router, org_id, &cookie).await;

    // The seeded event runs 2026-07-04T06:00Z–2026-07-07T06:00Z.
    let answer = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(serde_json::json!({
            "public_period": { "start": "2026-07-04T05:00:00Z", "end": "2026-07-07T06:00:00Z" }
        }))
        .send(&router)
        .await;
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "doors before the event starts must be refused: {:?}",
        answer.body
    );
}

/// An inverted door range is refused at the edge, naming the field it came in
/// as — not as `period`, which is a different pair in the same body.
#[tokio::test]
async fn an_inverted_door_range_names_the_field_it_came_in_as() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, etag) = seed_event(&router, org_id, &cookie).await;

    let answer = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(serde_json::json!({
            "public_period": { "start": "2026-07-05T02:00:00Z", "end": "2026-07-05T01:00:00Z" }
        }))
        .send(&router)
        .await;
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        answer.body
    );
    assert!(
        answer.body["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("public_period")),
        "the refusal must say which of the body's two periods was wrong: {:?}",
        answer.body
    );
}

/// A new event takes a palette index none of its siblings hold, so a
/// festival's days are never drawn in the same colour.
#[tokio::test]
async fn a_new_event_takes_a_colour_its_siblings_are_not_using() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;

    let mut seen = Vec::new();
    for name in ["Day One", "Day Two", "Day Three"] {
        let created = Call::new("POST", format!("/api/v1/orgs/{org_id}/events"))
            .signed_in_as(&cookie)
            .body(create_event_body(name))
            .send(&router)
            .await;
        assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
        seen.push(created.body["event"]["color"].clone());
    }

    assert_eq!(
        seen,
        vec![
            serde_json::json!(0),
            serde_json::json!(1),
            serde_json::json!(2)
        ],
        "each event takes the lowest index its siblings left free: {seen:?}"
    );
}

/// The palette is 64 entries because 64 is as many as clear the contrast bar;
/// an index outside it is a `422` naming the field, not a constraint violation
/// translated out of the database.
#[tokio::test]
async fn a_colour_outside_the_palette_is_refused() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, etag) = seed_event(&router, org_id, &cookie).await;

    let answer = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(serde_json::json!({ "color": 64 }))
        .send(&router)
        .await;
    assert_eq!(
        answer.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        answer.body
    );
    assert!(
        answer.body["errors"].get("color").is_some(),
        "the refusal names the field: {:?}",
        answer.body
    );
}

/// A colour a coordinator picked is the colour the event keeps.
#[tokio::test]
async fn a_chosen_colour_survives_an_unrelated_patch() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, etag) = seed_event(&router, org_id, &cookie).await;

    let recoloured = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(serde_json::json!({ "color": 41 }))
        .send(&router)
        .await;
    assert_eq!(recoloured.status, StatusCode::OK, "{:?}", recoloured.body);
    assert_eq!(recoloured.body["event"]["color"], 41);

    let renamed = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&recoloured.etag())
        .body(serde_json::json!({ "name": "Recoloured" }))
        .send(&router)
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{:?}", renamed.body);
    assert_eq!(
        renamed.body["event"]["color"], 41,
        "an omitted colour is an unchanged colour: {:?}",
        renamed.body
    );
}

/// A shift may run past the hours the event is open to the public, and still
/// may not run past the event itself.
///
/// This is the pair the board depends on. It widens the day and then cuts the
/// slot, in that order, because `shifts_within_event_check` is
/// `INITIALLY IMMEDIATE`: the first half here is the board's second write
/// succeeding, and the second half is why the order is not a preference.
#[tokio::test]
async fn a_shift_may_run_past_the_public_hours_but_not_past_the_event() {
    let pool = pool().await;
    let router = router(pool.clone());
    let (org_id, cookie) = seed_member(&pool, "coordinator").await;
    let (event_id, etag) = seed_event(&router, org_id, &cookie).await;

    let zone = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/locations"),
    )
    .signed_in_as(&cookie)
    .body(serde_json::json!({ "kind": "zone", "name": "Site" }))
    .send(&router)
    .await;
    assert_eq!(zone.status, StatusCode::CREATED, "{:?}", zone.body);
    let location_id = zone.body["location"]["id"].as_str().unwrap_or_default();

    let widened = Call::new("PATCH", format!("/api/v1/orgs/{org_id}/events/{event_id}"))
        .signed_in_as(&cookie)
        .if_match(&etag)
        .body(serde_json::json!({
            "period": { "start": "2026-07-04T06:00:00Z", "end": "2026-07-07T08:00:00Z" }
        }))
        .send(&router)
        .await;
    assert_eq!(widened.status, StatusCode::OK, "{:?}", widened.body);

    // 06:00–08:00 on the last day: after the doors close at 06:00, inside the
    // day as it now runs. This is the slot the board creates second.
    let after_hours = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(&cookie)
    .body(serde_json::json!({
        "location_id": location_id,
        "period": { "start": "2026-07-07T06:00:00Z", "end": "2026-07-07T08:00:00Z" }
    }))
    .send(&router)
    .await;
    assert_eq!(
        after_hours.status,
        StatusCode::CREATED,
        "teardown after the public close is ordinary work: {:?}",
        after_hours.body
    );

    // An hour past the event is still refused. Widening the day is the only
    // way to put work there, which is what makes the order load-bearing.
    let outside = Call::new(
        "POST",
        format!("/api/v1/orgs/{org_id}/events/{event_id}/shifts"),
    )
    .signed_in_as(&cookie)
    .body(serde_json::json!({
        "location_id": location_id,
        "period": { "start": "2026-07-07T08:00:00Z", "end": "2026-07-07T09:00:00Z" }
    }))
    .send(&router)
    .await;
    assert_eq!(
        outside.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a shift outside its event is still refused: {:?}",
        outside.body
    );
}
