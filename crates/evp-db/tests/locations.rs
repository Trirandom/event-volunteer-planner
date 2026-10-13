// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for `evp_db::locations`, focused on the operation
//! recording ADR-0024 asks for (docs/18 §2.1): each of create/update/delete
//! must leave one `operations` row behind, in the same transaction, with an
//! `inverse` command that would actually undo it.
//!
//! Same connection discipline as `crates/evp-db/tests/catalog.rs`: one
//! transaction per test against `EVP_MIGRATION_DATABASE_URL`, never
//! committed.

use evp_db::catalog::{self, Patch, Versioned};
use evp_db::locations::{self, LocationPatch, NewLocation};
use jiff::Timestamp;
use sqlx::{PgConnection, PgPool, Row as _};
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn pool() -> PgPool {
    let url = std::env::var("EVP_MIGRATION_DATABASE_URL").expect(
        "EVP_MIGRATION_DATABASE_URL must be set to run crates/evp-db's database-backed tests; \
         `just test`/`just test-tz` set it via compose.override.yaml",
    );
    evp_db::connect(&url)
        .await
        .expect("could not connect to the test database")
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_org(conn: &mut PgConnection) -> (Uuid, Uuid) {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    let suffix = Uuid::now_v7().simple().to_string();

    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *conn)
        .await
        .expect("set app.current_org_id");
    sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *conn)
        .await
        .expect("set app.current_user_id");
    sqlx::query("SELECT set_config('app.current_role', 'owner', true)")
        .execute(&mut *conn)
        .await
        .expect("set app.current_role");

    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2::citext, 'Test Org')")
        .bind(org_id)
        .bind(format!("test-{suffix}"))
        .execute(&mut *conn)
        .await
        .expect("insert organizations row");
    sqlx::query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, 'Test Owner')",
    )
    .bind(user_id)
    .bind(format!("{suffix}@example.test"))
    .execute(&mut *conn)
    .await
    .expect("insert users row");
    sqlx::query("INSERT INTO memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')")
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(user_id)
        .execute(&mut *conn)
        .await
        .expect("insert memberships row");

    (org_id, user_id)
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a malformed literal here is a broken test, not a runtime case"
)]
fn at(value: &str) -> Timestamp {
    value.parse().expect("valid instant")
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_event(conn: &mut PgConnection, org_id: Uuid, user_id: Uuid) -> Uuid {
    let suffix = Uuid::now_v7().simple().to_string();
    let (event, _operation) = catalog::create_event(
        conn,
        Uuid::now_v7(),
        org_id,
        user_id,
        None,
        "Open Air",
        &format!("open-air-{suffix}"),
        "Europe/Paris",
        (at("2026-09-05T06:00:00Z"), at("2026-09-06T06:00:00Z")),
    )
    .await
    .expect("create the event");
    event.id
}

fn new_zone(name: &str) -> NewLocation {
    NewLocation {
        kind: "zone".to_owned(),
        name: name.to_owned(),
        description: None,
        address: None,
        exact_address: None,
        latitude: None,
        longitude: None,
        min_volunteers: None,
        max_volunteers: None,
        checked_by_default: true,
        adults_only: false,
        parent_id: None,
        sort_order: 0,
        colour: None,
        shift_pattern_id: None,
    }
}

fn new_post(name: &str, parent_id: Uuid) -> NewLocation {
    NewLocation {
        kind: "post".to_owned(),
        parent_id: Some(parent_id),
        ..new_zone(name)
    }
}

#[expect(
    clippy::expect_used,
    reason = "test assertion — a missing operations row or column is the failure being tested for"
)]
async fn operation_row(
    conn: &mut PgConnection,
    id: Uuid,
) -> (String, serde_json::Value, Vec<Uuid>) {
    let row = sqlx::query("SELECT kind, inverse, entity_ids FROM operations WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        .expect("the write recorded an operations row");
    (
        row.try_get("kind").expect("kind"),
        row.try_get("inverse").expect("inverse"),
        row.try_get("entity_ids").expect("entity_ids"),
    )
}

#[tokio::test]
async fn creating_a_location_records_its_own_deletion_as_the_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let (zone, operation_id) =
        locations::create(&mut tx, org_id, event_id, user_id, &new_zone("Bar"))
            .await
            .expect("create the zone");

    let (kind, inverse, entity_ids) = operation_row(&mut tx, operation_id.0).await;
    assert_eq!(kind, "location.create");
    assert_eq!(inverse["command"], "delete_location");
    assert_eq!(inverse["location_id"], zone.id.to_string());
    assert_eq!(entity_ids, vec![zone.id]);
}

