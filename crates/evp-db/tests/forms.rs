// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for the first-party form's tables (migration
//! `…164319`) and `evp_db::forms`.
//!
//! Every constraint is attacked directly with SQL and its SQLSTATE asserted
//! (docs/13 §2): the validator in `evp_domain::form` states the same rules
//! first, and these are what still hold when a caller skips it. Each attempt
//! runs under a savepoint, so one test can try several violations on one
//! transaction.
//!
//! Same connection discipline as `catalog.rs`: one transaction per test,
//! never committed.

use evp_db::DbError;
use evp_db::catalog::{self, Patch, Versioned};
use evp_db::forms::{self, DraftWrite, FormPatch, NewDraft, NewForm, VersionRef};
use evp_domain::form::{self as domain, MissionRow, QuestionKind, TargetPath};
use jiff::Timestamp;
use sqlx::postgres::PgArguments;
use sqlx::{PgConnection, PgPool, Postgres, Row as _};
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

    for (name, value) in [
        ("app.current_org_id", org_id.to_string()),
        ("app.current_user_id", user_id.to_string()),
        ("app.current_role", "owner".to_owned()),
    ] {
        sqlx::query("SELECT set_config($1, $2, true)")
            .bind(name)
            .bind(value)
            .execute(&mut *conn)
            .await
            .expect("set_config");
    }
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
async fn seed_festival(conn: &mut PgConnection, org_id: Uuid, user_id: Uuid) -> Uuid {
    let (festival, _operation) = catalog::create_festival(
        conn,
        Uuid::now_v7(),
        org_id,
        user_id,
        "Soundclash",
        &format!("soundclash-{}", Uuid::now_v7().simple()),
        "Europe/Paris",
        (at("2026-09-01T06:00:00Z"), at("2026-09-10T06:00:00Z")),
    )
    .await
    .expect("create the festival");
    festival.id
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_event(
    conn: &mut PgConnection,
    org_id: Uuid,
    user_id: Uuid,
    festival_id: Option<Uuid>,
    name: &str,
    start: &str,
    end: &str,
) -> Uuid {
    let (event, _operation) = catalog::create_event(
        conn,
        Uuid::now_v7(),
        org_id,
        user_id,
        festival_id,
        name,
        &format!("event-{}", Uuid::now_v7().simple()),
        "Europe/Paris",
        (at(start), at(end)),
    )
    .await
    .expect("create the event");
    event.id
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_location(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    parent_id: Option<Uuid>,
    name: &str,
    sort_order: i32,
) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO locations (id, org_id, event_id, parent_id, kind, name, sort_order) \
         VALUES ($1, $2, $3, $4, \
                 CASE WHEN $4::uuid IS NULL THEN 'zone' ELSE 'post' END::location_kind, $5, $6)",
    )
    .bind(id)
    .bind(org_id)
    .bind(event_id)
    .bind(parent_id)
    .bind(name)
    .bind(sort_order)
    .execute(&mut *conn)
    .await
    .expect("insert location");
    id
}

/// A form through the repository, seeded as `POST …/forms` seeds it.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_form(
    conn: &mut PgConnection,
    org_id: Uuid,
    user_id: Uuid,
    festival_id: Option<Uuid>,
    event_id: Option<Uuid>,
) -> forms::Form {
    let rows = forms::mission_rows(conn, org_id, festival_id, event_id)
        .await
        .expect("mission rows");
    let seed = domain::seed_draft(
        festival_id.is_some() || event_id.is_some(),
        &domain::fold_missions(&rows),
        "Z·est Radio",
    );
    let (form, _operation) = forms::create(
        conn,
        org_id,
        user_id,
        &NewForm {
            name: "Bénévoles".to_owned(),
            slug: format!("benevoles-{}", Uuid::now_v7().simple()),
            festival_id,
            event_id,
        },
        &seed,
    )
    .await
    .expect("create the form");
    form
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a form without its seeded draft is a broken fixture"
)]
fn draft_id(form: &forms::Form) -> Uuid {
    form.versions.first().expect("a seeded draft").id
}

type Statement = sqlx::query::Query<'static, Postgres, PgArguments>;

/// Runs `statement` under a savepoint, expecting it to fail, and returns the
/// failure with the transaction still usable.
#[expect(
    clippy::expect_used,
    reason = "test assertion — a statement that succeeds here is the failure being tested for"
)]
async fn refused(conn: &mut PgConnection, statement: Statement) -> DbError {
    sqlx::query("SAVEPOINT attempt")
        .execute(&mut *conn)
        .await
        .expect("savepoint");
    let error = statement
        .execute(&mut *conn)
        .await
        .expect_err("the statement must be refused");
    sqlx::query("ROLLBACK TO SAVEPOINT attempt")
        .execute(&mut *conn)
        .await
        .expect("rollback to savepoint");
    DbError::Query(error)
}

