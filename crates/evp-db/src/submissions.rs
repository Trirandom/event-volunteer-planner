// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The volunteer pool, participations, availability and the intake
//! provenance trail that explains where they came from (docs/03 §3.3, §3.5,
//! §3.10).
//!
//! [`create_example_volunteers`] is this module's only writer for now: it is
//! what `evp_db::catalog::create_example` calls after it has built the
//! festival's events, so that the worked example arrives with the volunteers
//! who applied to it, the same way it already arrives with locations and
//! shifts. It writes exactly the rows a real CSV import would have left
//! behind — one `intake_sources` row, one `submission_batches` row, and per
//! volunteer a `volunteers` row, a `submissions` row, a `submission_payloads`
//! row, and per event they answered anything about, a `participations` row
//! and its `availability_windows` — without going through the column-mapping
//! pipeline those tables exist to support, because nothing in this vertical
//! slice builds that pipeline yet (see the migration's own doc comment).
//!
//! [`list`] is the read side: `GET …/festivals/{festival}/submissions`.
//! Scoped by `org_id` rather than by festival — see its doc comment for why.
//!
//! Same statement conventions as [`crate::catalog`]: `sqlx::query` rather
//! than the `query!` macros, and every `tstzrange` bound as two
//! `jiff_sqlx::Timestamp` parameters rather than as a Rust range type.

use std::collections::HashMap;
use std::collections::hash_map::Entry;

use jiff::Timestamp;
use jiff_sqlx::ToSqlx as _;
use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;

/// One non-availability answer, rendered for display. Verbatim: the question
/// as the (legacy) form asked it, and the value exactly as given —
/// `submission_payloads.raw` is "exactly what arrived" (docs/03 §3.10), and
/// this is that same payload read back.
#[derive(Debug, Clone)]
pub struct Answer {
    pub question: String,
    pub value: String,
}

/// One `available` window, with the event it was declared for — required on
/// every row, per the API contract, because it is what lets the UI narrow a
/// festival's submissions down to the day a coordinator is planning.
#[derive(Debug, Clone)]
pub struct AvailabilityWindow {
    pub event_id: Uuid,
    pub start: Timestamp,
    pub end: Timestamp,
}

#[derive(Debug, Clone)]
pub struct Submission {
    pub id: Uuid,
    pub display_name: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub submitted_at: Timestamp,
    pub answers: Vec<Answer>,
    pub availability: Vec<AvailabilityWindow>,
}

/// Every submission in the organisation whose identity has been resolved to a
/// volunteer, oldest first.
///
/// Scoped by `org_id`, not by the `{festival}` in the route. The documented
/// schema has nothing narrower to scope by: `submissions` and
/// `intake_sources` carry an optional `event_id`, not a `festival_id`, and
/// this fixture's one source spans every event of the festival rather than
/// naming one (docs/03 §3.10 — `intake_sources.event_id`'s own comment reads
/// "NULL: not scoped to a single event"). `evp_db::catalog::org_has_any_festival`
/// is already the invariant that every M0 organisation has at most one
/// festival, so `org_id` and `festival_id` pick out the same submissions in
/// practice. A deployment with more than one festival per organisation would
/// need `festival_id` added to `intake_sources` — out of scope here, and
/// noted rather than approximated.
///
/// Only `applied` submissions are returned. One not yet matched (`received`,
/// or `needs_review`) has no volunteer, and the API contract's `display_name`
/// is a plain string, never null: there is no name to show for an identity
/// nobody has resolved, and it belongs in the review queue instead. One that
/// is `superseded` was replaced by the same volunteer's later answer to the
/// same form (`evp_db::intake`), which is the one shown — each person once,
/// with what they said last.
///
/// # Errors
///
/// [`DbError::Query`] if any statement fails.
pub async fn list(conn: &mut PgConnection, org_id: Uuid) -> Result<Vec<Submission>, DbError> {
    let rows = sqlx::query(
        "SELECT s.id, s.form_version_id, s.locale, v.display_name, v.first_name, v.last_name, \
                coalesce(s.submitted_at, s.received_at) AS submitted_at \
           FROM submissions s \
           JOIN volunteers v ON v.id = s.volunteer_id AND v.org_id = s.org_id \
          WHERE s.org_id = $1 AND s.state = 'applied' \
          ORDER BY coalesce(s.submitted_at, s.received_at) ASC, s.id ASC",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    // A festival's submissions answered a handful of versions at most.
    let mut versions: HashMap<Uuid, Vec<crate::forms::Question>> = HashMap::new();
    let mut submissions = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row.try_get("id").map_err(DbError::Query)?;
        let form_version_id: Option<Uuid> =
            row.try_get("form_version_id").map_err(DbError::Query)?;
        let questions = match form_version_id {
            Some(version_id) => {
                if let Entry::Vacant(slot) = versions.entry(version_id) {
                    slot.insert(crate::forms::questions_of(conn, org_id, version_id).await?);
                }
                versions.get(&version_id).map(Vec::as_slice)
            }
            None => None,
        };
        let locale = row
            .try_get::<Option<String>, _>("locale")
            .map_err(DbError::Query)?
            .and_then(|locale| evp_domain::form::Locale::parse(&locale))
            .unwrap_or(evp_domain::form::Locale::Fr);
        submissions.push(Submission {
            id,
            display_name: row.try_get("display_name").map_err(DbError::Query)?,
            first_name: row.try_get("first_name").map_err(DbError::Query)?,
            last_name: row.try_get("last_name").map_err(DbError::Query)?,
            submitted_at: row
                .try_get::<jiff_sqlx::Timestamp, _>("submitted_at")
                .map_err(DbError::Query)?
                .to_jiff(),
            answers: answers_for(conn, org_id, id, questions, locale).await?,
            availability: availability_for(conn, org_id, id).await?,
        });
    }
    Ok(submissions)
}

