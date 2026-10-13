// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The first-party form's authoring side (docs/03 §3.11, docs/04 §"The
//! volunteer form"): forms, their versions and their questions.
//!
//! What this module enforces and what it leaves to its callers:
//!
//! * **A published version is never written.** Every write that touches a
//!   version's questions asserts `published_at IS NULL` in the same statement
//!   that takes the row, so a publish racing a `PUT` leaves one of them with
//!   [`DraftWrite::Published`] rather than editing a frozen version.
//! * **The rules of a valid question set are `evp_domain::form`'s.** Callers
//!   run [`evp_domain::form::validate_draft`] / `validate_publish` before a
//!   write; the constraints in migration `…164319` are the backstop, and
//!   reaching one of them is a caller bug surfaced as a SQLSTATE.
//!
//! Same statement conventions as [`crate::catalog`]: runtime `sqlx::query`,
//! enums read back as text, and `jsonb` columns decoded through serde into
//! the domain's own types.

use evp_domain::form::{
    ConsentPurpose, Localized, MissionOption, MissionRow, QuestionDraft, QuestionKind,
    QuestionOption, TargetPath,
};
use jiff::Timestamp;
use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;
use crate::catalog::{OperationId, Versioned, record_form_operation};

/// One version as the form lists it.
#[derive(Debug, Clone)]
pub struct VersionSummary {
    pub id: Uuid,
    pub version: i32,
    pub published_at: Option<Timestamp>,
    pub question_count: i64,
}

#[derive(Debug, Clone)]
pub struct Form {
    pub id: Uuid,
    pub org_id: Uuid,
    pub festival_id: Option<Uuid>,
    pub event_id: Option<Uuid>,
    pub slug: String,
    pub name: String,
    pub live_version_id: Option<Uuid>,
    pub public_open: bool,
    /// `fr` or `en` (`forms_default_locale_known`).
    pub default_locale: String,
    /// The row's own concurrency token.
    pub version: i32,
    /// Oldest first.
    pub versions: Vec<VersionSummary>,
}

impl Form {
    /// Does the form cover any events at all? A pool-recruitment form does
    /// not, and cannot ask about availability or missions.
    #[must_use]
    pub fn is_scoped(&self) -> bool {
        self.festival_id.is_some() || self.event_id.is_some()
    }

    /// Has any version ever been published? Once one has, submissions may
    /// point at it and the form cannot be deleted (docs/04).
    #[must_use]
    pub fn was_ever_published(&self) -> bool {
        self.live_version_id.is_some()
            || self
                .versions
                .iter()
                .any(|version| version.published_at.is_some())
    }
}

#[derive(Debug, Clone)]
pub struct Question {
    pub id: Uuid,
    pub position: i32,
    pub draft: QuestionDraft,
}

#[derive(Debug, Clone)]
pub struct FormVersion {
    pub id: Uuid,
    pub form_id: Uuid,
    pub version: i32,
    pub published_at: Option<Timestamp>,
    pub published_by: Option<Uuid>,
    pub privacy_notice_version: Option<String>,
    /// The draft's `ETag`: bumped by every write to the row.
    pub etag_version: i32,
    /// In `position` order.
    pub questions: Vec<Question>,
}

impl FormVersion {
    /// The submitted question list, as the domain validators take it.
    #[must_use]
    pub fn drafts(&self) -> Vec<QuestionDraft> {
        self.questions
            .iter()
            .map(|question| question.draft.clone())
            .collect()
    }
}

/// The outcome of a write to a version (or to a form whose versions decide
/// whether it may be written). [`Versioned`] plus the one refusal a draft
/// has that other resources do not.
#[derive(Debug, Clone)]
pub enum DraftWrite<T> {
    Applied(T),
    Stale {
        current: i32,
    },
    Missing,
    /// The version is published (or, for a form, one of its versions is), so
    /// it is frozen.
    Published,
}

/// The outcome of `POST …/versions`.
#[derive(Debug, Clone)]
pub enum NewDraft {
    Created(Box<(FormVersion, OperationId)>),
    /// There is a draft already; edit that one.
    DraftExists,
    /// Nothing is live to copy from. Unreachable through the API while every
    /// form is created with a draft — the draft is what is in the way — but
    /// stated rather than assumed.
    NoLiveVersion,
    Missing,
}

/// How a path names a version: by id, or by its number within the form.
#[derive(Debug, Clone, Copy)]
pub enum VersionRef {
    Id(Uuid),
    Number(i32),
}

fn decode_failure(message: String) -> DbError {
    DbError::Query(sqlx::Error::Decode(message.into()))
}

