// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for reconciling a first-party form submission into
//! the pool (`evp_db::intake`, docs/08 §6 and §8, ADR-0042).
//!
//! The ladder's decisions are unit-tested in `evp_intake::reconcile`; what is
//! asserted here is what only the database can show — which rows each
//! decision writes, that a locked column survives, that a resubmission
//! replaces rather than adds, and that a review item keeps no copy of anyone's
//! details.
//!
//! Same connection discipline as `public_forms.rs`: one transaction per test,
//! never committed, scoped to the organisation it seeds.

use evp_db::catalog;
use evp_db::forms::{self, DraftWrite, NewForm};
use evp_db::intake::{self, Outcome};
use evp_db::public_forms::{self, NewSubmission};
use evp_domain::form::{
    self as domain, ConsentPurpose, Localized, QuestionDraft, QuestionKind, TargetPath,
};
use evp_intake::reconcile::MatchKind;
use jiff::Timestamp;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool, Row as _};
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
fn at(value: &str) -> Timestamp {
    value.parse().expect("valid instant")
}

/// An organisation, its owner, a festival of two events and a published
/// festival form asking the seeded questions plus a T-shirt size and the pool
/// consent. Leaves the transaction in the organisation's scope.
struct Fixture {
    org_id: Uuid,
    user_id: Uuid,
    form: forms::Form,
    version: forms::FormVersion,
    /// Open Air (2–4 September), then Afterclash (8–9 September).
    events: [Uuid; 2],
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn fixture(conn: &mut PgConnection) -> Fixture {
    let (org_id, user_id) = seed_org(conn).await;
    let suffix = Uuid::now_v7().simple().to_string();
    let (festival, _operation) = catalog::create_festival(
        conn,
        Uuid::now_v7(),
        org_id,
        user_id,
        "Soundclash",
        &format!("soundclash-{suffix}"),
        "Europe/Paris",
        (at("2026-09-01T06:00:00Z"), at("2026-09-10T06:00:00Z")),
    )
    .await
    .expect("create the festival");
    let mut events = [Uuid::nil(); 2];
    for (slot, (name, start, end)) in events.iter_mut().zip([
        ("Open Air", "2026-09-02T06:00:00Z", "2026-09-04T06:00:00Z"),
        ("Afterclash", "2026-09-08T06:00:00Z", "2026-09-09T06:00:00Z"),
    ]) {
        *slot = catalog::create_event(
            conn,
            Uuid::now_v7(),
            org_id,
            user_id,
            Some(festival.id),
            name,
            &format!("event-{}", Uuid::now_v7().simple()),
            "Europe/Paris",
            (at(start), at(end)),
        )
        .await
        .expect("create the event")
        .0
        .id;
    }
    let (form, version) = seed_form(conn, org_id, user_id, festival.id).await;
    Fixture {
        org_id,
        user_id,
        form,
        version,
        events,
    }
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
    set(conn, "app.current_org_id", &org_id.to_string()).await;
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

/// A festival form asking the seeded questions plus a T-shirt size and the
/// pool consent, published.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_form(
    conn: &mut PgConnection,
    org_id: Uuid,
    user_id: Uuid,
    festival_id: Uuid,
) -> (forms::Form, forms::FormVersion) {
    let mut seed = domain::seed_draft(true, &[], "Z·est Radio");
    seed.push(QuestionDraft {
        kind: QuestionKind::ShortText,
        target_path: Some(TargetPath::TshirtSize),
        consent_purpose: None,
        label: Localized::fr("Taille de t-shirt"),
        help_text: None,
        options: None,
        is_required: false,
        is_sensitive: false,
    });
    seed.push(QuestionDraft {
        kind: QuestionKind::Consent,
        target_path: None,
        consent_purpose: Some(ConsentPurpose::PoolRetention),
        label: Localized::fr("Gardez mes coordonnées pour les prochaines éditions."),
        help_text: None,
        options: None,
        is_required: false,
        is_sensitive: false,
    });
    let (form, _operation) = forms::create(
        conn,
        org_id,
        user_id,
        &NewForm {
            name: "Bénévoles".to_owned(),
            slug: format!("benevoles-{}", Uuid::now_v7().simple()),
            festival_id: Some(festival_id),
            event_id: None,
        },
        &seed,
    )
    .await
    .expect("create the form");
    let draft = form.versions.first().expect("a seeded draft").id;
    let published = forms::publish(conn, org_id, form.id, draft, user_id, None)
        .await
        .expect("publish");
    assert!(matches!(published, DraftWrite::Applied(_)), "{published:?}");
    let version = forms::get_version(conn, org_id, form.id, forms::VersionRef::Id(draft))
        .await
        .expect("get the version")
        .expect("the published version");
    (form, version)
}

/// What a volunteer typed, by the column each question targets.
#[derive(Default)]
struct Typed<'a> {
    first_name: &'a str,
    last_name: &'a str,
    email: &'a str,
    phone: &'a str,
    tshirt_size: &'a str,
    pool_consent: bool,
}