fn assert_refused(error: &DbError, sqlstate: &str, constraint: &str) {
    assert_eq!(
        error.sqlstate().as_deref(),
        Some(sqlstate),
        "expected {sqlstate} ({constraint}), got {error:?}"
    );
    assert_eq!(error.constraint().as_deref(), Some(constraint), "{error:?}");
}

struct Row {
    kind: &'static str,
    target: Option<&'static str>,
    purpose: Option<&'static str>,
    options: Option<serde_json::Value>,
    required: bool,
    position: i32,
}

fn row(kind: &'static str, position: i32) -> Row {
    Row {
        kind,
        target: None,
        purpose: None,
        options: None,
        required: false,
        position,
    }
}

fn insert(org_id: Uuid, version_id: Uuid, row: Row) -> Statement {
    sqlx::query(
        "INSERT INTO form_questions \
           (id, org_id, form_version_id, kind, target_path, consent_purpose, label, options, \
            is_required, position) \
         VALUES ($1, $2, $3, $4::form_question_kind, $5, $6::consent_purpose, \
                 '{\"fr\": \"Q\"}', $7, $8, $9)",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(version_id)
    .bind(row.kind)
    .bind(row.target)
    .bind(row.purpose)
    .bind(row.options)
    .bind(row.required)
    .bind(row.position)
}

/// A bare draft with no questions, so each constraint test starts clean.
#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn empty_version(conn: &mut PgConnection, org_id: Uuid, form_id: Uuid) -> Uuid {
    sqlx::query("DELETE FROM form_questions WHERE form_version_id IN (SELECT id FROM form_versions WHERE form_id = $1)")
        .bind(form_id)
        .execute(&mut *conn)
        .await
        .expect("clear the seed");
    let row = sqlx::query("SELECT id FROM form_versions WHERE org_id = $1 AND form_id = $2")
        .bind(org_id)
        .bind(form_id)
        .fetch_one(&mut *conn)
        .await
        .expect("the draft");
    row.try_get("id").expect("id")
}

// ---------------------------------------------------------------------------
// forms
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_form_scoped_to_both_a_festival_and_an_event_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let festival_id = seed_festival(&mut tx, org_id, user_id).await;
    let event_id = seed_event(
        &mut tx,
        org_id,
        user_id,
        Some(festival_id),
        "Open Air",
        "2026-09-05T08:00:00Z",
        "2026-09-06T02:00:00Z",
    )
    .await;

    let error = refused(
        &mut tx,
        sqlx::query(
            "INSERT INTO forms (id, org_id, festival_id, event_id, slug, name) \
             VALUES ($1, $2, $3, $4, 'both', 'Both')",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(festival_id)
        .bind(event_id),
    )
    .await;
    assert_refused(&error, "23514", "forms_one_scope");

    // The boundary: one scope, or none, is fine.
    for (festival, event, slug) in [
        (Some(festival_id), None, "festival-scoped"),
        (None, Some(event_id), "event-scoped"),
        (None, None, "pool"),
    ] {
        sqlx::query(
            "INSERT INTO forms (id, org_id, festival_id, event_id, slug, name) \
             VALUES ($1, $2, $3, $4, $5, 'Ok')",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(festival)
        .bind(event)
        .bind(slug)
        .execute(&mut *tx)
        .await
        .expect("a form with at most one scope is accepted");
    }
}

#[tokio::test]
async fn an_unknown_default_locale_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, _user_id) = seed_org(&mut tx).await;

    let error = refused(
        &mut tx,
        sqlx::query(
            "INSERT INTO forms (id, org_id, slug, name, default_locale) \
             VALUES ($1, $2, 'de', 'Deutsch', 'de')",
        )
        .bind(Uuid::now_v7())
        .bind(org_id),
    )
    .await;
    assert_refused(&error, "23514", "forms_default_locale_known");
}

#[tokio::test]
async fn a_duplicate_slug_in_one_org_is_23505_case_insensitively() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, _user_id) = seed_org(&mut tx).await;

    sqlx::query("INSERT INTO forms (id, org_id, slug, name) VALUES ($1, $2, 'benevoles', 'A')")
        .bind(Uuid::now_v7())
        .bind(org_id)
        .execute(&mut *tx)
        .await
        .expect("first form");
    let error = refused(
        &mut tx,
        sqlx::query("INSERT INTO forms (id, org_id, slug, name) VALUES ($1, $2, 'Benevoles', 'B')")
            .bind(Uuid::now_v7())
            .bind(org_id),
    )
    .await;
    assert_refused(&error, "23505", "forms_org_id_slug_key");
}

