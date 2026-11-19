// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for the public form's tenancy and storage
//! (migrations `…200000`–`…200300`, `evp_db::public_forms`).
//!
//! The resolver is the one place an organisation is learnt from something
//! other than a membership, so most of what is asserted here is what it must
//! *not* do: reach a draft or a closed form, reach anything but the one
//! `forms` row, or let two organisations serve one slug.
//!
//! Same connection discipline as `forms.rs`: one transaction per test, never
//! committed, with `set_config(…, true)` switching the organisation in scope.

use evp_db::DbError;
use evp_db::catalog::{self, Versioned};
use evp_db::forms::{self, DraftWrite, FormPatch, NewForm};
use evp_db::public_forms::{self, NewSubmission, Resolved};
use evp_domain::form as domain;
use jiff::Timestamp;
use sqlx::postgres::PgArguments;
use sqlx::{PgConnection, PgPool, Postgres, Row as _};
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
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
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn set(conn: &mut PgConnection, name: &str, value: &str) {
    sqlx::query("SELECT set_config($1, $2, true)")
        .bind(name)
        .bind(value)
        .execute(&mut *conn)
        .await
        .expect("set_config");
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn setting(conn: &mut PgConnection, name: &str) -> String {
    sqlx::query("SELECT coalesce(current_setting($1, true), '') AS value")
        .bind(name)
        .fetch_one(&mut *conn)
        .await
        .expect("current_setting")
        .get("value")
}

/// Puts the transaction in `org_id`'s scope, as the org extractor would.
async fn scope(conn: &mut PgConnection, org_id: Uuid) {
    set(conn, "app.current_org_id", &org_id.to_string()).await;
}

/// An organisation and its owner; leaves the transaction in its scope.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_org(conn: &mut PgConnection) -> (Uuid, Uuid) {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    let suffix = Uuid::now_v7().simple().to_string();
    scope(conn, org_id).await;
    set(conn, "app.current_user_id", &user_id.to_string()).await;
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
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
fn at(value: &str) -> Timestamp {
    value.parse().expect("valid instant")
}

/// A festival with two events, created out of period order so the sort is
/// visible.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_festival(conn: &mut PgConnection, org_id: Uuid, user_id: Uuid) -> (Uuid, [Uuid; 2]) {
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
    let late = seed_event(
        conn,
        (org_id, user_id, festival.id),
        "Afterclash",
        ("2026-09-08T06:00:00Z", "2026-09-09T06:00:00Z"),
    )
    .await;
    let early = seed_event(
        conn,
        (org_id, user_id, festival.id),
        "Open Air",
        ("2026-09-02T06:00:00Z", "2026-09-04T06:00:00Z"),
    )
    .await;
    (festival.id, [early, late])
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_event(
    conn: &mut PgConnection,
    (org_id, user_id, festival_id): (Uuid, Uuid, Uuid),
    name: &str,
    (start, end): (&str, &str),
) -> Uuid {
    catalog::create_event(
        conn,
        Uuid::now_v7(),
        org_id,
        user_id,
        Some(festival_id),
        name,
        &format!("event-{}", Uuid::now_v7().simple()),
        "Europe/Paris",
        (at(start), at(end)),
    )
    .await
    .expect("create the event")
    .0
    .id
}

/// A festival form, seeded as `POST …/forms` seeds it, with the given slug.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_form(
    conn: &mut PgConnection,
    org_id: Uuid,
    user_id: Uuid,
    festival_id: Option<Uuid>,
    slug: &str,
) -> forms::Form {
    let seed = domain::seed_draft(festival_id.is_some(), &[], "Z·est Radio");
    forms::create(
        conn,
        org_id,
        user_id,
        &NewForm {
            name: "Bénévoles".to_owned(),
            slug: slug.to_owned(),
            festival_id,
            event_id: None,
        },
        &seed,
    )
    .await
    .expect("create the form")
    .0
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
fn draft_id(form: &forms::Form) -> Uuid {
    form.versions.first().expect("a seeded draft").id
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn publish(conn: &mut PgConnection, org_id: Uuid, user_id: Uuid, form: &forms::Form) {
    let outcome = forms::publish(conn, org_id, form.id, draft_id(form), user_id, None)
        .await
        .expect("publish");
    assert!(matches!(outcome, DraftWrite::Applied(_)));
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn set_open(conn: &mut PgConnection, org_id: Uuid, user_id: Uuid, form_id: Uuid, open: bool) {
    let outcome = forms::update(
        conn,
        org_id,
        form_id,
        user_id,
        None,
        &FormPatch {
            public_open: Some(open),
            ..FormPatch::default()
        },
    )
    .await
    .expect("update");
    assert!(matches!(outcome, Versioned::Applied(_)));
}

fn unique_slug() -> String {
    format!("benevoles-{}", Uuid::now_v7().simple())
}

type Statement = sqlx::query::Query<'static, Postgres, PgArguments>;

/// Runs `statement` under a savepoint, expecting it to fail, and returns the
/// failure with the transaction still usable.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn refused(conn: &mut PgConnection, statement: Statement) -> DbError {
    savepoint(conn).await;
    let error = statement
        .execute(&mut *conn)
        .await
        .expect_err("the statement must be refused");
    rollback_to_savepoint(conn).await;
    DbError::Query(error)
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn savepoint(conn: &mut PgConnection) {
    sqlx::query("SAVEPOINT attempt")
        .execute(&mut *conn)
        .await
        .expect("savepoint");
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn rollback_to_savepoint(conn: &mut PgConnection) {
    sqlx::query("ROLLBACK TO SAVEPOINT attempt")
        .execute(&mut *conn)
        .await
        .expect("rollback to savepoint");
}

fn assert_refused(error: &DbError, sqlstate: &str, constraint: &str) {
    assert_eq!(
        error.sqlstate().as_deref(),
        Some(sqlstate),
        "expected {sqlstate} ({constraint}), got {error:?}"
    );
    assert_eq!(error.constraint().as_deref(), Some(constraint), "{error:?}");
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn count(conn: &mut PgConnection, sql: &'static str, id: Uuid) -> i64 {
    sqlx::query(sql)
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        .expect("count")
        .get(0)
}

// ---------------------------------------------------------------------------
// Resolving a slug
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_live_open_form_resolves_from_another_scope_and_scopes_the_transaction() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_a, user_a) = seed_org(&mut tx).await;
    let slug = unique_slug();
    let form = seed_form(&mut tx, org_a, user_a, None, &slug).await;
    publish(&mut tx, org_a, user_a, &form).await;

    // A request arrives with some other organisation's scope left over — or
    // none; the answer must not depend on it.
    let (org_b, _) = seed_org(&mut tx).await;
    assert_eq!(
        setting(&mut tx, "app.current_org_id").await,
        org_b.to_string()
    );

    let resolved = public_forms::resolve(&mut tx, &slug.to_uppercase())
        .await
        .expect("resolve");
    assert_eq!(
        resolved,
        Some(Resolved {
            org_id: org_a,
            form_id: form.id
        }),
        "citext: a slug typed in capitals is the same slug"
    );
    assert_eq!(
        setting(&mut tx, "app.current_org_id").await,
        org_a.to_string()
    );
    assert_eq!(
        setting(&mut tx, "app.public_form_slug").await,
        "",
        "the widening lasts one statement"
    );

    // Scoped: the version is now readable through the ordinary tenant policy.
    let live = forms::get(&mut tx, org_a, form.id)
        .await
        .expect("get")
        .expect("visible once scoped");
    assert_eq!(live.live_version_id, Some(draft_id(&form)));
}

#[tokio::test]
async fn an_unknown_unpublished_or_closed_form_is_the_same_nothing() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let slug = unique_slug();
    let form = seed_form(&mut tx, org_id, user_id, None, &slug).await;

    let (other, _) = seed_org(&mut tx).await;
    assert_eq!(
        public_forms::resolve(&mut tx, &slug)
            .await
            .expect("resolve"),
        None,
        "a draft is not public"
    );
    assert_eq!(
        setting(&mut tx, "app.current_org_id").await,
        other.to_string(),
        "a miss scopes nothing"
    );
    assert_eq!(
        public_forms::resolve(&mut tx, &unique_slug())
            .await
            .expect("resolve"),
        None
    );

    scope(&mut tx, org_id).await;
    publish(&mut tx, org_id, user_id, &form).await;
    set_open(&mut tx, org_id, user_id, form.id, false).await;
    scope(&mut tx, other).await;
    assert_eq!(
        public_forms::resolve(&mut tx, &slug)
            .await
            .expect("resolve"),
        None,
        "a closed public route is closed"
    );

    scope(&mut tx, org_id).await;
    set_open(&mut tx, org_id, user_id, form.id, true).await;
    scope(&mut tx, other).await;
    assert!(
        public_forms::resolve(&mut tx, &slug)
            .await
            .expect("resolve")
            .is_some(),
        "and reopening it serves it again"
    );
}

#[tokio::test]
async fn the_slug_makes_one_forms_row_readable_and_nothing_else() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_a, user_a) = seed_org(&mut tx).await;
    let (festival, [event, _]) = seed_festival(&mut tx, org_a, user_a).await;
    let slug = unique_slug();
    let form = seed_form(&mut tx, org_a, user_a, Some(festival), &slug).await;
    publish(&mut tx, org_a, user_a, &form).await;
    let draft_slug = unique_slug();
    let draft = seed_form(&mut tx, org_a, user_a, None, &draft_slug).await;

    // Another organisation's request, naming the slug directly — what a
    // handler that set the variable and then forgot to rescope would see.
    let (_org_b, _) = seed_org(&mut tx).await;
    assert_eq!(
        count(&mut tx, "SELECT count(*) FROM forms WHERE id = $1", form.id).await,
        0,
        "without the slug, org A's form is invisible to org B"
    );
    set(&mut tx, "app.public_form_slug", &slug).await;
    assert_eq!(
        count(&mut tx, "SELECT count(*) FROM forms WHERE id = $1", form.id).await,
        1
    );
    for sql in [
        "SELECT count(*) FROM form_versions WHERE form_id = $1",
        "SELECT count(*) FROM form_questions q JOIN form_versions v ON v.id = q.form_version_id \
          WHERE v.form_id = $1",
    ] {
        assert_eq!(count(&mut tx, sql, form.id).await, 0, "{sql}");
    }
    assert_eq!(
        count(&mut tx, "SELECT count(*) FROM events WHERE id = $1", event).await,
        0
    );
    assert_eq!(
        count(
            &mut tx,
            "SELECT count(*) FROM festivals WHERE id = $1",
            festival
        )
        .await,
        0
    );

    // Read, not write: the tenant policy alone governs UPDATE and DELETE.
    let renamed = sqlx::query("UPDATE forms SET name = 'pwned' WHERE id = $1")
        .bind(form.id)
        .execute(&mut *tx)
        .await
        .expect("update runs");
    assert_eq!(renamed.rows_affected(), 0);
    let deleted = sqlx::query("DELETE FROM forms WHERE id = $1")
        .bind(form.id)
        .execute(&mut *tx)
        .await
        .expect("delete runs");
    assert_eq!(deleted.rows_affected(), 0);

    // And a draft's slug opens nothing.
    set(&mut tx, "app.public_form_slug", &draft_slug).await;
    assert_eq!(
        count(
            &mut tx,
            "SELECT count(*) FROM forms WHERE id = $1",
            draft.id
        )
        .await,
        0
    );
}