const ADA: Typed<'static> = Typed {
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@example.org",
    phone: "",
    tshirt_size: "",
    pool_consent: false,
};

impl Fixture {
    fn question(&self, pick: impl Fn(&QuestionDraft) -> bool) -> String {
        self.version
            .questions
            .iter()
            .find(|question| pick(&question.draft))
            .map(|question| question.id.to_string())
            .unwrap_or_default()
    }

    fn target(&self, target: TargetPath) -> String {
        self.question(|draft| draft.target_path == Some(target))
    }

    /// The payload the public route would have stored for `typed`.
    fn payload(&self, typed: &Typed<'_>, windows: &Value) -> Value {
        let mut answers = serde_json::Map::new();
        for (target, text) in [
            (TargetPath::FirstName, typed.first_name),
            (TargetPath::LastName, typed.last_name),
            (TargetPath::Email, typed.email),
            (TargetPath::Phone, typed.phone),
            (TargetPath::TshirtSize, typed.tshirt_size),
        ] {
            answers.insert(self.target(target), json!(text));
        }
        for question in &self.version.questions {
            match question.draft.consent_purpose {
                Some(ConsentPurpose::PoolRetention) => {
                    answers.insert(question.id.to_string(), json!(typed.pool_consent));
                }
                Some(ConsentPurpose::Processing | ConsentPurpose::Commitment) => {
                    answers.insert(question.id.to_string(), json!(true));
                }
                None => {}
            }
        }
        json!({
            "form_version_id": self.version.id,
            "locale": "fr",
            "answers": answers,
            "availability": windows,
            "elapsed_ms": 45_000,
        })
    }

    /// One available range on Open Air, on `day` of September.
    fn open_air(&self, day: u8) -> Value {
        json!([{
            "event_id": self.events[0],
            "kind": "available",
            "start": format!("2026-09-0{day}T08:00:00Z"),
            "end": format!("2026-09-0{day}T14:00:00Z"),
        }])
    }