#[tokio::test]
async fn a_form_scoped_to_another_org_s_festival_or_event_is_23503() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_a, user_a) = seed_org(&mut tx).await;
    let festival_a = seed_festival(&mut tx, org_a, user_a).await;
    let event_a = seed_event(
        &mut tx,
        org_a,
        user_a,
        None,
        "Standalone",
        "2026-09-05T08:00:00Z",
        "2026-09-06T02:00:00Z",
    )
    .await;
    let (org_b, _user_b) = seed_org(&mut tx).await;

    let error = refused(
        &mut tx,
        sqlx::query(
            "INSERT INTO forms (id, org_id, festival_id, slug, name) VALUES ($1, $2, $3, 'x', 'X')",
        )
        .bind(Uuid::now_v7())
        .bind(org_b)
        .bind(festival_a),
    )
    .await;
    assert_refused(&error, "23503", "forms_festival_id_org_id_fkey");

    let error = refused(
        &mut tx,
        sqlx::query(
            "INSERT INTO forms (id, org_id, event_id, slug, name) VALUES ($1, $2, $3, 'y', 'Y')",
        )
        .bind(Uuid::now_v7())
        .bind(org_b)
        .bind(event_a),
    )
    .await;
    assert_refused(&error, "23503", "forms_event_id_org_id_fkey");
}

#[tokio::test]
async fn a_form_cannot_go_live_on_another_form_s_version() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let first = seed_form(&mut tx, org_id, user_id, None, None).await;
    let second = seed_form(&mut tx, org_id, user_id, None, None).await;

    let error = refused(
        &mut tx,
        sqlx::query("UPDATE forms SET live_version_id = $1 WHERE id = $2")
            .bind(draft_id(&second))
            .bind(first.id),
    )
    .await;
    assert_refused(&error, "23503", "forms_live_version_same_form_fk");
}

// ---------------------------------------------------------------------------
// form_versions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_second_draft_is_23505() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, None).await;

    let error = refused(
        &mut tx,
        sqlx::query(
            "INSERT INTO form_versions (id, org_id, form_id, version) VALUES ($1, $2, $3, 2)",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(form.id),
    )
    .await;
    assert_refused(&error, "23505", "form_one_draft");

    // The boundary: a second *published* version is fine beside the draft.
    sqlx::query(
        "INSERT INTO form_versions (id, org_id, form_id, version, published_at, published_by) \
         VALUES ($1, $2, $3, 2, '2026-09-01T00:00:00Z', $4)",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(form.id)
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .expect("a published version beside one draft is accepted");
}

#[tokio::test]
async fn a_duplicate_version_number_is_23505() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, None).await;

    let error = refused(
        &mut tx,
        sqlx::query(
            "INSERT INTO form_versions (id, org_id, form_id, version, published_at, published_by) \
             VALUES ($1, $2, $3, 1, '2026-09-01T00:00:00Z', $4)",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(form.id)
        .bind(user_id),
    )
    .await;
    assert_refused(&error, "23505", "form_versions_form_id_version_key");
}

#[tokio::test]
async fn published_at_without_published_by_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, None).await;

    let error = refused(
        &mut tx,
        sqlx::query("UPDATE form_versions SET published_at = '2026-09-01T00:00:00Z' WHERE id = $1")
            .bind(draft_id(&form)),
    )
    .await;
    assert_refused(&error, "23514", "form_versions_published_together");
}

#[tokio::test]
async fn a_version_of_another_org_s_form_is_23503() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_a, user_a) = seed_org(&mut tx).await;
    let form_a = seed_form(&mut tx, org_a, user_a, None, None).await;
    let (org_b, _user_b) = seed_org(&mut tx).await;

    let error = refused(
        &mut tx,
        // Published, so `form_one_draft` is not what refuses it.
        sqlx::query(
            "INSERT INTO form_versions (id, org_id, form_id, version, published_at, published_by) \
             VALUES ($1, $2, $3, 9, '2026-09-01T00:00:00Z', $4)",
        )
        .bind(Uuid::now_v7())
        .bind(org_b)
        .bind(form_a.id)
        .bind(user_a),
    )
    .await;
    assert_refused(&error, "23503", "form_versions_form_id_org_id_fkey");
}

