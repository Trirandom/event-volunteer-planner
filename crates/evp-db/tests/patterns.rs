// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for `evp_db::patterns`: the well-formedness trigger
//! from migration `…101100`, the seeded two-hour default, and RLS isolation.
//!
//! Same discipline as `catalog.rs` in this directory — one transaction per
//! test against the shared dev database as `evp_migrator`, never committed, so
//! nothing a test does outlives it. See that file's module documentation for
//! why that proves the same thing a scratch database would.
//!
//! The trigger tests matter more here than most: the constraint is
//! `DEFERRABLE INITIALLY DEFERRED`, so it fires at `COMMIT` rather than at the
//! offending statement. A test that only ran statements would pass against a
//! trigger that never fires at all, which is why each of these forces the
//! check with `SET CONSTRAINTS ALL IMMEDIATE` and asserts the SQLSTATE
//! (docs/13 §2).

use evp_db::patterns::{self, PatternInput, Segment};
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

/// An organisation and the three GUCs a request scoped to it would carry.
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
    (org_id, user_id)
}

fn named(name: &str, segments: Vec<Segment>) -> PatternInput {
    PatternInput {
        name: format!("{name} {}", Uuid::now_v7().simple()),
        repeat: "tile".to_owned(),
        on_remainder: "drop".to_owned(),
        segments,
    }
}

fn shift(duration_minutes: i32) -> Segment {
    Segment {
        kind: "shift".to_owned(),
        duration_minutes,
        label: None,
    }
}

/// Forces the deferred constraint trigger to run now rather than at `COMMIT`,
/// which is the only way a test that rolls back can observe it at all.
async fn force_deferred_checks(conn: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("SET CONSTRAINTS ALL IMMEDIATE")
        .execute(conn)
        .await
        .map(drop)
}

#[tokio::test]
async fn a_pattern_made_only_of_gaps_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    patterns::create(
        &mut tx,
        org_id,
        user_id,
        &named(
            "All Gap",
            vec![Segment {
                kind: "gap".to_owned(),
                duration_minutes: 60,
                label: None,
            }],
        ),
    )
    .await
    .expect("the INSERTs themselves succeed — the trigger is deferred");

    let error = force_deferred_checks(&mut tx)
        .await
        .expect_err("a pattern that generates no shift must be refused");

    assert_eq!(
        error
            .as_database_error()
            .and_then(sqlx::error::DatabaseError::code)
            .as_deref(),
        Some("23514"),
        "expected check_violation from shift_pattern_segments_well_formed, got {error:?}"
    );
}

#[tokio::test]
async fn a_segment_shorter_than_five_minutes_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let error = patterns::create(
        &mut tx,
        org_id,
        user_id,
        &named("Too Short", vec![shift(1)]),
    )
    .await
    .expect_err("a one-minute segment must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23514"),
        "expected check_violation on duration_minutes, got {error:?}"
    );
}

#[tokio::test]
async fn segments_keep_the_order_they_were_written_in() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    // The *artiste* post from ADR-0029. Uneven on purpose: a round trip that
    // sorted by duration, or by anything other than position, would come back
    // as 45/45/45/45/90 and still look plausible.
    patterns::create(
        &mut tx,
        org_id,
        user_id,
        &named(
            "Artiste",
            vec![shift(45), shift(45), shift(90), shift(45), shift(45)],
        ),
    )
    .await
    .expect("create the artiste pattern");
    force_deferred_checks(&mut tx)
        .await
        .expect("the artiste pattern is well formed");

    let listed = patterns::list(&mut tx, org_id, false)
        .await
        .expect("list the catalogue");
    let artiste = listed
        .iter()
        .find(|pattern| pattern.name.starts_with("Artiste"))
        .expect("the pattern just created is in the catalogue");

    let durations: Vec<i32> = artiste
        .segments
        .iter()
        .map(|segment| segment.duration_minutes)
        .collect();
    assert_eq!(durations, vec![45, 45, 90, 45, 45]);
    assert_eq!(
        artiste.durations(),
        vec![45, 90],
        "durations() is the distinct set the divisibility rule reads"
    );
}