#[tokio::test]
async fn updating_a_location_records_the_pre_image_as_the_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let (zone, _created) = locations::create(&mut tx, org_id, event_id, user_id, &new_zone("Bar"))
        .await
        .expect("create the zone");

    let outcome = locations::update(
        &mut tx,
        org_id,
        event_id,
        zone.id,
        user_id,
        Some(zone.version),
        &LocationPatch {
            name: Some("Bar Central".to_owned()),
            ..LocationPatch::default()
        },
    )
    .await
    .expect("update the zone");

    let Versioned::Applied((_updated, operation_id)) = outcome else {
        panic!("updating at the current version must apply: {outcome:?}");
    };

    let (kind, inverse, entity_ids) = operation_row(&mut tx, operation_id.0).await;
    assert_eq!(kind, "location.update");
    assert_eq!(inverse["command"], "update_location");
    assert_eq!(inverse["location_id"], zone.id.to_string());
    assert_eq!(
        inverse["before"]["name"], "Bar",
        "the inverse must carry the name as it was before this update, not after: {inverse:?}"
    );
    assert_eq!(entity_ids, vec![zone.id]);
}

#[tokio::test]
async fn deleting_a_location_records_its_full_pre_image_as_the_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let (zone, _created) = locations::create(&mut tx, org_id, event_id, user_id, &new_zone("Bar"))
        .await
        .expect("create the zone");

    let outcome = locations::delete(
        &mut tx,
        org_id,
        event_id,
        zone.id,
        user_id,
        Some(zone.version),
    )
    .await
    .expect("delete the zone");

    let Versioned::Applied(operation_id) = outcome else {
        panic!("deleting at the current version must apply: {outcome:?}");
    };

    let (kind, inverse, entity_ids) = operation_row(&mut tx, operation_id.0).await;
    assert_eq!(kind, "location.delete");
    assert_eq!(inverse["command"], "create_location");
    assert_eq!(inverse["kind"], "zone");
    assert_eq!(inverse["name"], "Bar");
    assert_eq!(inverse["event_id"], event_id.to_string());
    assert_eq!(entity_ids, vec![zone.id]);
}

/// `locations_posts_have_no_map_data`: a post is reached through its own
/// zone, so it has no exact address (or pin) of its own to be wrong about.
#[tokio::test]
async fn a_post_with_an_exact_address_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let (zone, _created) = locations::create(&mut tx, org_id, event_id, user_id, &new_zone("Bar"))
        .await
        .expect("create the zone");

    let error = locations::create(
        &mut tx,
        org_id,
        event_id,
        user_id,
        &NewLocation {
            exact_address: Some("12 Rue de la Paix".to_owned()),
            ..new_post("Till 1", zone.id)
        },
    )
    .await
    .expect_err("a post must not carry its own exact address");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation against locations_posts_have_no_map_data, got {error:?}"
    );
}

/// `locations_posts_have_no_map_data` again, this time against a pin rather
/// than a postal address — a post cannot carry either kind of map data.
#[tokio::test]
async fn a_post_with_coordinates_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let (zone, _created) = locations::create(&mut tx, org_id, event_id, user_id, &new_zone("Bar"))
        .await
        .expect("create the zone");

    let error = locations::create(
        &mut tx,
        org_id,
        event_id,
        user_id,
        &NewLocation {
            latitude: Some(48.8566),
            longitude: Some(2.3522),
            ..new_post("Till 1", zone.id)
        },
    )
    .await
    .expect_err("a post must not carry its own coordinates");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation against locations_posts_have_no_map_data, got {error:?}"
    );
}