    #[expect(
        clippy::expect_used,
        reason = "test fixture — a setup failure must abort the test loudly, not be handled"
    )]
    async fn record(
        &self,
        conn: &mut PgConnection,
        typed: &Typed<'_>,
        windows: &Value,
        held: Option<Value>,
    ) -> Uuid {
        public_forms::record_submission(
            conn,
            &NewSubmission {
                org_id: self.org_id,
                form_id: self.form.id,
                form_slug: &self.form.slug,
                event_id: None,
                form_version_id: self.version.id,
                opened_by: self.user_id,
                locale: "fr",
                raw: self.payload(typed, windows),
                raw_keys: Vec::new(),
                held,
            },
        )
        .await
        .expect("record the submission")
    }

    /// Records `typed` and reconciles it.
    #[expect(
        clippy::expect_used,
        reason = "test fixture — a setup failure must abort the test loudly, not be handled"
    )]
    async fn send(
        &self,
        conn: &mut PgConnection,
        typed: &Typed<'_>,
        windows: &Value,
    ) -> (Uuid, Outcome) {
        let submission_id = self.record(conn, typed, windows, None).await;
        let outcome = intake::reconcile(conn, self.org_id, submission_id)
            .await
            .expect("reconcile");
        (submission_id, outcome)
    }

    /// A volunteer already in the pool, as a coordinator or an import left
    /// them.
    #[expect(
        clippy::expect_used,
        reason = "test fixture — a setup failure must abort the test loudly, not be handled"
    )]
    async fn existing(
        &self,
        conn: &mut PgConnection,
        display_name: &str,
        (first_name, last_name): (Option<&str>, Option<&str>),
        email: Option<&str>,
    ) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO volunteers (id, org_id, display_name, first_name, last_name, email) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(id)
        .bind(self.org_id)
        .bind(display_name)
        .bind(first_name)
        .bind(last_name)
        .bind(email)
        .execute(&mut *conn)
        .await
        .expect("insert a volunteer");
        id
    }
}

/// `(state, volunteer_id, match_kind, supersedes_id, match_candidates, errors)`.
type SubmissionRow = (
    String,
    Option<Uuid>,
    Option<String>,
    Option<Uuid>,
    Option<Value>,
    Option<Value>,
);

#[expect(
    clippy::expect_used,
    reason = "test fixture — a read that fails is a broken test, not a runtime case"
)]
async fn submission(conn: &mut PgConnection, id: Uuid) -> SubmissionRow {
    let row = sqlx::query(
        "SELECT state::text AS state, volunteer_id, match_kind::text AS match_kind, \
                supersedes_id, match_candidates, errors \
           FROM submissions WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await
    .expect("read the submission");
    (
        row.get("state"),
        row.get("volunteer_id"),
        row.get("match_kind"),
        row.get("supersedes_id"),
        row.get("match_candidates"),
        row.get("errors"),
    )
}

#[expect(
    clippy::expect_used,
    reason = "test fixture — a read that fails is a broken test, not a runtime case"
)]
async fn volunteer(conn: &mut PgConnection, id: Uuid) -> sqlx::postgres::PgRow {
    sqlx::query(
        "SELECT display_name, first_name, last_name, email::text AS email, phone, tshirt_size, \
                locale, pool_consent_at, pool_consent_expires \
           FROM volunteers WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await
    .expect("read the volunteer")
}

/// `(event_id, status, [(kind, start)])` per participation of `volunteer_id`.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a read that fails is a broken test, not a runtime case"
)]
async fn participations(
    conn: &mut PgConnection,
    volunteer_id: Uuid,
) -> Vec<(Uuid, String, Vec<(String, Timestamp)>)> {
    let rows = sqlx::query(
        "SELECT p.id, p.event_id, p.status::text AS status FROM participations p \
          WHERE p.volunteer_id = $1 ORDER BY p.event_id",
    )
    .bind(volunteer_id)
    .fetch_all(&mut *conn)
    .await
    .expect("read participations");
    let mut out = Vec::new();
    for row in rows {
        let id: Uuid = row.get("id");
        let windows = sqlx::query(
            "SELECT kind::text AS kind, lower(period) AS start FROM availability_windows \
              WHERE participation_id = $1 ORDER BY lower(period)",
        )
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .expect("read windows")
        .iter()
        .map(|window| {
            (
                window.get("kind"),
                window.get::<jiff_sqlx::Timestamp, _>("start").to_jiff(),
            )
        })
        .collect();
        out.push((row.get("event_id"), row.get("status"), windows));
    }
    out
}