#[tokio::test]
async fn a_replace_swaps_the_whole_segment_list_rather_than_merging_it() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (created, _operation_id) = patterns::create(
        &mut tx,
        org_id,
        user_id,
        &named("Before", vec![shift(45), shift(45), shift(90)]),
    )
    .await
    .expect("create");

    // No `force_deferred_checks` before the replace, deliberately: making the
    // trigger immediate for the rest of the transaction would fire it on the
    // DELETE half of `write_segments`, where the list is momentarily empty.
    // Deferral is what makes an atomic replacement expressible at all
    // (migration `…101100`), so forcing it early would test a transaction
    // shape production never has.
    let outcome = patterns::replace(
        &mut tx,
        org_id,
        created.id,
        user_id,
        Some(created.version),
        &named("After", vec![shift(120)]),
    )
    .await
    .expect("replace");
    force_deferred_checks(&mut tx).await.expect("well formed");

    let evp_db::catalog::Versioned::Applied((replaced, _operation_id)) = outcome else {
        panic!("replacing at the current version must apply: {outcome:?}");
    };
    assert_eq!(
        replaced.segments.len(),
        1,
        "PUT is an atomic replacement, not a merge (ADR-0024)"
    );
    assert_eq!(replaced.version, created.version.saturating_add(1));

    let reread = patterns::get(&mut tx, org_id, created.id)
        .await
        .expect("get")
        .expect("the pattern is still there");
    assert_eq!(
        reread.segments.len(),
        1,
        "the three old segments must be gone from the table, not just from the response"
    );
}

/// The seed `create_owner` plants, tested here rather than through
/// `create_owner` itself — that function commits, and this suite rolls back.
#[tokio::test]
async fn a_fresh_organisation_gets_a_usable_two_hour_division() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let seeded = patterns::seed_default(&mut tx, org_id, user_id)
        .await
        .expect("seed the default pattern");
    force_deferred_checks(&mut tx)
        .await
        .expect("the seeded default is well formed");

    assert_eq!(seeded.repeat, "tile");
    assert_eq!(seeded.durations(), vec![120]);
    assert!(!seeded.is_archived);

    // 120 is divisible by every availability step the schema allows, so the
    // pattern an org starts with can be attached to any event it creates.
    for step in [15, 30, 60] {
        assert_eq!(
            120_i32.checked_rem(step),
            Some(0),
            "the seeded default must be attachable at a {step}-minute step"
        );
    }
}

#[tokio::test]
async fn org_a_cannot_see_org_b_s_patterns() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");

    let (org_a, user_a) = seed_org(&mut tx).await;
    patterns::create(&mut tx, org_a, user_a, &named("A Only", vec![shift(120)]))
        .await
        .expect("create in org A");
    force_deferred_checks(&mut tx).await.expect("well formed");

    // `seed_org` re-points the GUCs, which is what a request scoped to the
    // other organisation would do.
    let (org_b, _user_b) = seed_org(&mut tx).await;
    let visible = patterns::list(&mut tx, org_b, true)
        .await
        .expect("list as org B");
    assert!(
        visible.is_empty(),
        "RLS must hide another tenant's catalogue entirely, saw {visible:?}"
    );

    // And the segments, not just the patterns: a policy on the parent table
    // alone would leave the child readable.
    let segments = sqlx::query("SELECT count(*)::bigint AS visible FROM shift_pattern_segments")
        .fetch_one(&mut *tx)
        .await
        .expect("count segments as org B");
    assert_eq!(
        segments.try_get::<i64, _>("visible").unwrap_or(-1),
        0,
        "shift_pattern_segments needs its own policy, and this is the test that says so"
    );
}

// ---------------------------------------------------------------------------
// Operation recording (ADR-0024, docs/18 §2.1)
// ---------------------------------------------------------------------------