/// `locations_latitude_longitude_together`: a pin needs both halves or
/// neither — one coordinate with no other names no point on Earth.
#[tokio::test]
async fn a_latitude_with_no_longitude_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let error = locations::create(
        &mut tx,
        org_id,
        event_id,
        user_id,
        &NewLocation {
            latitude: Some(48.8566),
            ..new_zone("Backstage field")
        },
    )
    .await
    .expect_err("latitude with no longitude must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation against locations_latitude_longitude_together, got {error:?}"
    );
}

/// `locations_latitude_in_range`: not every number is a latitude.
#[tokio::test]
async fn a_latitude_past_the_pole_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let error = locations::create(
        &mut tx,
        org_id,
        event_id,
        user_id,
        &NewLocation {
            latitude: Some(90.5),
            longitude: Some(2.3522),
            ..new_zone("Backstage field")
        },
    )
    .await
    .expect_err("a latitude past 90 degrees must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation against locations_latitude_in_range, got {error:?}"
    );
}

/// The volunteer bounds (migration `…120000`) are allowed on a post as well
/// as a zone — unlike the map data above, a post's staffing is its own — and
/// a PATCH can set one side, clear the other, and leave the rest alone.
#[tokio::test]
async fn volunteer_bounds_are_stored_on_posts_and_patched_one_side_at_a_time() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let (zone, _created) = locations::create(&mut tx, org_id, event_id, user_id, &new_zone("Bar"))
        .await
        .expect("create the zone");
    let (post, _created) = locations::create(
        &mut tx,
        org_id,
        event_id,
        user_id,
        &NewLocation {
            min_volunteers: Some(2),
            max_volunteers: Some(4),
            ..new_post("Till 1", zone.id)
        },
    )
    .await
    .expect("a post may carry volunteer bounds");
    assert_eq!(
        (post.min_volunteers, post.max_volunteers),
        (Some(2), Some(4))
    );

    let outcome = locations::update(
        &mut tx,
        org_id,
        event_id,
        post.id,
        user_id,
        Some(post.version),
        &LocationPatch {
            min_volunteers: Patch::Clear,
            max_volunteers: Patch::Set(6),
            ..LocationPatch::default()
        },
    )
    .await
    .expect("patch the bounds");
    let Versioned::Applied((updated, operation_id)) = outcome else {
        panic!("patching at the current version must apply: {outcome:?}");
    };
    assert_eq!(
        (updated.min_volunteers, updated.max_volunteers),
        (None, Some(6)),
        "a cleared floor is NULL, not zero"
    );

    let (_kind, inverse, _entity_ids) = operation_row(&mut tx, operation_id.0).await;
    assert_eq!(inverse["before"]["min_volunteers"], 2);
    assert_eq!(inverse["before"]["max_volunteers"], 4);

    let outcome = locations::update(
        &mut tx,
        org_id,
        event_id,
        post.id,
        user_id,
        None,
        &LocationPatch {
            name: Some("Till One".to_owned()),
            ..LocationPatch::default()
        },
    )
    .await
    .expect("patch the name only");
    let Versioned::Applied((renamed, _operation_id)) = outcome else {
        panic!("an unconditional patch must apply: {outcome:?}");
    };
    assert_eq!(
        renamed.max_volunteers,
        Some(6),
        "an unsent bound is left as it was"
    );
}

/// `locations_volunteer_bounds_ordered`: a ceiling below the floor names no
/// staffing that could satisfy both. Asserted by constraint name as well as
/// SQLSTATE, because the API maps this one constraint specifically.
#[tokio::test]
async fn a_ceiling_below_the_floor_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let error = locations::create(
        &mut tx,
        org_id,
        event_id,
        user_id,
        &NewLocation {
            min_volunteers: Some(5),
            max_volunteers: Some(3),
            ..new_zone("Bar")
        },
    )
    .await
    .expect_err("max below min must be refused");

    assert_eq!(error.sqlstate().as_deref(), Some("23514"), "{error:?}");
    assert_eq!(
        error.constraint().as_deref(),
        Some("locations_volunteer_bounds_ordered"),
        "{error:?}"
    );
}