#[expect(
    clippy::panic,
    reason = "test assertion — any other outcome is the test failing"
)]
fn applied(outcome: Outcome, kind: MatchKind) -> Uuid {
    match outcome {
        Outcome::Applied {
            volunteer_id,
            kind: actual,
        } if actual == kind => volunteer_id,
        other => panic!("expected {kind:?}, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Step 5: someone new
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_stranger_becomes_a_volunteer_with_a_confirmed_participation() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let typed = Typed {
        phone: "06 12 34 56 78",
        tshirt_size: "m",
        pool_consent: true,
        ..ADA
    };
    let mut windows = fx.open_air(2);
    windows.as_array_mut().expect("a list").push(json!({
        "event_id": fx.events[1], "kind": "unavailable",
        "start": "2026-09-08T08:00:00Z", "end": "2026-09-08T12:00:00Z"
    }));
    let (submission_id, outcome) = fx.send(&mut tx, &typed, &windows).await;
    let volunteer_id = applied(outcome, MatchKind::New);

    let (state, linked, kind, supersedes, _, _) = submission(&mut tx, submission_id).await;
    assert_eq!(state, "applied");
    assert_eq!(linked, Some(volunteer_id));
    assert_eq!(kind.as_deref(), Some("new"));
    assert_eq!(supersedes, None);

    let row = volunteer(&mut tx, volunteer_id).await;
    assert_eq!(row.get::<String, _>("display_name"), "Ada Lovelace");
    assert_eq!(
        row.get::<Option<String>, _>("email").as_deref(),
        Some("ada@example.org")
    );
    assert_eq!(
        row.get::<Option<String>, _>("tshirt_size").as_deref(),
        Some("M")
    );
    assert_eq!(row.get::<String, _>("locale"), "fr");
    assert!(
        row.get::<Option<jiff_sqlx::Timestamp>, _>("pool_consent_at")
            .is_some()
            && row
                .get::<Option<jiff_sqlx::Timestamp>, _>("pool_consent_expires")
                .is_some(),
        "the pool consent is recorded with its expiry"
    );

    assert_eq!(
        participations(&mut tx, volunteer_id).await,
        vec![(
            fx.events[0],
            "confirmed".to_owned(),
            vec![("available".to_owned(), at("2026-09-02T08:00:00Z"))]
        )],
        "only Open Air was offered; Afterclash's unavailable-only answer stays in the payload"
    );
}

#[tokio::test]
async fn an_answer_the_column_cannot_hold_is_dropped_not_fatal() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let typed = Typed {
        tshirt_size: "Large",
        ..ADA
    };
    let (_, outcome) = fx.send(&mut tx, &typed, &fx.open_air(2)).await;
    let volunteer_id = applied(outcome, MatchKind::New);
    assert_eq!(
        volunteer(&mut tx, volunteer_id)
            .await
            .get::<Option<String>, _>("tshirt_size"),
        None
    );
}

// ---------------------------------------------------------------------------
// Step 2: the address, and revisions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sending_again_revises_the_same_volunteer_and_replaces_their_windows() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let (first, outcome) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;
    let volunteer_id = applied(outcome, MatchKind::New);

    let again = Typed {
        email: "  ADA@Example.org ",
        phone: "06 12 34 56 78",
        ..ADA
    };
    let (second, outcome) = fx.send(&mut tx, &again, &fx.open_air(3)).await;
    assert_eq!(applied(outcome, MatchKind::ExactEmail), volunteer_id);

    assert_eq!(submission(&mut tx, first).await.0, "superseded");
    let (state, _, kind, supersedes, _, _) = submission(&mut tx, second).await;
    assert_eq!(state, "applied");
    assert_eq!(kind.as_deref(), Some("exact_email"));
    assert_eq!(supersedes, Some(first));

    assert_eq!(
        volunteer(&mut tx, volunteer_id)
            .await
            .get::<Option<String>, _>("phone")
            .as_deref(),
        Some("06 12 34 56 78")
    );
    assert_eq!(
        participations(&mut tx, volunteer_id).await,
        vec![(
            fx.events[0],
            "confirmed".to_owned(),
            vec![("available".to_owned(), at("2026-09-03T08:00:00Z"))]
        )],
        "the earlier submission's window is replaced, not kept beside the new one"
    );

    let listed = evp_db::submissions::list(&mut tx, fx.org_id)
        .await
        .expect("list");
    assert_eq!(
        listed.iter().map(|row| row.id).collect::<Vec<_>>(),
        vec![second],
        "the coordinator sees each person once, with what they said last"
    );
}