#[tokio::test]
async fn two_organisations_cannot_serve_one_slug_but_may_both_hold_it() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let slug = unique_slug();
    let (org_a, user_a) = seed_org(&mut tx).await;
    let form_a = seed_form(&mut tx, org_a, user_a, None, &slug).await;
    publish(&mut tx, org_a, user_a, &form_a).await;

    // Holding the slug in a draft is fine: only the served set is unique.
    let (org_b, user_b) = seed_org(&mut tx).await;
    let form_b = seed_form(&mut tx, org_b, user_b, None, &slug).await;

    savepoint(&mut tx).await;
    let error = forms::publish(&mut tx, org_b, form_b.id, draft_id(&form_b), user_b, None)
        .await
        .expect_err("a second public form on one slug must be refused");
    rollback_to_savepoint(&mut tx).await;
    assert_refused(&error, "23505", "forms_public_slug");

    // Publishing closed, then opening, is the same collision by another road.
    scope(&mut tx, org_b).await;
    set_open(&mut tx, org_b, user_b, form_b.id, false).await;
    publish(&mut tx, org_b, user_b, &form_b).await;
    let reopen = sqlx::query("UPDATE forms SET public_open = true WHERE id = $1").bind(form_b.id);
    assert_refused(
        &refused(&mut tx, reopen).await,
        "23505",
        "forms_public_slug",
    );

    // Once A closes its public route, B may open.
    scope(&mut tx, org_a).await;
    set_open(&mut tx, org_a, user_a, form_a.id, false).await;
    scope(&mut tx, org_b).await;
    set_open(&mut tx, org_b, user_b, form_b.id, true).await;
    assert_eq!(
        public_forms::resolve(&mut tx, &slug)
            .await
            .expect("resolve"),
        Some(Resolved {
            org_id: org_b,
            form_id: form_b.id
        })
    );
}