/// The two column checks: a negative floor and a ceiling of zero.
#[tokio::test]
async fn a_negative_floor_or_a_zero_ceiling_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    for (name, min, max) in [("Negative", Some(-1), None), ("Closed", None, Some(0))] {
        let mut savepoint = sqlx::Connection::begin(&mut *tx).await.expect("savepoint");
        let error = locations::create(
            &mut savepoint,
            org_id,
            event_id,
            user_id,
            &NewLocation {
                min_volunteers: min,
                max_volunteers: max,
                ..new_zone(name)
            },
        )
        .await
        .expect_err("out-of-range bounds must be refused");
        assert_eq!(
            error.sqlstate().as_deref(),
            Some("23514"),
            "{name}: {error:?}"
        );
        savepoint.rollback().await.expect("rollback to savepoint");
    }
}

/// The form flags (migration `…093000`) default to the common case: a zone
/// anyone can do, ticked on the form, open to minors. That default is also
/// what keeps every zone that existed before the migration behaving as before.
/// A PATCH can turn both around, and the inverse remembers what they were.
#[tokio::test]
async fn form_flags_default_to_open_and_ticked_and_patch_with_an_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let (zone, _created) = locations::create(&mut tx, org_id, event_id, user_id, &new_zone("Son"))
        .await
        .expect("create the zone");
    assert!(zone.checked_by_default);
    assert!(!zone.adults_only);

    let outcome = locations::update(
        &mut tx,
        org_id,
        event_id,
        zone.id,
        user_id,
        Some(zone.version),
        &LocationPatch {
            checked_by_default: Some(false),
            adults_only: Some(true),
            ..LocationPatch::default()
        },
    )
    .await
    .expect("patch the flags");
    let Versioned::Applied((updated, operation_id)) = outcome else {
        panic!("patching at the current version must apply: {outcome:?}");
    };
    assert!(!updated.checked_by_default);
    assert!(updated.adults_only);

    let (_kind, inverse, _entity_ids) = operation_row(&mut tx, operation_id.0).await;
    assert_eq!(inverse["before"]["checked_by_default"], true);
    assert_eq!(inverse["before"]["adults_only"], false);

    let outcome = locations::update(
        &mut tx,
        org_id,
        event_id,
        zone.id,
        user_id,
        None,
        &LocationPatch {
            name: Some("Sonorisation".to_owned()),
            ..LocationPatch::default()
        },
    )
    .await
    .expect("patch the name only");
    let Versioned::Applied((renamed, _operation_id)) = outcome else {
        panic!("an unconditional patch must apply: {outcome:?}");
    };
    assert!(
        !renamed.checked_by_default && renamed.adults_only,
        "unsent flags are left as they were"
    );
}

/// `locations_posts_have_no_form_flags`: a post takes its zone's flags. A post
/// open to minors inside an adults-only zone, or the reverse, would just be
/// wrong, so a post can only hold the neutral values.
#[tokio::test]
async fn a_post_with_its_own_form_flags_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(&mut tx, org_id, user_id).await;

    let (zone, _created) = locations::create(&mut tx, org_id, event_id, user_id, &new_zone("Bar"))
        .await
        .expect("create the zone");

    for (name, checked_by_default, adults_only) in
        [("Unticked", false, false), ("Adults", true, true)]
    {
        let mut savepoint = sqlx::Connection::begin(&mut *tx).await.expect("savepoint");
        let error = locations::create(
            &mut savepoint,
            org_id,
            event_id,
            user_id,
            &NewLocation {
                checked_by_default,
                adults_only,
                ..new_post(name, zone.id)
            },
        )
        .await
        .expect_err("a post must not carry its own form flags");
        assert_eq!(
            error.sqlstate().as_deref(),
            Some("23514"),
            "{name}: {error:?}"
        );
        assert_eq!(
            error.constraint().as_deref(),
            Some("locations_posts_have_no_form_flags"),
            "{name}: {error:?}"
        );
        savepoint.rollback().await.expect("rollback to savepoint");
    }
}