// ---------------------------------------------------------------------------
// form_questions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn each_per_row_question_check_is_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, None).await;
    let version = empty_version(&mut tx, org_id, form.id).await;

    let cases = [
        (
            "form_question_options",
            Row {
                options: None,
                ..row("single_choice", 0)
            },
        ),
        (
            "form_question_options",
            Row {
                options: Some(serde_json::json!([])),
                ..row("short_text", 0)
            },
        ),
        ("form_question_target", row("email", 0)),
        (
            "form_question_target",
            Row {
                target: Some("volunteer.notes"),
                options: Some(serde_json::json!([])),
                ..row("missions", 0)
            },
        ),
        (
            "form_question_target_known",
            Row {
                target: Some("volunteer.birthdate"),
                ..row("short_text", 0)
            },
        ),
        ("form_question_consent_purpose", row("consent", 0)),
        (
            "form_question_consent_purpose",
            Row {
                purpose: Some("processing"),
                ..row("boolean", 0)
            },
        ),
        (
            "form_question_pool_consent_optional",
            Row {
                purpose: Some("pool_retention"),
                required: true,
                ..row("consent", 0)
            },
        ),
    ];
    for (constraint, case) in cases {
        let error = refused(&mut tx, insert(org_id, version, case)).await;
        assert_refused(&error, "23514", constraint);
    }

    // The boundaries of the same checks, accepted: an untargeted custom
    // question (ADR-0037), an optional pool consent, and a missions question
    // with its list.
    for (position, case) in [
        row("short_text", 0),
        Row {
            purpose: Some("pool_retention"),
            ..row("consent", 1)
        },
        Row {
            options: Some(serde_json::json!([{ "value": "bar", "label": { "fr": "Bar" } }])),
            ..row("missions", 2)
        },
    ]
    .into_iter()
    .enumerate()
    {
        insert(org_id, version, case)
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|error| panic!("case {position} must be accepted: {error:?}"));
    }
}

#[tokio::test]
async fn each_at_most_one_rule_is_a_23505() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, None).await;
    let version = empty_version(&mut tx, org_id, form.id).await;

    let firsts = [
        row("availability", 0),
        Row {
            options: Some(serde_json::json!([])),
            ..row("missions", 1)
        },
        Row {
            target: Some("volunteer.first_name"),
            ..row("short_text", 2)
        },
        Row {
            purpose: Some("processing"),
            required: true,
            ..row("consent", 3)
        },
    ];
    for first in firsts {
        insert(org_id, version, first)
            .execute(&mut *tx)
            .await
            .expect("the first of each is accepted");
    }

    let seconds = [
        ("form_one_availability", row("availability", 10)),
        (
            "form_one_missions",
            Row {
                options: Some(serde_json::json!([])),
                ..row("missions", 11)
            },
        ),
        (
            "form_one_question_per_target",
            Row {
                target: Some("volunteer.first_name"),
                ..row("long_text", 12)
            },
        ),
        (
            "form_one_consent_per_purpose",
            Row {
                purpose: Some("processing"),
                required: true,
                ..row("consent", 13)
            },
        ),
        (
            "form_questions_form_version_id_position_key",
            row("short_text", 0),
        ),
    ];
    for (constraint, second) in seconds {
        let error = refused(&mut tx, insert(org_id, version, second)).await;
        assert_refused(&error, "23505", constraint);
    }

    // One consent of each purpose is the boundary, not a violation.
    insert(
        org_id,
        version,
        Row {
            purpose: Some("pool_retention"),
            ..row("consent", 20)
        },
    )
    .execute(&mut *tx)
    .await
    .expect("a pool-retention consent beside the processing one is accepted");
}

#[tokio::test]
async fn a_question_on_another_org_s_version_is_23503() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_a, user_a) = seed_org(&mut tx).await;
    let form_a = seed_form(&mut tx, org_a, user_a, None, None).await;
    let (org_b, _user_b) = seed_org(&mut tx).await;

    let error = refused(
        &mut tx,
        insert(org_b, draft_id(&form_a), row("short_text", 99)),
    )
    .await;
    assert_refused(
        &error,
        "23503",
        "form_questions_form_version_id_org_id_fkey",
    );
}