#[tokio::test]
async fn a_locked_column_and_the_roster_label_survive_a_revision() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let volunteer_id = fx
        .existing(
            &mut tx,
            "LOVELACE Ada (Countess)",
            (Some("Ada"), None),
            Some("ada@example.org"),
        )
        .await;
    sqlx::query(
        "UPDATE volunteers SET phone = '01 00 00 00 00', locked_fields = '{phone}' WHERE id = $1",
    )
    .bind(volunteer_id)
    .execute(&mut *tx)
    .await
    .expect("lock the phone");

    let typed = Typed {
        phone: "06 12 34 56 78",
        ..ADA
    };
    let (_, outcome) = fx.send(&mut tx, &typed, &fx.open_air(2)).await;
    assert_eq!(applied(outcome, MatchKind::ExactEmail), volunteer_id);

    let row = volunteer(&mut tx, volunteer_id).await;
    assert_eq!(
        row.get::<Option<String>, _>("phone").as_deref(),
        Some("01 00 00 00 00"),
        "a coordinator's edit wins (docs/08 §8)"
    );
    assert_eq!(
        row.get::<Option<String>, _>("last_name").as_deref(),
        Some("Lovelace"),
        "an unlocked column takes the newest answer"
    );
    assert_eq!(
        row.get::<String, _>("display_name"),
        "LOVELACE Ada (Countess)",
        "the roster label is the coordinator's (ADR-0012)"
    );
}

#[tokio::test]
async fn a_participation_a_coordinator_declined_stays_declined() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let volunteer_id = fx
        .existing(
            &mut tx,
            "Ada Lovelace",
            (Some("Ada"), Some("Lovelace")),
            Some("ada@example.org"),
        )
        .await;
    sqlx::query(
        "INSERT INTO participations (id, org_id, event_id, volunteer_id, status) \
         VALUES ($1, $2, $3, $4, 'declined')",
    )
    .bind(Uuid::now_v7())
    .bind(fx.org_id)
    .bind(fx.events[0])
    .bind(volunteer_id)
    .execute(&mut *tx)
    .await
    .expect("insert a declined participation");

    let (_, outcome) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;
    applied(outcome, MatchKind::ExactEmail);
    let rows = participations(&mut tx, volunteer_id).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "declined");
}

#[tokio::test]
async fn an_address_claimed_under_another_name_is_held_with_the_conflict_named() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let grace = fx
        .existing(
            &mut tx,
            "Grace Hopper",
            (Some("Grace"), Some("Hopper")),
            Some("ada@example.org"),
        )
        .await;
    let (submission_id, outcome) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;
    assert_eq!(outcome, Outcome::NeedsReview);

    let (state, linked, _, _, candidates, errors) = submission(&mut tx, submission_id).await;
    assert_eq!(state, "needs_review");
    assert_eq!(linked, None);
    let candidates = candidates.expect("candidates");
    assert_eq!(candidates[0]["volunteer_id"], json!(grace));
    assert!(
        candidates[0].get("display_name").is_none() && candidates[0].get("email").is_none(),
        "ids and evidence only: {candidates}"
    );
    assert_eq!(errors.expect("errors")[0]["code"], "email_in_use");
    assert_eq!(
        volunteer(&mut tx, grace)
            .await
            .get::<Option<String>, _>("first_name")
            .as_deref(),
        Some("Grace"),
        "nothing about the address's owner was rewritten"
    );
}