#[expect(
    clippy::expect_used,
    reason = "test assertion — a missing operations row or column is the failure being tested for"
)]
async fn operation_row(conn: &mut PgConnection, id: Uuid) -> (String, serde_json::Value) {
    let row = sqlx::query("SELECT kind, inverse FROM operations WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        .expect("the write recorded an operations row");
    (
        row.try_get("kind").expect("kind"),
        row.try_get("inverse").expect("inverse"),
    )
}

#[tokio::test]
async fn creating_a_pattern_records_its_own_deletion_as_the_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (created, operation_id) = patterns::create(
        &mut tx,
        org_id,
        user_id,
        &named("Créneaux", vec![shift(60)]),
    )
    .await
    .expect("create");
    force_deferred_checks(&mut tx).await.expect("well formed");

    let (kind, inverse) = operation_row(&mut tx, operation_id.0).await;
    assert_eq!(kind, "pattern.create");
    assert_eq!(inverse["command"], "delete_pattern");
    assert_eq!(inverse["pattern_id"], created.id.to_string());
}

#[tokio::test]
async fn replacing_a_pattern_records_the_pre_image_segments_as_the_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (created, _operation_id) = patterns::create(
        &mut tx,
        org_id,
        user_id,
        &named("Before", vec![shift(45), shift(90)]),
    )
    .await
    .expect("create");

    let outcome = patterns::replace(
        &mut tx,
        org_id,
        created.id,
        user_id,
        Some(created.version),
        &named("After", vec![shift(120)]),
    )
    .await
    .expect("replace");
    force_deferred_checks(&mut tx).await.expect("well formed");

    let evp_db::catalog::Versioned::Applied((_replaced, operation_id)) = outcome else {
        panic!("replacing at the current version must apply: {outcome:?}");
    };

    let (kind, inverse) = operation_row(&mut tx, operation_id.0).await;
    assert_eq!(kind, "pattern.replace");
    assert_eq!(inverse["command"], "replace_pattern");
    let segments = inverse["segments"]
        .as_array()
        .expect("the inverse carries the pre-image segment list");
    assert_eq!(
        segments
            .iter()
            .map(|segment| segment["duration_minutes"].as_i64())
            .collect::<Vec<_>>(),
        vec![Some(45), Some(90)],
        "the inverse must restore the segments as they were before the replace: {inverse:?}"
    );
}

#[tokio::test]
async fn archiving_a_pattern_records_an_unarchive_as_the_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (created, _operation_id) = patterns::create(
        &mut tx,
        org_id,
        user_id,
        &named("Créneaux", vec![shift(60)]),
    )
    .await
    .expect("create");
    force_deferred_checks(&mut tx).await.expect("well formed");

    let (_archived, operation_id) = patterns::archive(&mut tx, org_id, created.id, user_id)
        .await
        .expect("archive")
        .expect("the pattern exists");

    let (kind, inverse) = operation_row(&mut tx, operation_id.0).await;
    assert_eq!(kind, "pattern.archive");
    assert_eq!(inverse["command"], "set_pattern_status");
    assert_eq!(inverse["is_archived"], false);
}

#[tokio::test]
async fn deleting_an_unreferenced_pattern_records_its_full_pre_image_as_the_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (created, _operation_id) = patterns::create(
        &mut tx,
        org_id,
        user_id,
        &named("Créneaux", vec![shift(60)]),
    )
    .await
    .expect("create");
    force_deferred_checks(&mut tx).await.expect("well formed");

    let operation_id = patterns::delete(&mut tx, org_id, created.id, user_id)
        .await
        .expect("delete")
        .expect("the pattern existed and was deleted");

    let (kind, inverse) = operation_row(&mut tx, operation_id.0).await;
    assert_eq!(kind, "pattern.delete");
    assert_eq!(inverse["command"], "create_pattern");
    let segments = inverse["segments"]
        .as_array()
        .expect("the inverse carries the deleted pattern's segments");
    assert_eq!(
        segments
            .iter()
            .map(|segment| segment["duration_minutes"].as_i64())
            .collect::<Vec<_>>(),
        vec![Some(60)]
    );
}