// ---------------------------------------------------------------------------
// Tenant isolation, through the real RLS path (docs/03 §4)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn org_b_cannot_see_org_a_s_forms_versions_or_questions() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_a, user_a) = seed_org(&mut tx).await;
    let form_a = seed_form(&mut tx, org_a, user_a, None, None).await;
    let version_a = draft_id(&form_a);

    // Rescoped to org B on the same transaction, as a second request would be.
    let (org_b, _user_b) = seed_org(&mut tx).await;

    assert!(
        forms::list(&mut tx, org_b, None, None)
            .await
            .expect("list")
            .is_empty()
    );
    assert!(
        forms::get(&mut tx, org_a, form_a.id)
            .await
            .expect("get")
            .is_none(),
        "org B's session read org A's form by naming org A"
    );
    assert!(
        forms::get_version(&mut tx, org_a, form_a.id, VersionRef::Id(version_a))
            .await
            .expect("get_version")
            .is_none()
    );
    for (table, count) in [
        (
            "forms",
            "SELECT count(*)::bigint AS n FROM forms WHERE org_id = $1",
        ),
        (
            "form_versions",
            "SELECT count(*)::bigint AS n FROM form_versions WHERE org_id = $1",
        ),
        (
            "form_questions",
            "SELECT count(*)::bigint AS n FROM form_questions WHERE org_id = $1",
        ),
    ] {
        let row = sqlx::query(count)
            .bind(org_a)
            .fetch_one(&mut *tx)
            .await
            .expect("count");
        let visible: i64 = row.try_get("n").expect("n");
        assert_eq!(visible, 0, "org B's session saw org A's {table}");
    }
}

#[tokio::test]
async fn writing_a_form_stamped_with_another_org_s_id_is_rejected_by_rls() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_a, _user_a) = seed_org(&mut tx).await;
    let (_org_b, user_b) = seed_org(&mut tx).await;

    let error = forms::create(
        &mut tx,
        org_a,
        user_b,
        &NewForm {
            name: "Smuggled".to_owned(),
            slug: "smuggled".to_owned(),
            festival_id: None,
            event_id: None,
        },
        &domain::seed_draft(false, &[], "Z·est Radio"),
    )
    .await
    .expect_err("a form stamped with another org's id must be refused");
    assert_eq!(
        error.sqlstate().as_deref(),
        Some("42501"),
        "expected insufficient_privilege (RLS WITH CHECK), got {error:?}"
    );
}

#[tokio::test]
async fn every_form_table_has_forced_rls_and_a_retention_tier() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    for table in ["forms", "form_versions", "form_questions"] {
        let row = sqlx::query(
            "SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, \
                    (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid \
                        AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL)::bigint AS policies, \
                    (SELECT r.tier FROM retention_scope r WHERE r.table_name = c.oid) AS tier \
               FROM pg_class c WHERE c.oid = $1::regclass",
        )
        .bind(table)
        .fetch_one(&mut *tx)
        .await
        .expect("catalog row");
        let enabled: bool = row.try_get("enabled").expect("enabled");
        let forced: bool = row.try_get("forced").expect("forced");
        let policies: i64 = row.try_get("policies").expect("policies");
        let tier: Option<String> = row.try_get("tier").expect("tier");
        assert!(enabled && forced, "{table}: RLS must be enabled and forced");
        assert_eq!(policies, 1, "{table}: one policy with USING and WITH CHECK");
        assert_eq!(tier.as_deref(), Some("accountability"), "{table}");
    }
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

#[tokio::test]
async fn creating_a_form_seeds_version_1_and_records_its_deletion_as_the_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let festival_id = seed_festival(&mut tx, org_id, user_id).await;
    let event = seed_event(
        &mut tx,
        org_id,
        user_id,
        Some(festival_id),
        "Open Air",
        "2026-09-05T08:00:00Z",
        "2026-09-06T02:00:00Z",
    )
    .await;
    seed_location(&mut tx, org_id, event, None, "Bar", 0).await;

    let rows = forms::mission_rows(&mut tx, org_id, Some(festival_id), None)
        .await
        .expect("rows");
    let seed = domain::seed_draft(true, &domain::fold_missions(&rows), "Z·est Radio");
    let (form, operation) = forms::create(
        &mut tx,
        org_id,
        user_id,
        &NewForm {
            name: "Soundclash".to_owned(),
            slug: "soundclash".to_owned(),
            festival_id: Some(festival_id),
            event_id: None,
        },
        &seed,
    )
    .await
    .expect("create");

    assert_eq!(form.versions.len(), 1);
    assert_eq!(form.versions[0].version, 1);
    assert!(form.versions[0].published_at.is_none());
    assert_eq!(form.versions[0].question_count, 9);
    assert!(form.live_version_id.is_none());

    let version = forms::get_version(&mut tx, org_id, form.id, VersionRef::Number(1))
        .await
        .expect("get")
        .expect("present");
    assert_eq!(
        version.drafts(),
        seed,
        "the stored seed reads back as written"
    );

    let row = sqlx::query("SELECT kind, inverse FROM operations WHERE id = $1")
        .bind(operation.0)
        .fetch_one(&mut *tx)
        .await
        .expect("operation");
    let kind: String = row.try_get("kind").expect("kind");
    let inverse: serde_json::Value = row.try_get("inverse").expect("inverse");
    assert_eq!(kind, "form.create");
    assert_eq!(inverse["command"], "delete_form");
    assert_eq!(inverse["form_id"], form.id.to_string());
}