// ---------------------------------------------------------------------------
// Steps 3 and 4: the name
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_similar_name_with_the_same_last_name_is_that_volunteer() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let existing = fx
        .existing(
            &mut tx,
            "Ada Lovelace",
            (Some("Ada"), Some("Lovelace")),
            Some("old@example.org"),
        )
        .await;
    let (_, outcome) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;
    assert_eq!(applied(outcome, MatchKind::FuzzyConfirmed), existing);
    assert_eq!(
        volunteer(&mut tx, existing)
            .await
            .get::<Option<String>, _>("email")
            .as_deref(),
        Some("ada@example.org"),
        "the address they gave this time is the one kept"
    );
}

#[tokio::test]
async fn a_similar_name_alone_is_held_for_a_coordinator() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    // A legacy import: a display name, no parts, no address.
    let legacy = fx
        .existing(&mut tx, "Ada Lovelace", (None, None), None)
        .await;
    let (submission_id, outcome) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;
    assert_eq!(outcome, Outcome::NeedsReview);

    let (state, linked, kind, _, candidates, errors) = submission(&mut tx, submission_id).await;
    assert_eq!(state, "needs_review");
    assert_eq!((linked, kind), (None, None));
    assert_eq!(
        errors, None,
        "a similar name is not an error, just a question"
    );
    let candidates = candidates.expect("candidates");
    assert_eq!(candidates.as_array().map(Vec::len), Some(1));
    assert_eq!(candidates[0]["volunteer_id"], json!(legacy));
    assert_eq!(candidates[0]["last_name_agrees"], json!(false));
    assert!(
        participations(&mut tx, legacy).await.is_empty(),
        "nothing is applied to a candidate"
    );
}

// ---------------------------------------------------------------------------
// What is not reconciled
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_submission_held_by_the_timing_floor_or_already_applied_is_skipped() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let held = fx
        .record(
            &mut tx,
            &ADA,
            &fx.open_air(2),
            Some(json!([{ "field": "elapsed_ms", "code": "too_fast" }])),
        )
        .await;
    assert_eq!(
        intake::reconcile(&mut tx, fx.org_id, held)
            .await
            .expect("reconcile"),
        Outcome::Skipped
    );
    assert_eq!(submission(&mut tx, held).await.0, "needs_review");
    assert_eq!(
        intake::pending(&mut tx, fx.org_id).await.expect("pending"),
        Vec::<Uuid>::new()
    );

    let (applied_id, _) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;
    assert_eq!(
        intake::reconcile(&mut tx, fx.org_id, applied_id)
            .await
            .expect("reconcile"),
        Outcome::Skipped,
        "running it twice changes nothing the second time"
    );
}

#[tokio::test]
async fn pending_lists_received_submissions_oldest_first() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let first = fx.record(&mut tx, &ADA, &fx.open_air(2), None).await;
    let second = fx.record(&mut tx, &ADA, &fx.open_air(3), None).await;
    assert_eq!(
        intake::pending(&mut tx, fx.org_id).await.expect("pending"),
        vec![first, second]
    );
    for id in [first, second] {
        intake::reconcile(&mut tx, fx.org_id, id)
            .await
            .expect("reconcile");
    }
    assert!(
        intake::pending(&mut tx, fx.org_id)
            .await
            .expect("pending")
            .is_empty()
    );
    assert_eq!(submission(&mut tx, first).await.0, "superseded");
}