/// The answers one submission's payload holds, as a coordinator reads them.
///
/// Two payload shapes. An imported row (the worked example) stores a plain
/// array of `{question, value}` pairs: an object's key order is not part of
/// JSON's data model, and the array is what keeps the order the legacy form
/// asked them in. A first-party form stores `{answers: {question id: value},
/// …}`, keyed by id — and the version it pinned (`questions`) supplies both
/// the order and the wording, so the object's key order never matters.
///
/// `None` for `questions` with an object payload is a version that no longer
/// resolves; there is nothing to label the answers with, so none are shown.
async fn answers_for(
    conn: &mut PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
    questions: Option<&[crate::forms::Question]>,
    locale: evp_domain::form::Locale,
) -> Result<Vec<Answer>, DbError> {
    let row =
        sqlx::query("SELECT raw FROM submission_payloads WHERE org_id = $1 AND submission_id = $2")
            .bind(org_id)
            .bind(submission_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(DbError::Query)?;
    let Some(row) = row else {
        return Ok(Vec::new());
    };
    let raw: serde_json::Value = row.try_get("raw").map_err(DbError::Query)?;
    if let (Some(answers), Some(questions)) = (
        raw.get("answers").and_then(serde_json::Value::as_object),
        questions,
    ) {
        return Ok(form_answers(answers, questions, locale));
    }
    let Some(entries) = raw.as_array() else {
        return Ok(Vec::new());
    };
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let question = entry.get("question")?.as_str()?.to_owned();
            let value = entry.get("value")?.as_str()?.to_owned();
            Some(Answer { question, value })
        })
        .collect())
}