#[tokio::test]
async fn a_festival_form_covers_its_events_in_period_order() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let (festival, [early, late]) = seed_festival(&mut tx, org_id, user_id).await;

    let events = public_forms::scope_events(&mut tx, org_id, Some(festival), None)
        .await
        .expect("scope events");
    let ids: Vec<Uuid> = events.iter().map(|event| event.id).collect();
    assert_eq!(ids, vec![early, late]);

    let one = public_forms::scope_events(&mut tx, org_id, None, Some(late))
        .await
        .expect("scope events");
    assert_eq!(one.len(), 1);
    assert!(
        public_forms::scope_events(&mut tx, org_id, None, None)
            .await
            .expect("scope events")
            .is_empty()
    );
}

// ---------------------------------------------------------------------------
// Storing a submission
// ---------------------------------------------------------------------------

fn submission(
    org_id: Uuid,
    user_id: Uuid,
    form: &forms::Form,
    held: Option<serde_json::Value>,
) -> NewSubmission<'_> {
    NewSubmission {
        org_id,
        form_id: form.id,
        form_slug: &form.slug,
        event_id: None,
        form_version_id: draft_id(form),
        opened_by: user_id,
        locale: "fr",
        raw: serde_json::json!({ "answers": { "q": "Ada" }, "availability": [] }),
        raw_keys: vec!["q".to_owned()],
        held,
    }
}