#[tokio::test]
async fn mission_rows_walk_events_by_start_then_each_zone_before_its_posts() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let festival_id = seed_festival(&mut tx, org_id, user_id).await;
    // Created out of order: the later event first.
    let club = seed_event(
        &mut tx,
        org_id,
        user_id,
        Some(festival_id),
        "Club",
        "2026-09-06T20:00:00Z",
        "2026-09-07T04:00:00Z",
    )
    .await;
    let open_air = seed_event(
        &mut tx,
        org_id,
        user_id,
        Some(festival_id),
        "Open Air",
        "2026-09-05T08:00:00Z",
        "2026-09-06T02:00:00Z",
    )
    .await;
    let entry = seed_location(&mut tx, org_id, open_air, None, "Entrée", 1).await;
    let site = seed_location(&mut tx, org_id, open_air, None, "Site", 0).await;
    seed_location(&mut tx, org_id, open_air, Some(site), "Bar", 1).await;
    seed_location(&mut tx, org_id, open_air, Some(site), "Accueil", 0).await;
    seed_location(&mut tx, org_id, open_air, Some(entry), "Fouille", 0).await;
    seed_location(&mut tx, org_id, club, None, "BAR", 0).await;
    // Another event outside the festival must not appear.
    let other = seed_event(
        &mut tx,
        org_id,
        user_id,
        None,
        "Elsewhere",
        "2026-09-05T08:00:00Z",
        "2026-09-06T02:00:00Z",
    )
    .await;
    seed_location(&mut tx, org_id, other, None, "Vestiaire", 0).await;

    let rows = forms::mission_rows(&mut tx, org_id, Some(festival_id), None)
        .await
        .expect("rows");
    let walked: Vec<(Uuid, &str)> = rows
        .iter()
        .map(|row| (row.event_id, row.name.as_str()))
        .collect();
    assert_eq!(
        walked,
        vec![
            (open_air, "Site"),
            (open_air, "Accueil"),
            (open_air, "Bar"),
            (open_air, "Entrée"),
            (open_air, "Fouille"),
            (club, "BAR"),
        ]
    );

    let folded = domain::fold_missions(&rows);
    let bar = folded
        .iter()
        .find(|mission| mission.value == "bar")
        .expect("bar");
    assert_eq!(bar.label, "Bar", "the first day's spelling");
    assert_eq!(bar.event_ids, vec![open_air, club]);

    let event_only = forms::mission_rows(&mut tx, org_id, None, Some(club))
        .await
        .expect("rows");
    assert_eq!(
        event_only,
        vec![MissionRow {
            event_id: club,
            name: "BAR".to_owned(),
            checked_by_default: true,
            adults_only: false,
        }]
    );
    assert!(
        forms::mission_rows(&mut tx, org_id, None, None)
            .await
            .expect("rows")
            .is_empty()
    );
}

/// A post has no form flags of its own (`locations_posts_have_no_form_flags`),
/// so its mission row carries its zone's. The flags themselves are folded in
/// `evp-domain`; this is only the inheritance that the query is responsible for.
#[tokio::test]
async fn mission_rows_give_a_post_its_zone_s_form_flags() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event_id = seed_event(
        &mut tx,
        org_id,
        user_id,
        None,
        "Open Air",
        "2026-09-04T16:00:00Z",
        "2026-09-05T04:00:00Z",
    )
    .await;
    let stage = seed_location(&mut tx, org_id, event_id, None, "Scène", 0).await;
    seed_location(&mut tx, org_id, event_id, Some(stage), "Son", 0).await;
    seed_location(&mut tx, org_id, event_id, None, "Accueil", 1).await;
    sqlx::query(
        "UPDATE locations SET checked_by_default = false, adults_only = true WHERE id = $1",
    )
    .bind(stage)
    .execute(&mut *tx)
    .await
    .expect("flag the zone");

    let rows = forms::mission_rows(&mut tx, org_id, None, Some(event_id))
        .await
        .expect("rows");
    let flags: Vec<(&str, bool, bool)> = rows
        .iter()
        .map(|row| (row.name.as_str(), row.checked_by_default, row.adults_only))
        .collect();
    assert_eq!(
        flags,
        vec![
            ("Scène", false, true),
            ("Son", false, true),
            ("Accueil", true, false),
        ]
    );
}