/// A first-party form's answers, in the order the version asked them,
/// labelled with its French wording — the admin's language, and the one every
/// form is written in first — and with each choice shown as the option's
/// label rather than its stored value.
///
/// Left out: what has a column of its own on this screen (availability), what
/// is not an answer (a section), what a coordinator does not read per
/// volunteer (a consent the form could not be sent without), and anything
/// left blank.
pub(crate) fn form_answers(
    answers: &serde_json::Map<String, serde_json::Value>,
    questions: &[crate::forms::Question],
    locale: evp_domain::form::Locale,
) -> Vec<Answer> {
    use evp_domain::form::{Locale, QuestionKind};
    use evp_domain::submission::Answer as Given;

    let option_label = |question: &crate::forms::Question, value: &str| -> String {
        question
            .draft
            .options
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|option| option.value == value)
            .map_or_else(|| value.to_owned(), |option| option.label.fr.clone())
    };

    questions
        .iter()
        .filter(|question| {
            !matches!(
                question.draft.kind,
                QuestionKind::Section | QuestionKind::Availability | QuestionKind::Consent
            )
        })
        .filter_map(|question| {
            let given = Given::from_json(answers.get(&question.id.to_string())?);
            let value = match given {
                Given::Text(text) if question.draft.kind == QuestionKind::SingleChoice => {
                    option_label(question, text.trim())
                }
                Given::Text(text) => text.trim().to_owned(),
                Given::List(values) => values
                    .iter()
                    .map(|value| option_label(question, value))
                    .collect::<Vec<_>>()
                    .join(", "),
                Given::Flag(true) => "Oui".to_owned(),
                Given::Flag(false) => "Non".to_owned(),
                Given::Null | Given::Other => return None,
            };
            if value.is_empty() {
                return None;
            }
            let label = question
                .draft
                .label
                .get(Locale::Fr)
                .or_else(|| question.draft.label.get(locale))
                .unwrap_or(&question.draft.label.fr);
            Some(Answer {
                question: label.to_owned(),
                value,
            })
        })
        .collect()
}

async fn availability_for(
    conn: &mut PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
) -> Result<Vec<AvailabilityWindow>, DbError> {
    let rows = sqlx::query(
        "SELECT p.event_id, lower(aw.period) AS start, upper(aw.period) AS end \
           FROM availability_windows aw \
           JOIN participations p ON p.id = aw.participation_id AND p.org_id = aw.org_id \
          WHERE aw.org_id = $1 AND aw.source_submission_id = $2 AND aw.kind = 'available' \
          ORDER BY lower(aw.period) ASC",
    )
    .bind(org_id)
    .bind(submission_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    rows.iter()
        .map(|row| {
            Ok(AvailabilityWindow {
                event_id: row.try_get("event_id").map_err(DbError::Query)?,
                start: row
                    .try_get::<jiff_sqlx::Timestamp, _>("start")
                    .map_err(DbError::Query)?
                    .to_jiff(),
                end: row
                    .try_get::<jiff_sqlx::Timestamp, _>("end")
                    .map_err(DbError::Query)?
                    .to_jiff(),
            })
        })
        .collect()
}

/// Persists every volunteer of the worked example fixture, on the caller's
/// already-open transaction — called from `catalog::create_example` after
/// the festival's events exist, so a volunteer's participations can resolve
/// `event_slug` to a real `event_id`.
///
/// Writes one shared `intake_sources` row (kind `csv_upload`, matching the
/// real Google Sheet this fixture is transcribed from) and one
/// `submission_batches` row for the whole load, then per
/// [`evp_domain::example::VolunteerFixture`]: a `volunteers` row, a
/// `submissions` row already `applied` (the fixture bypasses reconciliation
/// entirely — there is no candidate to disambiguate, `match_kind = 'new'`),
/// its `submission_payloads` row, and per
/// [`evp_domain::example::ParticipationFixture`] a `participations` row, one
/// `availability_windows` row per declared range and one `assignments` row
/// per shift they were given.
///
/// Every id created is pushed onto `entity_ids`, so the operation this is
/// called from (`festival.create_example`) scopes its undo over the
/// volunteers and submissions it wrote, not only the festival structure.
///
/// # Errors
///
/// [`DbError::Query`] if any statement fails. Every insert happens on the
/// caller's already-open transaction, so a failure partway through leaves
/// nothing committed.
pub(crate) async fn create_example_volunteers(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
    fixture: &evp_domain::example::FestivalFixture,
    events: &HashMap<String, ExampleEvent>,
    entity_ids: &mut Vec<Uuid>,
) -> Result<(), DbError> {
    if fixture.volunteers.is_empty() {
        return Ok(());
    }

    // One file name for both rows: the batch records which upload it was, and
    // the source records where uploads of this shape come from. Two
    // independently formatted copies of one string is how those drift.
    let file_name = format!("form Bénévole {} - réponses.csv", fixture.name);

    let source_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO intake_sources (id, org_id, kind, name, created_by) \
         VALUES ($1, $2, 'csv_upload', $3, $4)",
    )
    .bind(source_id)
    .bind(org_id)
    .bind(&file_name)
    .bind(actor_id)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    entity_ids.push(source_id);

    let batch_id = Uuid::now_v7();
    let row_count = i32::try_from(fixture.volunteers.len()).unwrap_or(i32::MAX);
    sqlx::query(
        "INSERT INTO submission_batches \
           (id, org_id, source_id, trigger, file_name, row_count, outcome, created_by) \
         VALUES ($1, $2, $3, 'upload', $4, $5, 'accepted', $6)",
    )
    .bind(batch_id)
    .bind(org_id)
    .bind(source_id)
    .bind(&file_name)
    .bind(row_count)
    .bind(actor_id)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    entity_ids.push(batch_id);

    let load = ExampleLoad {
        org_id,
        actor_id,
        source_id,
        batch_id,
        events,
    };

    for (index, volunteer) in fixture.volunteers.iter().enumerate() {
        insert_example_volunteer(conn, &load, index, volunteer, entity_ids).await?;
    }

    Ok(())
}