#[tokio::test]
async fn a_submission_is_stored_against_its_version_under_one_source() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let form = seed_form(&mut tx, org_id, user_id, None, &unique_slug()).await;
    publish(&mut tx, org_id, user_id, &form).await;

    let first = public_forms::record_submission(&mut tx, &submission(org_id, user_id, &form, None))
        .await
        .expect("record");
    let held = serde_json::json!([{ "field": "elapsed_ms", "code": "too_fast" }]);
    let second = public_forms::record_submission(
        &mut tx,
        &submission(org_id, user_id, &form, Some(held.clone())),
    )
    .await
    .expect("record");

    let sources = sqlx::query(
        "SELECT kind::text AS kind, created_by, last_submission_at IS NOT NULL AS seen \
           FROM intake_sources WHERE form_id = $1",
    )
    .bind(form.id)
    .fetch_all(&mut *tx)
    .await
    .expect("sources");
    assert_eq!(sources.len(), 1, "one source per form, however many arrive");
    assert_eq!(sources[0].get::<String, _>("kind"), "internal_form");
    assert_eq!(sources[0].get::<Uuid, _>("created_by"), user_id);
    assert!(sources[0].get::<bool, _>("seen"));

    let rows = sqlx::query(
        "SELECT s.id, s.state::text AS state, s.errors, s.form_version_id, s.locale, s.raw_keys, \
                b.trigger, b.row_count, p.raw \
           FROM submissions s \
           JOIN submission_batches b ON b.id = s.batch_id \
           JOIN submission_payloads p ON p.submission_id = s.id \
          WHERE s.id = ANY($1) ORDER BY s.id",
    )
    .bind(vec![first, second])
    .fetch_all(&mut *tx)
    .await
    .expect("submissions");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<String, _>("state"), "received");
    assert_eq!(rows[0].get::<Option<serde_json::Value>, _>("errors"), None);
    assert_eq!(rows[1].get::<String, _>("state"), "needs_review");
    assert_eq!(
        rows[1].get::<Option<serde_json::Value>, _>("errors"),
        Some(held)
    );
    for row in &rows {
        assert_eq!(row.get::<Uuid, _>("form_version_id"), draft_id(&form));
        assert_eq!(row.get::<String, _>("locale"), "fr");
        assert_eq!(row.get::<Vec<String>, _>("raw_keys"), vec!["q".to_owned()]);
        assert_eq!(row.get::<String, _>("trigger"), "form");
        assert_eq!(row.get::<i32, _>("row_count"), 1);
        assert_eq!(
            row.get::<serde_json::Value, _>("raw")["answers"]["q"],
            "Ada"
        );
    }

    // Nothing is reconciled: no volunteer, no participation.
    let volunteers: i64 = sqlx::query(
        "SELECT count(*) FROM submissions WHERE id = ANY($1) AND volunteer_id IS NOT NULL",
    )
    .bind(vec![first, second])
    .fetch_one(&mut *tx)
    .await
    .expect("count")
    .get(0);
    assert_eq!(volunteers, 0);

    // And it is the organisation's alone.
    let (_other, _) = seed_org(&mut tx).await;
    assert_eq!(
        count(
            &mut tx,
            "SELECT count(*) FROM submissions WHERE id = $1",
            first
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &mut tx,
            "SELECT count(*) FROM submission_payloads WHERE submission_id = $1",
            first
        )
        .await,
        0
    );
}