#[tokio::test]
async fn replacing_questions_bumps_the_etag_and_keeps_the_old_list_as_the_inverse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, None).await;
    let before = forms::get_version(&mut tx, org_id, form.id, VersionRef::Id(draft_id(&form)))
        .await
        .expect("get")
        .expect("present");

    let mut questions = before.drafts();
    questions.push(domain::QuestionDraft {
        kind: QuestionKind::Boolean,
        target_path: None,
        consent_purpose: None,
        label: domain::Localized::fr("Je veux rejoindre l'équipe fly"),
        help_text: None,
        options: None,
        is_required: false,
        is_sensitive: true,
    });

    let stale = forms::replace_questions(
        &mut tx,
        org_id,
        form.id,
        before.id,
        user_id,
        Some(before.etag_version + 5),
        Patch::Unchanged,
        &questions,
    )
    .await
    .expect("replace");
    assert!(matches!(stale, DraftWrite::Stale { current } if current == before.etag_version));

    let DraftWrite::Applied((after, operation)) = forms::replace_questions(
        &mut tx,
        org_id,
        form.id,
        before.id,
        user_id,
        Some(before.etag_version),
        Patch::Set("2026-09".to_owned()),
        &questions,
    )
    .await
    .expect("replace") else {
        panic!("the replace must apply");
    };
    assert_eq!(after.etag_version, before.etag_version + 1);
    assert_eq!(after.privacy_notice_version.as_deref(), Some("2026-09"));
    assert_eq!(after.drafts(), questions);
    assert!(after.questions.last().is_some_and(|q| q.draft.is_sensitive));

    let row = sqlx::query("SELECT inverse FROM operations WHERE id = $1")
        .bind(operation.0)
        .fetch_one(&mut *tx)
        .await
        .expect("operation");
    let inverse: serde_json::Value = row.try_get("inverse").expect("inverse");
    assert_eq!(inverse["command"], "replace_form_questions");
    assert_eq!(
        inverse["before"]["questions"].as_array().map(Vec::len),
        Some(before.questions.len())
    );
}

#[tokio::test]
async fn publishing_freezes_the_version_and_a_new_draft_copies_it() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, None).await;
    let v1 = draft_id(&form);

    // Nothing live yet: no draft can be copied, and the existing draft is in
    // the way anyway.
    assert!(matches!(
        forms::create_draft(&mut tx, org_id, form.id, user_id)
            .await
            .expect("create_draft"),
        NewDraft::DraftExists
    ));

    let DraftWrite::Applied((published, _operation)) =
        forms::publish(&mut tx, org_id, form.id, v1, user_id, None)
            .await
            .expect("publish")
    else {
        panic!("publish must apply");
    };
    assert!(published.published_at.is_some());
    assert_eq!(published.published_by, Some(user_id));
    let live = forms::get(&mut tx, org_id, form.id)
        .await
        .expect("get")
        .expect("present");
    assert_eq!(live.live_version_id, Some(v1));
    assert!(
        live.version > form.version,
        "publishing moves the form's ETag"
    );

    assert!(matches!(
        forms::replace_questions(
            &mut tx,
            org_id,
            form.id,
            v1,
            user_id,
            None,
            Patch::Unchanged,
            &[]
        )
        .await
        .expect("replace"),
        DraftWrite::Published
    ));
    assert!(matches!(
        forms::publish(&mut tx, org_id, form.id, v1, user_id, None)
            .await
            .expect("publish"),
        DraftWrite::Published
    ));

    let NewDraft::Created(created) = forms::create_draft(&mut tx, org_id, form.id, user_id)
        .await
        .expect("create_draft")
    else {
        panic!("a draft is created from the live version");
    };
    let (v2, _operation) = *created;
    assert_eq!(v2.version, 2);
    assert!(v2.published_at.is_none());
    assert_eq!(v2.drafts(), published.drafts());
    assert!(
        v2.questions
            .iter()
            .zip(&published.questions)
            .all(|(new, old)| new.id != old.id),
        "the copy has its own question rows"
    );
    assert!(matches!(
        forms::create_draft(&mut tx, org_id, form.id, user_id)
            .await
            .expect("create_draft"),
        NewDraft::DraftExists
    ));
}