/// One event the example has just inserted, as its volunteers need it.
pub(crate) struct ExampleEvent {
    pub(crate) id: Uuid,
    /// In [`evp_domain::example::EventFixture::shifts`] order, which is what
    /// an [`evp_domain::example::AssignmentFixture::shift`] indexes.
    pub(crate) shift_ids: Vec<Uuid>,
}

/// The ids and the lookup every volunteer of one example load shares.
///
/// Bundled rather than passed one by one so that
/// [`insert_example_volunteer`] stays under the argument limit *and* so that
/// its signature says what it is: everything here is fixed for the whole
/// load, and only the volunteer varies.
struct ExampleLoad<'a> {
    org_id: Uuid,
    /// Who clicked the button: `declared_by` of a coordinator-typed window
    /// and `assigned_by` of every assignment, since the dump's own
    /// coordinators are not users of the org being loaded into.
    actor_id: Uuid,
    source_id: Uuid,
    batch_id: Uuid,
    /// Event slug → the event, built by the caller from the events it has
    /// just inserted.
    events: &'a HashMap<String, ExampleEvent>,
}

/// One volunteer: the pool row, the submission that produced it, its raw
/// payload, and a participation with its windows per event they answered for.
///
/// Split out of [`create_example_volunteers`] so that function reads as what
/// it is — one source, one batch, then each volunteer — rather than as a
/// hundred lines in which the shared setup and the per-row work are only
/// distinguishable by indentation.
///
/// # Errors
///
/// [`DbError::Query`] if any statement fails.
async fn insert_example_volunteer(
    conn: &mut PgConnection,
    load: &ExampleLoad<'_>,
    index: usize,
    volunteer: &evp_domain::example::VolunteerFixture,
    entity_ids: &mut Vec<Uuid>,
) -> Result<(), DbError> {
    let ExampleLoad {
        org_id,
        source_id,
        batch_id,
        ..
    } = *load;

    let volunteer_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO volunteers \
           (id, org_id, display_name, first_name, last_name, email, phone, tshirt_size, \
            dietary, notes, is_core_team) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(volunteer_id)
    .bind(org_id)
    .bind(&volunteer.display_name)
    .bind(&volunteer.first_name)
    .bind(&volunteer.last_name)
    .bind(&volunteer.email)
    .bind(&volunteer.phone)
    .bind(&volunteer.tshirt_size)
    .bind(&volunteer.dietary)
    .bind(&volunteer.notes)
    .bind(volunteer.is_core_team)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    entity_ids.push(volunteer_id);

    let submission_id = Uuid::now_v7();
    let raw_keys: Vec<String> = volunteer
        .answers
        .iter()
        .map(|answer| answer.question.clone())
        .collect();
    // `applied_at` falls back to the load itself when the dump had no
    // submission time: an applied submission must say when it was applied,
    // and "when this example was loaded" is the honest answer.
    sqlx::query(
        "INSERT INTO submissions \
               (id, org_id, source_id, batch_id, external_id, raw_keys, submitted_at, \
                state, volunteer_id, match_kind, applied_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'applied', $8, 'new', \
                     coalesce($7, statement_timestamp()))",
    )
    .bind(submission_id)
    .bind(org_id)
    .bind(source_id)
    .bind(batch_id)
    .bind(format!("row-{index}"))
    .bind(&raw_keys)
    .bind(volunteer.submitted_at.map(jiff_sqlx::ToSqlx::to_sqlx))
    .bind(volunteer_id)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    entity_ids.push(submission_id);

    let raw: Vec<serde_json::Value> = volunteer
        .answers
        .iter()
        .map(|answer| serde_json::json!({ "question": answer.question, "value": answer.value }))
        .collect();
    sqlx::query("INSERT INTO submission_payloads (submission_id, org_id, raw) VALUES ($1, $2, $3)")
        .bind(submission_id)
        .bind(org_id)
        .bind(serde_json::Value::Array(raw))
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;

    for participation in &volunteer.participations {
        insert_example_participation(
            conn,
            load,
            (volunteer_id, &volunteer.display_name),
            submission_id,
            participation,
            entity_ids,
        )
        .await?;
    }

    Ok(())
}