#[tokio::test]
async fn the_new_intake_constraints_refuse_what_they_exist_to_refuse() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_a, user_a) = seed_org(&mut tx).await;
    let form_a = seed_form(&mut tx, org_a, user_a, None, &unique_slug()).await;
    let version_a = draft_id(&form_a);
    let (org_b, user_b) = seed_org(&mut tx).await;
    let form_b = seed_form(&mut tx, org_b, user_b, None, &unique_slug()).await;
    public_forms::record_submission(&mut tx, &submission(org_b, user_b, &form_b, None))
        .await
        .expect("record");
    let source_b: Uuid = sqlx::query("SELECT id FROM intake_sources WHERE form_id = $1")
        .bind(form_b.id)
        .fetch_one(&mut *tx)
        .await
        .expect("source")
        .get("id");
    let batch_b: Uuid = sqlx::query("SELECT id FROM submission_batches WHERE source_id = $1")
        .bind(source_b)
        .fetch_one(&mut *tx)
        .await
        .expect("batch")
        .get("id");

    let insert_submission = |version: Uuid, locale: Option<&'static str>| {
        sqlx::query(
            "INSERT INTO submissions \
               (id, org_id, source_id, batch_id, external_id, form_version_id, locale) \
             VALUES ($1, $2, $3, $4, $1::text, $5, $6)",
        )
        .bind(Uuid::now_v7())
        .bind(org_b)
        .bind(source_b)
        .bind(batch_b)
        .bind(version)
        .bind(locale)
    };
    // Another organisation's version.
    assert_refused(
        &refused(&mut tx, insert_submission(version_a, Some("fr"))).await,
        "23503",
        "submissions_form_version_fk",
    );
    assert_refused(
        &refused(&mut tx, insert_submission(draft_id(&form_b), Some("de"))).await,
        "23514",
        "submissions_locale_known",
    );
    assert_refused(
        &refused(&mut tx, insert_submission(draft_id(&form_b), None)).await,
        "23514",
        "submissions_form_has_locale",
    );

    let insert_source = |kind: &'static str, form_id: Option<Uuid>| {
        sqlx::query(
            "INSERT INTO intake_sources (id, org_id, kind, name, form_id, created_by) \
             VALUES ($1, $2, $3::intake_source_kind, $4, $5, $6)",
        )
        .bind(Uuid::now_v7())
        .bind(org_b)
        .bind(kind)
        .bind(format!("source-{}", Uuid::now_v7().simple()))
        .bind(form_id)
        .bind(user_b)
    };
    assert_refused(
        &refused(&mut tx, insert_source("internal_form", None)).await,
        "23514",
        "intake_sources_internal_has_form",
    );
    assert_refused(
        &refused(&mut tx, insert_source("csv_upload", Some(form_b.id))).await,
        "23514",
        "intake_sources_internal_has_form",
    );
    assert_refused(
        &refused(&mut tx, insert_source("internal_form", Some(form_b.id))).await,
        "23505",
        "intake_sources_one_per_form",
    );
    assert_refused(
        &refused(&mut tx, insert_source("internal_form", Some(form_a.id))).await,
        "23503",
        "intake_sources_form_fk",
    );

    let batch = sqlx::query(
        "INSERT INTO submission_batches (id, org_id, source_id, trigger) \
         VALUES ($1, $2, $3, 'carrier_pigeon')",
    )
    .bind(Uuid::now_v7())
    .bind(org_b)
    .bind(source_b);
    assert_refused(
        &refused(&mut tx, batch).await,
        "23514",
        "submission_batches_trigger_check",
    );
}