// ---------------------------------------------------------------------------
// The coordinator's list
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_list_reads_a_form_payload_in_the_versions_order_and_words() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let typed = Typed {
        phone: "06 12 34 56 78",
        tshirt_size: "XL",
        pool_consent: true,
        ..ADA
    };
    let (submission_id, _) = fx.send(&mut tx, &typed, &fx.open_air(2)).await;
    let listed = evp_db::submissions::list(&mut tx, fx.org_id)
        .await
        .expect("list");
    let [row] = listed.as_slice() else {
        panic!("expected one submission, got {listed:?}");
    };
    assert_eq!(row.id, submission_id);
    assert_eq!(row.display_name, "Ada Lovelace");
    let answers: Vec<(&str, &str)> = row
        .answers
        .iter()
        .map(|answer| (answer.question.as_str(), answer.value.as_str()))
        .collect();
    assert_eq!(
        answers,
        vec![
            ("Comment veux-tu qu'on t'appelle ?", "Ada"),
            ("Nom de famille", "Lovelace"),
            ("Adresse e-mail", "ada@example.org"),
            ("Numéro de téléphone", "06 12 34 56 78"),
            ("Taille de t-shirt", "XL"),
        ],
        "consents and availability are not answers a coordinator reads here"
    );
    assert_eq!(row.availability.len(), 1);
    assert_eq!(row.availability[0].event_id, fx.events[0]);
    assert_eq!(row.availability[0].start, at("2026-09-02T08:00:00Z"));
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

#[expect(
    clippy::expect_used,
    reason = "test fixture — a resolution the test expects to be accepted"
)]
async fn resolve(
    conn: &mut PgConnection,
    fx: &Fixture,
    submission_id: Uuid,
    resolution: &intake::Resolution,
) -> Result<intake::Reviewed, intake::Refused> {
    intake::resolve(conn, fx.org_id, fx.user_id, submission_id, resolution)
        .await
        .expect("resolve")
        .map(|(reviewed, _operation)| reviewed)
}

#[tokio::test]
async fn the_queue_shows_who_it_claims_to_be_beside_who_it_could_be() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let legacy = fx
        .existing(&mut tx, "Ada Lovelace", (None, None), None)
        .await;
    let (submission_id, _) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;

    let queue = intake::review_queue(&mut tx, fx.org_id)
        .await
        .expect("queue");
    let [item] = queue.as_slice() else {
        panic!("expected one item, got {queue:?}");
    };
    assert_eq!(item.id, submission_id);
    let claimed = item.claimed.as_ref().expect("a mappable payload");
    assert_eq!(claimed.display_name, "Ada Lovelace");
    assert_eq!(claimed.email.as_deref(), Some("ada@example.org"));
    assert_eq!(item.availability.len(), 1);
    assert!(item.answers.iter().any(|answer| answer.value == "Lovelace"));
    let [candidate] = item.candidates.as_slice() else {
        panic!("expected one candidate, got {:?}", item.candidates);
    };
    assert_eq!(candidate.volunteer_id, legacy);
    assert_eq!(
        candidate.display_name, "Ada Lovelace",
        "names are read from the pool at display time, never stored on the submission"
    );
}

#[tokio::test]
async fn matching_by_hand_applies_to_the_chosen_volunteer() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let legacy = fx
        .existing(&mut tx, "Ada Lovelace", (None, None), None)
        .await;
    let (submission_id, _) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;

    let reviewed = resolve(
        &mut tx,
        &fx,
        submission_id,
        &intake::Resolution::Match(legacy),
    )
    .await;
    assert_eq!(
        reviewed,
        Ok(intake::Reviewed::Applied {
            volunteer_id: legacy,
            kind: MatchKind::Manual,
            email_withheld: false,
        })
    );
    let (state, linked, kind, _, _, _) = submission(&mut tx, submission_id).await;
    assert_eq!(
        (state.as_str(), linked, kind.as_deref()),
        ("applied", Some(legacy), Some("manual"))
    );
    assert_eq!(participations(&mut tx, legacy).await.len(), 1);
    let reviewed_by: Option<Uuid> =
        sqlx::query("SELECT reviewed_by FROM submissions WHERE id = $1")
            .bind(submission_id)
            .fetch_one(&mut *tx)
            .await
            .expect("read")
            .get("reviewed_by");
    assert_eq!(reviewed_by, Some(fx.user_id));

    assert_eq!(
        resolve(&mut tx, &fx, submission_id, &intake::Resolution::CreateNew).await,
        Err(intake::Refused::NotPending),
        "resolved once; a second coordinator gets a refusal, not a second volunteer"
    );
}