/// One participation of one example volunteer: the row, its windows, and its
/// assignments. Split out of [`insert_example_volunteer`] for length only.
///
/// # Errors
///
/// [`DbError::Query`] if any statement fails; [`DbError::Fixture`] if the
/// participation names an event or shift the load did not create.
async fn insert_example_participation(
    conn: &mut PgConnection,
    load: &ExampleLoad<'_>,
    (volunteer_id, display_name): (Uuid, &str),
    submission_id: Uuid,
    participation: &evp_domain::example::ParticipationFixture,
    entity_ids: &mut Vec<Uuid>,
) -> Result<(), DbError> {
    let ExampleLoad {
        org_id,
        actor_id,
        events,
        ..
    } = *load;

    // `evp_domain::example::build` already refused a slug or shift index
    // that names nothing; failing here too, rather than skipping, keeps
    // an unchecked fixture from loading a silently partial plan.
    let event = events.get(&participation.event_slug).ok_or_else(|| {
        crate::catalog::dangling(format!(
            "{} participates in unknown event {}",
            display_name, participation.event_slug
        ))
    })?;
    let participation_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO participations (id, org_id, event_id, volunteer_id, status) \
             VALUES ($1, $2, $3, $4, $5::participation_status)",
    )
    .bind(participation_id)
    .bind(org_id)
    .bind(event.id)
    .bind(volunteer_id)
    .bind(participation.status.as_str())
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    entity_ids.push(participation_id);

    for window in &participation.windows {
        let window_id = Uuid::now_v7();
        // Exactly one provenance (`availability_has_provenance`): the
        // submission it was read off, or the coordinator who typed it.
        let (declared_by, source_submission_id) = if window.declared {
            (Some(actor_id), None)
        } else {
            (None, Some(submission_id))
        };
        sqlx::query(
            "INSERT INTO availability_windows \
                   (id, org_id, participation_id, kind, period, note, declared_by, \
                    source_submission_id) \
                 VALUES ($1, $2, $3, $4::availability_kind, tstzrange($5, $6), $7, $8, $9)",
        )
        .bind(window_id)
        .bind(org_id)
        .bind(participation_id)
        .bind(window.kind.as_str())
        .bind(window.period.0.to_sqlx())
        .bind(window.period.1.to_sqlx())
        .bind(&window.note)
        .bind(declared_by)
        .bind(source_submission_id)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;
        entity_ids.push(window_id);
    }

    for assignment in &participation.assignments {
        let shift_id = *event.shift_ids.get(assignment.shift).ok_or_else(|| {
            crate::catalog::dangling(format!(
                "{} is assigned unknown shift {} of {}",
                display_name, assignment.shift, participation.event_slug
            ))
        })?;
        let assignment_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO assignments \
               (id, org_id, event_id, shift_id, participation_id, volunteer_id, period, \
                status, assigned_by, acknowledged_warnings) \
             SELECT $1, $2, $3, $4, $5, $6, s.period, $7::assignment_status, $8, $9 \
               FROM shifts s WHERE s.id = $4 AND s.org_id = $2",
        )
        .bind(assignment_id)
        .bind(org_id)
        .bind(event.id)
        .bind(shift_id)
        .bind(participation_id)
        .bind(volunteer_id)
        .bind(assignment.status.as_str())
        .bind(actor_id)
        .bind(&assignment.acknowledged_warnings)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;
        entity_ids.push(assignment_id);
    }

    Ok(())
}