fn from_json<T: serde::de::DeserializeOwned>(
    value: serde_json::Value,
    column: &str,
) -> Result<T, DbError> {
    serde_json::from_value(value)
        .map_err(|error| decode_failure(format!("form_questions.{column}: {error}")))
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<serde_json::Value, DbError> {
    serde_json::to_value(value).map_err(|error| DbError::Query(sqlx::Error::Encode(error.into())))
}

fn decode_question(row: &sqlx::postgres::PgRow) -> Result<Question, DbError> {
    let kind_text: String = row.try_get("kind").map_err(DbError::Query)?;
    let kind = QuestionKind::parse(&kind_text)
        .ok_or_else(|| decode_failure(format!("unknown form_question_kind {kind_text:?}")))?;
    let consent_purpose = row
        .try_get::<Option<String>, _>("consent_purpose")
        .map_err(DbError::Query)?
        .map(|text| {
            ConsentPurpose::parse(&text)
                .ok_or_else(|| decode_failure(format!("unknown consent_purpose {text:?}")))
        })
        .transpose()?;
    let target_path = row
        .try_get::<Option<String>, _>("target_path")
        .map_err(DbError::Query)?
        .map(|text| {
            TargetPath::parse(&text)
                .ok_or_else(|| decode_failure(format!("unknown target_path {text:?}")))
        })
        .transpose()?;
    let label: Localized = from_json(
        row.try_get::<serde_json::Value, _>("label")
            .map_err(DbError::Query)?,
        "label",
    )?;
    let help_text: Option<Localized> = row
        .try_get::<Option<serde_json::Value>, _>("help_text")
        .map_err(DbError::Query)?
        .map(|value| from_json(value, "help_text"))
        .transpose()?;
    let options: Option<Vec<QuestionOption>> = row
        .try_get::<Option<serde_json::Value>, _>("options")
        .map_err(DbError::Query)?
        .map(|value| from_json(value, "options"))
        .transpose()?;

    Ok(Question {
        id: row.try_get("id").map_err(DbError::Query)?,
        position: row.try_get("position").map_err(DbError::Query)?,
        draft: QuestionDraft {
            kind,
            target_path,
            consent_purpose,
            label,
            help_text,
            options,
            is_required: row.try_get("is_required").map_err(DbError::Query)?,
            is_sensitive: row.try_get("is_sensitive").map_err(DbError::Query)?,
        },
    })
}

fn timestamp(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<Timestamp>, DbError> {
    Ok(row
        .try_get::<Option<jiff_sqlx::Timestamp>, _>(column)
        .map_err(DbError::Query)?
        .map(jiff_sqlx::Timestamp::to_jiff))
}

fn decode_form(row: &sqlx::postgres::PgRow) -> Result<Form, DbError> {
    Ok(Form {
        id: row.try_get("id").map_err(DbError::Query)?,
        org_id: row.try_get("org_id").map_err(DbError::Query)?,
        festival_id: row.try_get("festival_id").map_err(DbError::Query)?,
        event_id: row.try_get("event_id").map_err(DbError::Query)?,
        slug: row.try_get("slug").map_err(DbError::Query)?,
        name: row.try_get("name").map_err(DbError::Query)?,
        live_version_id: row.try_get("live_version_id").map_err(DbError::Query)?,
        public_open: row.try_get("public_open").map_err(DbError::Query)?,
        default_locale: row.try_get("default_locale").map_err(DbError::Query)?,
        version: row.try_get("version").map_err(DbError::Query)?,
        versions: Vec::new(),
    })
}

/// Fills in `versions` for every form in `forms`, in one statement.
async fn attach_versions(
    conn: &mut PgConnection,
    org_id: Uuid,
    forms: &mut [Form],
) -> Result<(), DbError> {
    let ids: Vec<Uuid> = forms.iter().map(|form| form.id).collect();
    let rows = sqlx::query(
        "SELECT v.form_id, v.id, v.version, v.published_at, \
                (SELECT count(*) FROM form_questions q WHERE q.form_version_id = v.id)::bigint \
                  AS question_count \
           FROM form_versions v \
          WHERE v.org_id = $1 AND v.form_id = ANY($2) \
          ORDER BY v.form_id, v.version",
    )
    .bind(org_id)
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    for row in &rows {
        let form_id: Uuid = row.try_get("form_id").map_err(DbError::Query)?;
        let summary = VersionSummary {
            id: row.try_get("id").map_err(DbError::Query)?,
            version: row.try_get("version").map_err(DbError::Query)?,
            published_at: timestamp(row, "published_at")?,
            question_count: row.try_get("question_count").map_err(DbError::Query)?,
        };
        if let Some(form) = forms.iter_mut().find(|form| form.id == form_id) {
            form.versions.push(summary);
        }
    }
    Ok(())
}

/// Every form in the organisation, optionally narrowed to one festival's or
/// one event's, newest first.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn list(
    conn: &mut PgConnection,
    org_id: Uuid,
    festival_id: Option<Uuid>,
    event_id: Option<Uuid>,
) -> Result<Vec<Form>, DbError> {
    let rows = sqlx::query(
        "SELECT id, org_id, festival_id, event_id, slug::text AS slug, name, \
                live_version_id, public_open, default_locale, version \
           FROM forms \
          WHERE org_id = $1 \
            AND ($2::uuid IS NULL OR festival_id = $2) \
            AND ($3::uuid IS NULL OR event_id = $3) \
          ORDER BY created_at DESC, id DESC",
    )
    .bind(org_id)
    .bind(festival_id)
    .bind(event_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let mut forms = rows
        .iter()
        .map(decode_form)
        .collect::<Result<Vec<_>, _>>()?;
    attach_versions(conn, org_id, &mut forms).await?;
    Ok(forms)
}

/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn get(conn: &mut PgConnection, org_id: Uuid, id: Uuid) -> Result<Option<Form>, DbError> {
    let row = sqlx::query(
        "SELECT id, org_id, festival_id, event_id, slug::text AS slug, name, \
                live_version_id, public_open, default_locale, version \
           FROM forms WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut forms = vec![decode_form(&row)?];
    attach_versions(conn, org_id, &mut forms).await?;
    Ok(forms.pop())
}

/// The organisation's display name, which the volunteer-commitment question
/// names (ADR-0040, [`evp_domain::form::commitment_question`]). Read on the
/// caller's org-scoped transaction, where `organizations_tenant_isolation`
/// admits exactly this one row.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails or the row is not visible.
pub async fn organization_name(conn: &mut PgConnection, org_id: Uuid) -> Result<String, DbError> {
    sqlx::query_scalar("SELECT name FROM organizations WHERE id = $1")
        .bind(org_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(DbError::Query)
}

/// The scope's `locations` rows in the order the admin app's missions fold
/// walks them (`apps/admin/src/plan/missionCatalog.ts`): events by start,
/// then each zone in tree order followed by its posts. Feed the result to
/// [`evp_domain::form::fold_missions`].
///
/// A post carries its zone's form flags, not its own columns, which hold the
/// neutral values (`locations_posts_have_no_form_flags`).
///
/// A form with neither scope has no events and so no rows.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn mission_rows(
    conn: &mut PgConnection,
    org_id: Uuid,
    festival_id: Option<Uuid>,
    event_id: Option<Uuid>,
) -> Result<Vec<MissionRow>, DbError> {
    let rows = sqlx::query(
        "SELECT l.event_id, l.name, \
                coalesce(z.checked_by_default, l.checked_by_default) AS checked_by_default, \
                coalesce(z.adults_only, l.adults_only) AS adults_only \
           FROM locations l \
           JOIN events e ON e.id = l.event_id AND e.org_id = l.org_id \
           LEFT JOIN locations z ON z.id = l.parent_id AND z.org_id = l.org_id \
          WHERE l.org_id = $1 \
            AND (($2::uuid IS NOT NULL AND e.festival_id = $2) \
              OR ($3::uuid IS NOT NULL AND e.id = $3)) \
          ORDER BY lower(e.period), e.created_at DESC, e.id, \
                   coalesce(z.sort_order, l.sort_order), coalesce(z.name, l.name), \
                   coalesce(z.id, l.id), (l.parent_id IS NOT NULL), l.sort_order, l.name",
    )
    .bind(org_id)
    .bind(festival_id)
    .bind(event_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    rows.iter()
        .map(|row| {
            Ok(MissionRow {
                event_id: row.try_get("event_id").map_err(DbError::Query)?,
                name: row.try_get("name").map_err(DbError::Query)?,
                checked_by_default: row.try_get("checked_by_default").map_err(DbError::Query)?,
                adults_only: row.try_get("adults_only").map_err(DbError::Query)?,
            })
        })
        .collect()
}

/// Re-stamps the `missions` options of a draft with the form flags of the
/// scope's missions as they are now ([`evp_domain::form::stamp_missions`]).
/// Called just before [`publish`], so the version freezes what the zones say
/// at that moment, not what they said at the last `PUT`.
///
/// Leaves `etag_version` alone. Only `form_versions` bumps it, and this is
/// part of publishing, not an edit someone else could be racing.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails or a stored option list does not
/// decode.
pub async fn stamp_missions(
    conn: &mut PgConnection,
    org_id: Uuid,
    version_id: Uuid,
    missions: &[MissionOption],
) -> Result<(), DbError> {
    let rows = sqlx::query(
        "SELECT id, options FROM form_questions \
          WHERE org_id = $1 AND form_version_id = $2 AND kind = 'missions'",
    )
    .bind(org_id)
    .bind(version_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    for row in rows {
        let id: Uuid = row.try_get("id").map_err(DbError::Query)?;
        let stored: serde_json::Value = row.try_get("options").map_err(DbError::Query)?;
        let mut options: Vec<QuestionOption> = from_json(stored, "options")?;
        evp_domain::form::stamp_mission_options(&mut options, missions);
        sqlx::query("UPDATE form_questions SET options = $3 WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .bind(to_json(&options)?)
            .execute(&mut *conn)
            .await
            .map_err(DbError::Query)?;
    }
    Ok(())
}

async fn insert_questions(
    conn: &mut PgConnection,
    org_id: Uuid,
    version_id: Uuid,
    questions: &[QuestionDraft],
) -> Result<(), DbError> {
    for (index, question) in questions.iter().enumerate() {
        let position = i32::try_from(index)
            .map_err(|error| DbError::Query(sqlx::Error::Encode(error.into())))?;
        let help_text = question.help_text.as_ref().map(to_json).transpose()?;
        let options = question.options.as_ref().map(to_json).transpose()?;
        sqlx::query(
            "INSERT INTO form_questions \
               (id, org_id, form_version_id, kind, consent_purpose, target_path, label, \
                help_text, options, is_required, is_sensitive, position) \
             VALUES ($1, $2, $3, $4::form_question_kind, $5::consent_purpose, $6, $7, $8, $9, \
                     $10, $11, $12)",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(version_id)
        .bind(question.kind.as_str())
        .bind(question.consent_purpose.map(ConsentPurpose::as_str))
        .bind(question.target_path.map(TargetPath::as_str))
        .bind(to_json(&question.label)?)
        .bind(help_text)
        .bind(options)
        .bind(question.is_required)
        .bind(question.is_sensitive)
        .bind(position)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;
    }
    Ok(())
}

/// A question list as an inverse command carries it: exactly the
/// `QuestionInput` shape a `PUT` would send to restore it.
fn questions_json(questions: &[QuestionDraft]) -> serde_json::Value {
    serde_json::Value::Array(
        questions
            .iter()
            .map(|question| {
                serde_json::json!({
                    "kind": question.kind.as_str(),
                    "target_path": question.target_path.map(TargetPath::as_str),
                    "consent_purpose": question.consent_purpose.map(ConsentPurpose::as_str),
                    "label": question.label,
                    "help_text": question.help_text,
                    "options": question.options,
                    "is_required": question.is_required,
                    "is_sensitive": question.is_sensitive,
                })
            })
            .collect(),
    )
}

/// What `POST …/forms` asks for. At most one of the two scopes — the API
/// says so first, `forms_one_scope` is the backstop.
#[derive(Debug, Clone)]
pub struct NewForm {
    pub name: String,
    pub slug: String,
    pub festival_id: Option<Uuid>,
    pub event_id: Option<Uuid>,
}

/// Creates a form with version 1 as a draft holding `seed`, and records the
/// operation whose inverse deletes it.
///
/// # Errors
///
/// [`DbError::Query`] on a duplicate slug (`23505`), a scope outside the
/// organisation (`23503`), two scopes (`23514`), or any other failure.
pub async fn create(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
    input: &NewForm,
    seed: &[QuestionDraft],
) -> Result<(Form, OperationId), DbError> {
    let (form_id, version_id) = insert_seeded(conn, org_id, input, seed).await?;

    let operation_id = record_form_operation(
        conn,
        org_id,
        input.event_id,
        actor_id,
        "form.create",
        serde_json::json!({ "name": input.name, "slug": input.slug }),
        serde_json::json!({ "command": "delete_form", "form_id": form_id }),
        &[form_id, version_id],
    )
    .await?;

    let form = get(conn, org_id, form_id)
        .await?
        .ok_or_else(|| decode_failure("the form just inserted is not visible".to_owned()))?;
    Ok((form, operation_id))
}

/// The rows of [`create`] without its `operations` entry, for the worked
/// example, which records one operation for everything it loads. Returns
/// the form's id and its draft's.
pub(crate) async fn insert_seeded(
    conn: &mut PgConnection,
    org_id: Uuid,
    input: &NewForm,
    seed: &[QuestionDraft],
) -> Result<(Uuid, Uuid), DbError> {
    let form_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO forms (id, org_id, festival_id, event_id, slug, name) \
         VALUES ($1, $2, $3, $4, $5::citext, $6)",
    )
    .bind(form_id)
    .bind(org_id)
    .bind(input.festival_id)
    .bind(input.event_id)
    .bind(&input.slug)
    .bind(&input.name)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let version_id = Uuid::now_v7();
    sqlx::query("INSERT INTO form_versions (id, org_id, form_id, version) VALUES ($1, $2, $3, 1)")
        .bind(version_id)
        .bind(org_id)
        .bind(form_id)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;
    insert_questions(conn, org_id, version_id, seed).await?;
    Ok((form_id, version_id))
}

/// The worked example's form: a draft covering the whole festival, seeded
/// exactly as `POST …/forms` seeds it. Left unpublished — publishing is the
/// coordinator's decision, and the example's submissions did not come
/// through it. Returns the ids the example's one operation should name.
pub(crate) async fn create_example(
    conn: &mut PgConnection,
    org_id: Uuid,
    festival: &crate::catalog::Festival,
) -> Result<[Uuid; 2], DbError> {
    let rows = mission_rows(conn, org_id, Some(festival.id), None).await?;
    let organization = organization_name(conn, org_id).await?;
    let seed =
        evp_domain::form::seed_draft(true, &evp_domain::form::fold_missions(&rows), &organization);
    let (form_id, version_id) = insert_seeded(
        conn,
        org_id,
        &NewForm {
            name: format!("Bénévoles {}", festival.name),
            slug: festival.slug.clone(),
            festival_id: Some(festival.id),
            event_id: None,
        },
        &seed,
    )
    .await?;
    Ok([form_id, version_id])
}

/// The fields `PATCH …/forms/{form}` may change. The slug and the scope are
/// deliberately absent: the slug is a URL already sent to volunteers, and
/// the scope is what every version's availability and missions questions
/// were written against.
#[derive(Debug, Clone, Default)]
pub struct FormPatch {
    pub name: Option<String>,
    pub public_open: Option<bool>,
    pub default_locale: Option<String>,
}

impl FormPatch {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.public_open.is_none() && self.default_locale.is_none()
    }
}

/// # Errors
///
/// [`DbError::Query`] if a statement fails, including `23514` for an unknown
/// locale.
pub async fn update(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
    actor_id: Uuid,
    expected_version: Option<i32>,
    patch: &FormPatch,
) -> Result<Versioned<(Form, OperationId)>, DbError> {
    let Some(before) = get(conn, org_id, id).await? else {
        return Ok(Versioned::Missing);
    };
    if expected_version.is_some_and(|expected| expected != before.version) {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    let updated = sqlx::query(
        "UPDATE forms SET \
           name = coalesce($4, name), \
           public_open = coalesce($5, public_open), \
           default_locale = coalesce($6, default_locale) \
         WHERE org_id = $1 AND id = $2 AND ($3::int IS NULL OR version = $3) \
         RETURNING id",
    )
    .bind(org_id)
    .bind(id)
    .bind(expected_version)
    .bind(patch.name.as_deref())
    .bind(patch.public_open)
    .bind(patch.default_locale.as_deref())
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    if updated.is_none() {
        return Ok(Versioned::Stale {
            current: before.version,
        });
    }

    let operation_id = record_form_operation(
        conn,
        org_id,
        before.event_id,
        actor_id,
        "form.update",
        serde_json::json!({ "form_id": id }),
        serde_json::json!({
            "command": "update_form",
            "form_id": id,
            "before": {
                "name": before.name,
                "public_open": before.public_open,
                "default_locale": before.default_locale,
            },
        }),
        &[id],
    )
    .await?;

    let form = get(conn, org_id, id)
        .await?
        .ok_or_else(|| decode_failure("the form just updated is not visible".to_owned()))?;
    Ok(Versioned::Applied((form, operation_id)))
}

/// Deletes a form that was never published, with its draft.
///
/// Refused ([`DraftWrite::Published`]) once any version has been published:
/// submissions may point at it, and the public link has been sent. The
/// operation's inverse carries the whole form — its settings and every
/// version's questions — since nothing else will remember them.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn delete(
    conn: &mut PgConnection,
    org_id: Uuid,
    id: Uuid,
    actor_id: Uuid,
    expected_version: Option<i32>,
) -> Result<DraftWrite<OperationId>, DbError> {
    let Some(before) = get(conn, org_id, id).await? else {
        return Ok(DraftWrite::Missing);
    };
    if before.was_ever_published() {
        return Ok(DraftWrite::Published);
    }
    if expected_version.is_some_and(|expected| expected != before.version) {
        return Ok(DraftWrite::Stale {
            current: before.version,
        });
    }

    let mut versions = Vec::with_capacity(before.versions.len());
    for summary in &before.versions {
        if let Some(version) = get_version(conn, org_id, id, VersionRef::Id(summary.id)).await? {
            versions.push(serde_json::json!({
                "version": version.version,
                "privacy_notice_version": version.privacy_notice_version,
                "questions": questions_json(&version.drafts()),
            }));
        }
    }

    // The published guard is repeated in the statement: a publish committed
    // between the read above and here must win, not be deleted under.
    let deleted = sqlx::query(
        "DELETE FROM forms f WHERE f.org_id = $1 AND f.id = $2 \
           AND ($3::int IS NULL OR f.version = $3) \
           AND f.live_version_id IS NULL \
           AND NOT EXISTS (SELECT 1 FROM form_versions v \
                            WHERE v.form_id = f.id AND v.published_at IS NOT NULL)",
    )
    .bind(org_id)
    .bind(id)
    .bind(expected_version)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    if deleted.rows_affected() == 0 {
        return Ok(match get(conn, org_id, id).await? {
            None => DraftWrite::Missing,
            Some(now) if now.was_ever_published() => DraftWrite::Published,
            Some(now) => DraftWrite::Stale {
                current: now.version,
            },
        });
    }

    let operation_id = record_form_operation(
        conn,
        org_id,
        before.event_id,
        actor_id,
        "form.delete",
        serde_json::json!({ "form_id": id, "name": before.name }),
        serde_json::json!({
            "command": "create_form",
            "form": {
                "name": before.name,
                "slug": before.slug,
                "festival_id": before.festival_id,
                "event_id": before.event_id,
                "public_open": before.public_open,
                "default_locale": before.default_locale,
            },
            "versions": versions,
        }),
        &[id],
    )
    .await?;
    Ok(DraftWrite::Applied(operation_id))
}

/// One version with its questions.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails or a stored question will not
/// decode.
pub async fn get_version(
    conn: &mut PgConnection,
    org_id: Uuid,
    form_id: Uuid,
    version: VersionRef,
) -> Result<Option<FormVersion>, DbError> {
    let (by_id, by_number) = match version {
        VersionRef::Id(id) => (Some(id), None),
        VersionRef::Number(number) => (None, Some(number)),
    };
    let row = sqlx::query(
        "SELECT id, form_id, version, published_at, published_by, privacy_notice_version, \
                etag_version \
           FROM form_versions \
          WHERE org_id = $1 AND form_id = $2 \
            AND ($3::uuid IS NULL OR id = $3) AND ($4::int IS NULL OR version = $4)",
    )
    .bind(org_id)
    .bind(form_id)
    .bind(by_id)
    .bind(by_number)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let id: Uuid = row.try_get("id").map_err(DbError::Query)?;
    let questions = questions_of(conn, org_id, id).await?;

    Ok(Some(FormVersion {
        id,
        form_id: row.try_get("form_id").map_err(DbError::Query)?,
        version: row.try_get("version").map_err(DbError::Query)?,
        published_at: timestamp(&row, "published_at")?,
        published_by: row.try_get("published_by").map_err(DbError::Query)?,
        privacy_notice_version: row
            .try_get("privacy_notice_version")
            .map_err(DbError::Query)?,
        etag_version: row.try_get("etag_version").map_err(DbError::Query)?,
        questions,
    }))
}

/// One version's questions, in `position` order — for a reader that has the
/// version's id from a submission and no use for the rest of the row.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails or a stored question will not
/// decode.
pub(crate) async fn questions_of(
    conn: &mut PgConnection,
    org_id: Uuid,
    version_id: Uuid,
) -> Result<Vec<Question>, DbError> {
    sqlx::query(
        "SELECT id, position, kind::text AS kind, consent_purpose::text AS consent_purpose, \
                target_path, label, help_text, options, is_required, is_sensitive \
           FROM form_questions \
          WHERE org_id = $1 AND form_version_id = $2 \
          ORDER BY position",
    )
    .bind(org_id)
    .bind(version_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?
    .iter()
    .map(decode_question)
    .collect()
}

async fn draft_of(
    conn: &mut PgConnection,
    org_id: Uuid,
    form_id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    let row = sqlx::query(
        "SELECT id FROM form_versions \
          WHERE org_id = $1 AND form_id = $2 AND published_at IS NULL",
    )
    .bind(org_id)
    .bind(form_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    row.map(|row| row.try_get("id").map_err(DbError::Query))
        .transpose()
}

/// A new draft, numbered after the highest version, holding a copy of the
/// live version's questions and privacy-notice version.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails — including `23505` on
/// `form_one_draft` when another request created a draft in between.
pub async fn create_draft(
    conn: &mut PgConnection,
    org_id: Uuid,
    form_id: Uuid,
    actor_id: Uuid,
) -> Result<NewDraft, DbError> {
    let Some(form) = get(conn, org_id, form_id).await? else {
        return Ok(NewDraft::Missing);
    };
    if draft_of(conn, org_id, form_id).await?.is_some() {
        return Ok(NewDraft::DraftExists);
    }
    let Some(live_id) = form.live_version_id else {
        return Ok(NewDraft::NoLiveVersion);
    };
    let Some(live) = get_version(conn, org_id, form_id, VersionRef::Id(live_id)).await? else {
        return Ok(NewDraft::NoLiveVersion);
    };

    let version_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO form_versions (id, org_id, form_id, version, privacy_notice_version) \
         SELECT $1, $2, $3, coalesce(max(version), 0) + 1, $4 \
           FROM form_versions WHERE org_id = $2 AND form_id = $3",
    )
    .bind(version_id)
    .bind(org_id)
    .bind(form_id)
    .bind(live.privacy_notice_version.as_deref())
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    insert_questions(conn, org_id, version_id, &live.drafts()).await?;

    let operation_id = record_form_operation(
        conn,
        org_id,
        form.event_id,
        actor_id,
        "form_version.create",
        serde_json::json!({ "form_id": form_id, "copied_from": live_id }),
        serde_json::json!({ "command": "delete_form_version", "form_id": form_id, "version_id": version_id }),
        &[form_id, version_id],
    )
    .await?;

    let version = get_version(conn, org_id, form_id, VersionRef::Id(version_id))
        .await?
        .ok_or_else(|| decode_failure("the draft just inserted is not visible".to_owned()))?;
    Ok(NewDraft::Created(Box::new((version, operation_id))))
}

/// Takes the draft for a write: the row must exist, be unpublished, and be
/// at `expected` — all asserted by the one `UPDATE`, which also bumps
/// `etag_version`.
async fn take_draft(
    conn: &mut PgConnection,
    org_id: Uuid,
    form_id: Uuid,
    version_id: Uuid,
    expected: Option<i32>,
    privacy_notice_version: crate::catalog::Patch<String>,
    publish_as: Option<Uuid>,
) -> Result<DraftWrite<FormVersion>, DbError> {
    let Some(before) = get_version(conn, org_id, form_id, VersionRef::Id(version_id)).await? else {
        return Ok(DraftWrite::Missing);
    };
    if before.published_at.is_some() {
        return Ok(DraftWrite::Published);
    }
    if expected.is_some_and(|expected| expected != before.etag_version) {
        return Ok(DraftWrite::Stale {
            current: before.etag_version,
        });
    }

    let taken = sqlx::query(
        "UPDATE form_versions SET \
           privacy_notice_version = CASE WHEN $5 THEN $6 ELSE privacy_notice_version END, \
           published_at = CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END, \
           published_by = $7 \
         WHERE org_id = $1 AND form_id = $2 AND id = $3 AND published_at IS NULL \
           AND ($4::int IS NULL OR etag_version = $4) \
         RETURNING id",
    )
    .bind(org_id)
    .bind(form_id)
    .bind(version_id)
    .bind(expected)
    .bind(privacy_notice_version.is_sent())
    .bind(privacy_notice_version.value())
    .bind(publish_as)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    if taken.is_none() {
        return Ok(
            match get_version(conn, org_id, form_id, VersionRef::Id(version_id)).await? {
                None => DraftWrite::Missing,
                Some(now) if now.published_at.is_some() => DraftWrite::Published,
                Some(now) => DraftWrite::Stale {
                    current: now.etag_version,
                },
            },
        );
    }
    Ok(DraftWrite::Applied(before))
}

/// `PUT …/versions/{v}`: replaces the draft's whole question list, and its
/// privacy-notice version when one is sent. The inverse carries the list as
/// it was.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails, including the `form_questions`
/// constraints for a list the caller did not validate.
#[expect(
    clippy::too_many_arguments,
    reason = "the path's three ids, the actor, the precondition and the two halves of the body"
)]
pub async fn replace_questions(
    conn: &mut PgConnection,
    org_id: Uuid,
    form_id: Uuid,
    version_id: Uuid,
    actor_id: Uuid,
    expected: Option<i32>,
    privacy_notice_version: crate::catalog::Patch<String>,
    questions: &[QuestionDraft],
) -> Result<DraftWrite<(FormVersion, OperationId)>, DbError> {
    let before = match take_draft(
        conn,
        org_id,
        form_id,
        version_id,
        expected,
        privacy_notice_version,
        None,
    )
    .await?
    {
        DraftWrite::Applied(before) => before,
        DraftWrite::Stale { current } => return Ok(DraftWrite::Stale { current }),
        DraftWrite::Missing => return Ok(DraftWrite::Missing),
        DraftWrite::Published => return Ok(DraftWrite::Published),
    };

    sqlx::query("DELETE FROM form_questions WHERE org_id = $1 AND form_version_id = $2")
        .bind(org_id)
        .bind(version_id)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;
    insert_questions(conn, org_id, version_id, questions).await?;

    let event_id = event_of(conn, org_id, form_id).await?;
    let operation_id = record_form_operation(
        conn,
        org_id,
        event_id,
        actor_id,
        "form_version.replace",
        serde_json::json!({ "form_id": form_id, "version_id": version_id, "question_count": questions.len() }),
        serde_json::json!({
            "command": "replace_form_questions",
            "form_id": form_id,
            "version_id": version_id,
            "before": {
                "privacy_notice_version": before.privacy_notice_version,
                "questions": questions_json(&before.drafts()),
            },
        }),
        &[form_id, version_id],
    )
    .await?;

    let version = get_version(conn, org_id, form_id, VersionRef::Id(version_id))
        .await?
        .ok_or_else(|| decode_failure("the draft just written is not visible".to_owned()))?;
    Ok(DraftWrite::Applied((version, operation_id)))
}

async fn event_of(
    conn: &mut PgConnection,
    org_id: Uuid,
    form_id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    let row = sqlx::query("SELECT event_id FROM forms WHERE org_id = $1 AND id = $2")
        .bind(org_id)
        .bind(form_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(DbError::Query)?;
    Ok(row
        .map(|row| row.try_get::<Option<Uuid>, _>("event_id"))
        .transpose()
        .map_err(DbError::Query)?
        .flatten())
}

/// Freezes the draft and makes it the form's live version. The version it
/// replaces stays, frozen, for the submissions that answered it.
///
/// The caller has already run `validate_publish` against the version it
/// read; `expected` is what guarantees that is still the version being
/// frozen.
///
/// The inverse restores the previous live version and reopens this one as a
/// draft. Replaying it must be refused once this version has submissions
/// (docs/04) — which cannot happen yet: nothing records a submission against
/// a form version until the public form lands, and neither does the undo
/// endpoint exist. The command says so, so the replayer cannot miss it.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn publish(
    conn: &mut PgConnection,
    org_id: Uuid,
    form_id: Uuid,
    version_id: Uuid,
    actor_id: Uuid,
    expected: Option<i32>,
) -> Result<DraftWrite<(FormVersion, OperationId)>, DbError> {
    let Some(form) = get(conn, org_id, form_id).await? else {
        return Ok(DraftWrite::Missing);
    };
    match take_draft(
        conn,
        org_id,
        form_id,
        version_id,
        expected,
        crate::catalog::Patch::Unchanged,
        Some(actor_id),
    )
    .await?
    {
        DraftWrite::Applied(_) => {}
        DraftWrite::Stale { current } => return Ok(DraftWrite::Stale { current }),
        DraftWrite::Missing => return Ok(DraftWrite::Missing),
        DraftWrite::Published => return Ok(DraftWrite::Published),
    }

    sqlx::query("UPDATE forms SET live_version_id = $3 WHERE org_id = $1 AND id = $2")
        .bind(org_id)
        .bind(form_id)
        .bind(version_id)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;

    let operation_id = record_form_operation(
        conn,
        org_id,
        form.event_id,
        actor_id,
        "form_version.publish",
        serde_json::json!({ "form_id": form_id, "version_id": version_id }),
        serde_json::json!({
            "command": "unpublish_form_version",
            "form_id": form_id,
            "version_id": version_id,
            "previous_live_version_id": form.live_version_id,
            "refuse_if_submissions": true,
        }),
        &[form_id, version_id],
    )
    .await?;

    let version = get_version(conn, org_id, form_id, VersionRef::Id(version_id))
        .await?
        .ok_or_else(|| decode_failure("the version just published is not visible".to_owned()))?;
    Ok(DraftWrite::Applied((version, operation_id)))
}