#[tokio::test]
async fn creating_someone_new_on_an_address_in_use_leaves_the_address_with_its_owner() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let grace = fx
        .existing(
            &mut tx,
            "Grace Hopper",
            (Some("Grace"), Some("Hopper")),
            Some("ada@example.org"),
        )
        .await;
    let (submission_id, _) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;

    let Ok(intake::Reviewed::Applied {
        volunteer_id,
        kind: MatchKind::New,
        email_withheld: true,
    }) = resolve(&mut tx, &fx, submission_id, &intake::Resolution::CreateNew).await
    else {
        panic!("expected a new volunteer without the address");
    };
    assert_ne!(volunteer_id, grace);
    assert_eq!(
        volunteer(&mut tx, volunteer_id)
            .await
            .get::<Option<String>, _>("email"),
        None
    );
    assert_eq!(
        volunteer(&mut tx, grace)
            .await
            .get::<Option<String>, _>("email")
            .as_deref(),
        Some("ada@example.org")
    );
}

#[tokio::test]
async fn matching_by_hand_never_moves_an_address_off_its_owner() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    fx.existing(
        &mut tx,
        "Grace Hopper",
        (Some("Grace"), Some("Hopper")),
        Some("ada@example.org"),
    )
    .await;
    let other = fx
        .existing(
            &mut tx,
            "A. Lovelace",
            (Some("Ada"), None),
            Some("ada@old.example"),
        )
        .await;
    let (submission_id, _) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;

    let reviewed = resolve(
        &mut tx,
        &fx,
        submission_id,
        &intake::Resolution::Match(other),
    )
    .await;
    assert!(
        matches!(
            reviewed,
            Ok(intake::Reviewed::Applied {
                email_withheld: true,
                ..
            })
        ),
        "{reviewed:?}"
    );
    assert_eq!(
        volunteer(&mut tx, other)
            .await
            .get::<Option<String>, _>("email")
            .as_deref(),
        Some("ada@old.example")
    );
}

#[tokio::test]
async fn a_rejected_submission_leaves_the_queue_and_applies_nothing() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    fx.existing(&mut tx, "Ada Lovelace", (None, None), None)
        .await;
    let (submission_id, _) = fx.send(&mut tx, &ADA, &fx.open_air(2)).await;
    assert_eq!(
        resolve(
            &mut tx,
            &fx,
            submission_id,
            &intake::Resolution::Reject("spam".to_owned())
        )
        .await,
        Ok(intake::Reviewed::Rejected)
    );
    let (state, linked, _, _, _, errors) = submission(&mut tx, submission_id).await;
    assert_eq!((state.as_str(), linked), ("rejected", None));
    assert_eq!(errors.expect("errors")[0]["message"], "spam");
    assert!(
        intake::review_queue(&mut tx, fx.org_id)
            .await
            .expect("queue")
            .is_empty()
    );
}

#[tokio::test]
async fn a_held_submission_reconciled_by_hand_runs_the_ladder() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let fx = fixture(&mut tx).await;

    let held = fx
        .record(
            &mut tx,
            &ADA,
            &fx.open_air(2),
            Some(json!([{ "field": "elapsed_ms", "code": "too_fast" }])),
        )
        .await;
    let queue = intake::review_queue(&mut tx, fx.org_id)
        .await
        .expect("queue");
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].reasons[0].code, "too_fast");
    assert!(
        queue[0].candidates.is_empty(),
        "never compared with the pool"
    );

    let reviewed = resolve(&mut tx, &fx, held, &intake::Resolution::Reconcile).await;
    assert!(
        matches!(
            reviewed,
            Ok(intake::Reviewed::Applied {
                kind: MatchKind::New,
                ..
            })
        ),
        "{reviewed:?}"
    );
    assert_eq!(submission(&mut tx, held).await.0, "applied");
}