#[tokio::test]
async fn a_form_is_deletable_only_until_it_is_published() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let draft_only = seed_form(&mut tx, org_id, user_id, None, None).await;
    let DraftWrite::Applied(operation) = forms::delete(
        &mut tx,
        org_id,
        draft_only.id,
        user_id,
        Some(draft_only.version),
    )
    .await
    .expect("delete") else {
        panic!("a never-published form deletes");
    };
    let row = sqlx::query("SELECT inverse FROM operations WHERE id = $1")
        .bind(operation.0)
        .fetch_one(&mut *tx)
        .await
        .expect("operation");
    let inverse: serde_json::Value = row.try_get("inverse").expect("inverse");
    assert_eq!(inverse["command"], "create_form");
    assert_eq!(
        inverse["versions"][0]["questions"].as_array().map(Vec::len),
        Some(7)
    );
    assert!(
        forms::get(&mut tx, org_id, draft_only.id)
            .await
            .expect("get")
            .is_none()
    );

    let published = seed_form(&mut tx, org_id, user_id, None, None).await;
    forms::publish(
        &mut tx,
        org_id,
        published.id,
        draft_id(&published),
        user_id,
        None,
    )
    .await
    .expect("publish");
    assert!(matches!(
        forms::delete(&mut tx, org_id, published.id, user_id, None)
            .await
            .expect("delete"),
        DraftWrite::Published
    ));
}

#[tokio::test]
async fn patching_a_form_checks_its_version_and_keeps_the_pre_image() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, None).await;

    let patch = FormPatch {
        name: Some("Renamed".to_owned()),
        public_open: Some(false),
        default_locale: Some("en".to_owned()),
    };
    assert!(matches!(
        forms::update(
            &mut tx,
            org_id,
            form.id,
            user_id,
            Some(form.version + 1),
            &patch
        )
        .await
        .expect("update"),
        Versioned::Stale { .. }
    ));
    let Versioned::Applied((after, _operation)) = forms::update(
        &mut tx,
        org_id,
        form.id,
        user_id,
        Some(form.version),
        &patch,
    )
    .await
    .expect("update") else {
        panic!("the patch applies");
    };
    assert_eq!(after.name, "Renamed");
    assert!(!after.public_open);
    assert_eq!(after.default_locale, "en");
    assert_eq!(after.version, form.version + 1);
}

#[tokio::test]
async fn deleting_an_event_takes_its_published_form_with_it() {
    // forms → form_versions → forms is a cycle of foreign keys; the cascade
    // must still get through it.
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let event = seed_event(
        &mut tx,
        org_id,
        user_id,
        None,
        "One night",
        "2026-09-05T18:00:00Z",
        "2026-09-06T04:00:00Z",
    )
    .await;
    let form = seed_form(&mut tx, org_id, user_id, None, Some(event)).await;
    forms::publish(&mut tx, org_id, form.id, draft_id(&form), user_id, None)
        .await
        .expect("publish");

    catalog::delete_event(&mut tx, org_id, event, None)
        .await
        .expect("delete the event");
    assert!(
        forms::get(&mut tx, org_id, form.id)
            .await
            .expect("get")
            .is_none()
    );
}

#[tokio::test]
async fn an_unscoped_seed_has_no_availability_or_missions() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, None).await;
    let version = forms::get_version(&mut tx, org_id, form.id, VersionRef::Number(1))
        .await
        .expect("get")
        .expect("present");
    assert!(version.questions.iter().all(|question| !matches!(
        question.draft.kind,
        QuestionKind::Availability | QuestionKind::Missions
    )));
    assert!(
        version
            .questions
            .iter()
            .any(|question| question.draft.target_path == Some(TargetPath::Email))
    );
}

#[tokio::test]
async fn the_worked_example_brings_a_publishable_festival_form() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let fixture = evp_domain::example::build().expect("example.json parses and resolves");
    let (festival, _operation) = catalog::create_example(&mut tx, org_id, user_id, &fixture)
        .await
        .expect("the example persists");

    let listed = forms::list(&mut tx, org_id, Some(festival.id), None)
        .await
        .expect("list");
    assert_eq!(listed.len(), 1, "one draft form for the festival");
    let form = &listed[0];
    assert!(
        form.live_version_id.is_none(),
        "left for the coordinator to publish"
    );

    let version = forms::get_version(&mut tx, org_id, form.id, VersionRef::Number(1))
        .await
        .expect("get")
        .expect("present");
    let rows = forms::mission_rows(&mut tx, org_id, Some(festival.id), None)
        .await
        .expect("rows");
    let keys = domain::fold_missions(&rows)
        .into_iter()
        .map(|mission| mission.value)
        .collect();
    assert!(!rows.is_empty(), "the example has missions to offer");
    let problems = domain::validate_publish(
        &version.drafts(),
        domain::PublishContext {
            scoped: true,
            default_locale: domain::Locale::Fr,
            mission_keys: &keys,
        },
    );
    assert!(problems.is_empty(), "{problems:?}");
}
