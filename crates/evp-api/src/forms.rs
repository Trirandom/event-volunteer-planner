// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `/orgs/{org}/forms` — authoring, versioning and publishing the
//! first-party form (docs/04 §"The volunteer form", docs/09).
//!
//! Coordinator and owner only, reads included (docs/04 §4: "Forms: author,
//! publish" has no zone-lead column). The rules of a valid question list are
//! `evp_domain::form`'s; this module resolves what they need — the form's
//! scope, its missions *now* — and turns their problems into the `422`
//! the contract describes.
//!
//! **Every write answers with its resource plus `operation_id`.** docs/04
//! gives `POST …/forms` as "→ `Form`" and `publish` as "→ `FormVersion`", and
//! every mutating route must also return its operation id (ADR-0024). Both
//! hold by flattening: the body *is* the `Form` (or `FormVersion`), with one
//! extra `operation_id` key, so a client parsing it as the documented shape
//! reads it unchanged.

use axum::Router;
use axum::extract::{FromRef, Path, Query};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::{get, post};
use evp_domain::form::{
    ConsentPurpose, Locale, Localized, PublishContext, QuestionDraft, QuestionKind, QuestionOption,
    TargetPath,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::catalog::{DataPage, applied, precondition_version};
use crate::error::{ApiError, PublishProblem};
use crate::extract::{JsonBody, Precondition, etag};
use crate::org::{Coordinator, OrgTx};

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
{
    Router::new()
        .route(
            "/api/v1/orgs/{org}/forms",
            get(list_forms).post(create_form),
        )
        .route(
            "/api/v1/orgs/{org}/forms/{form}",
            get(get_form).patch(patch_form).delete(delete_form),
        )
        .route(
            "/api/v1/orgs/{org}/forms/{form}/mission-options",
            get(mission_options),
        )
        .route(
            "/api/v1/orgs/{org}/forms/{form}/versions",
            post(create_version),
        )
        .route(
            "/api/v1/orgs/{org}/forms/{form}/versions/{version}",
            get(get_version).put(put_version),
        )
        .route(
            "/api/v1/orgs/{org}/forms/{form}/versions/{version}/publish",
            post(publish_version),
        )
}

// ---------------------------------------------------------------------------
// Wire shapes (docs/04 §"The volunteer form")
// ---------------------------------------------------------------------------

/// `{fr, en?}`. French is required; English is the optional second locale.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LocalizedText {
    pub fr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub en: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct QuestionOptionBody {
    /// For a `missions` question, the folded mission key from
    /// `mission-options`.
    pub value: String,
    pub label: LocalizedText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
    /// `missions` only: the form offers this option already ticked. Read
    /// only. The server copies it from the zones on every write and at
    /// publish, and ignores what is sent.
    #[serde(default)]
    pub checked_by_default: bool,
    /// `missions` only: the mission is for volunteers aged 18 or over. Read
    /// only, like `checked_by_default`.
    #[serde(default)]
    pub adults_only: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKindBody {
    ShortText,
    LongText,
    Email,
    Phone,
    Date,
    SingleChoice,
    MultiChoice,
    Boolean,
    Availability,
    Missions,
    Consent,
    Section,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
pub enum TargetPathBody {
    #[serde(rename = "volunteer.first_name")]
    FirstName,
    #[serde(rename = "volunteer.last_name")]
    LastName,
    #[serde(rename = "volunteer.email")]
    Email,
    #[serde(rename = "volunteer.phone")]
    Phone,
    #[serde(rename = "volunteer.tshirt_size")]
    TshirtSize,
    #[serde(rename = "volunteer.dietary")]
    Dietary,
    #[serde(rename = "volunteer.notes")]
    Notes,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConsentPurposeBody {
    Processing,
    PoolRetention,
    Commitment,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LocaleBody {
    Fr,
    En,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct QuestionBody {
    pub id: String,
    pub position: i32,
    pub kind: QuestionKindBody,
    /// `null` for a custom question (ADR-0037) and for the kinds with their
    /// own destination.
    pub target_path: Option<TargetPathBody>,
    pub consent_purpose: Option<ConsentPurposeBody>,
    pub label: LocalizedText,
    pub help_text: Option<LocalizedText>,
    pub options: Option<Vec<QuestionOptionBody>>,
    pub is_required: bool,
    pub is_sensitive: bool,
    /// Derived: `target_path` is set, or the kind is `availability`,
    /// `missions` or `consent` (docs/09 §1).
    pub builtin: bool,
}

/// A question as `PUT` takes it: [`QuestionBody`] without `id`, `position`
/// and `builtin` — order is array order. Those three are ignored if sent, so
/// a client may send back what it read.
#[derive(Debug, Deserialize, ToSchema)]
pub struct QuestionInput {
    pub kind: QuestionKindBody,
    #[serde(default)]
    pub target_path: Option<TargetPathBody>,
    #[serde(default)]
    pub consent_purpose: Option<ConsentPurposeBody>,
    pub label: LocalizedText,
    #[serde(default)]
    pub help_text: Option<LocalizedText>,
    #[serde(default)]
    pub options: Option<Vec<QuestionOptionBody>>,
    #[serde(default)]
    pub is_required: bool,
    #[serde(default)]
    pub is_sensitive: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct VersionSummaryBody {
    pub id: String,
    pub version: i32,
    pub published_at: Option<String>,
    pub question_count: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FormBody {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub festival_id: Option<String>,
    pub event_id: Option<String>,
    pub public_open: bool,
    pub default_locale: LocaleBody,
    pub live_version_id: Option<String>,
    pub versions: Vec<VersionSummaryBody>,
    /// The form row's own concurrency token; also its `ETag`.
    pub version: i32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FormVersionBody {
    pub id: String,
    pub form_id: String,
    pub version: i32,
    pub published_at: Option<String>,
    pub privacy_notice_version: Option<String>,
    pub questions: Vec<QuestionBody>,
    /// Bumped by every `PUT`; the draft's `ETag`.
    pub etag_version: i32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FormWritten {
    #[serde(flatten)]
    pub form: FormBody,
    pub operation_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FormVersionWritten {
    #[serde(flatten)]
    pub version: FormVersionBody,
    pub operation_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FormDeleted {
    pub operation_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MissionOptionBody {
    /// The folded name key (`missionCatalog.ts`'s `missionKey`).
    pub value: String,
    /// The first event's spelling.
    pub label: String,
    pub event_ids: Vec<String>,
    /// Ticked on the form unless the volunteer unticks it. `false` when any
    /// of its zones asks for an explicit tick or is adults-only.
    pub checked_by_default: bool,
    /// Any of its zones is for volunteers aged 18 or over.
    pub adults_only: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MissionOptions {
    pub options: Vec<MissionOptionBody>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateFormRequest {
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub festival_id: Option<String>,
    #[serde(default)]
    pub event_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchFormRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub public_open: Option<bool>,
    #[serde(default)]
    pub default_locale: Option<LocaleBody>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PutVersionRequest {
    /// Omitted leaves it as it is; `null` clears it.
    #[serde(default, deserialize_with = "crate::catalog::sent_field")]
    #[schema(value_type = Option<String>)]
    pub privacy_notice_version: evp_db::catalog::Patch<String>,
    pub questions: Vec<QuestionInput>,
}

#[derive(Debug, Deserialize)]
pub struct FormFilter {
    #[serde(default)]
    pub festival: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FormPath {
    form: String,
}

#[derive(Debug, Deserialize)]
struct VersionPath {
    form: String,
    version: String,
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

pub(crate) fn kind_body(kind: QuestionKind) -> QuestionKindBody {
    match kind {
        QuestionKind::ShortText => QuestionKindBody::ShortText,
        QuestionKind::LongText => QuestionKindBody::LongText,
        QuestionKind::Email => QuestionKindBody::Email,
        QuestionKind::Phone => QuestionKindBody::Phone,
        QuestionKind::Date => QuestionKindBody::Date,
        QuestionKind::SingleChoice => QuestionKindBody::SingleChoice,
        QuestionKind::MultiChoice => QuestionKindBody::MultiChoice,
        QuestionKind::Boolean => QuestionKindBody::Boolean,
        QuestionKind::Availability => QuestionKindBody::Availability,
        QuestionKind::Missions => QuestionKindBody::Missions,
        QuestionKind::Consent => QuestionKindBody::Consent,
        QuestionKind::Section => QuestionKindBody::Section,
    }
}

fn kind_domain(kind: QuestionKindBody) -> QuestionKind {
    match kind {
        QuestionKindBody::ShortText => QuestionKind::ShortText,
        QuestionKindBody::LongText => QuestionKind::LongText,
        QuestionKindBody::Email => QuestionKind::Email,
        QuestionKindBody::Phone => QuestionKind::Phone,
        QuestionKindBody::Date => QuestionKind::Date,
        QuestionKindBody::SingleChoice => QuestionKind::SingleChoice,
        QuestionKindBody::MultiChoice => QuestionKind::MultiChoice,
        QuestionKindBody::Boolean => QuestionKind::Boolean,
        QuestionKindBody::Availability => QuestionKind::Availability,
        QuestionKindBody::Missions => QuestionKind::Missions,
        QuestionKindBody::Consent => QuestionKind::Consent,
        QuestionKindBody::Section => QuestionKind::Section,
    }
}

pub(crate) fn target_body(target: TargetPath) -> TargetPathBody {
    match target {
        TargetPath::FirstName => TargetPathBody::FirstName,
        TargetPath::LastName => TargetPathBody::LastName,
        TargetPath::Email => TargetPathBody::Email,
        TargetPath::Phone => TargetPathBody::Phone,
        TargetPath::TshirtSize => TargetPathBody::TshirtSize,
        TargetPath::Dietary => TargetPathBody::Dietary,
        TargetPath::Notes => TargetPathBody::Notes,
    }
}

fn target_domain(target: TargetPathBody) -> TargetPath {
    match target {
        TargetPathBody::FirstName => TargetPath::FirstName,
        TargetPathBody::LastName => TargetPath::LastName,
        TargetPathBody::Email => TargetPath::Email,
        TargetPathBody::Phone => TargetPath::Phone,
        TargetPathBody::TshirtSize => TargetPath::TshirtSize,
        TargetPathBody::Dietary => TargetPath::Dietary,
        TargetPathBody::Notes => TargetPath::Notes,
    }
}

pub(crate) fn purpose_body(purpose: ConsentPurpose) -> ConsentPurposeBody {
    match purpose {
        ConsentPurpose::Processing => ConsentPurposeBody::Processing,
        ConsentPurpose::PoolRetention => ConsentPurposeBody::PoolRetention,
        ConsentPurpose::Commitment => ConsentPurposeBody::Commitment,
    }
}

fn purpose_domain(purpose: ConsentPurposeBody) -> ConsentPurpose {
    match purpose {
        ConsentPurposeBody::Processing => ConsentPurpose::Processing,
        ConsentPurposeBody::PoolRetention => ConsentPurpose::PoolRetention,
        ConsentPurposeBody::Commitment => ConsentPurpose::Commitment,
    }
}

pub(crate) fn locale_body(stored: &str) -> LocaleBody {
    // `forms_default_locale_known` admits exactly these two, so anything else
    // is unreachable; French is the form's first locale either way.
    match Locale::parse(stored) {
        Some(Locale::En) => LocaleBody::En,
        Some(Locale::Fr) | None => LocaleBody::Fr,
    }
}

pub(crate) fn locale_str(locale: LocaleBody) -> &'static str {
    match locale {
        LocaleBody::Fr => Locale::Fr.as_str(),
        LocaleBody::En => Locale::En.as_str(),
    }
}

pub(crate) fn text_body(text: Localized) -> LocalizedText {
    LocalizedText {
        fr: text.fr,
        en: text.en,
    }
}

fn text_domain(text: LocalizedText) -> Localized {
    Localized {
        fr: text.fr,
        en: text.en,
    }
}

fn render_question(question: evp_db::forms::Question) -> QuestionBody {
    let builtin = question.draft.is_builtin();
    let draft = question.draft;
    QuestionBody {
        id: question.id.to_string(),
        position: question.position,
        kind: kind_body(draft.kind),
        target_path: draft.target_path.map(target_body),
        consent_purpose: draft.consent_purpose.map(purpose_body),
        label: text_body(draft.label),
        help_text: draft.help_text.map(text_body),
        options: draft.options.map(|options| {
            options
                .into_iter()
                .map(|option| QuestionOptionBody {
                    value: option.value,
                    label: text_body(option.label),
                    skill_id: option.skill_id.map(|id| id.to_string()),
                    checked_by_default: option.checked_by_default,
                    adults_only: option.adults_only,
                })
                .collect()
        }),
        is_required: draft.is_required,
        is_sensitive: draft.is_sensitive,
        builtin,
    }
}

fn render_form(form: evp_db::forms::Form) -> FormBody {
    FormBody {
        id: form.id.to_string(),
        name: form.name,
        slug: form.slug,
        festival_id: form.festival_id.map(|id| id.to_string()),
        event_id: form.event_id.map(|id| id.to_string()),
        public_open: form.public_open,
        default_locale: locale_body(&form.default_locale),
        live_version_id: form.live_version_id.map(|id| id.to_string()),
        versions: form
            .versions
            .into_iter()
            .map(|version| VersionSummaryBody {
                id: version.id.to_string(),
                version: version.version,
                published_at: version.published_at.map(|at| at.to_string()),
                question_count: version.question_count,
            })
            .collect(),
        version: form.version,
    }
}

fn render_version(version: evp_db::forms::FormVersion) -> FormVersionBody {
    FormVersionBody {
        id: version.id.to_string(),
        form_id: version.form_id.to_string(),
        version: version.version,
        published_at: version.published_at.map(|at| at.to_string()),
        privacy_notice_version: version.privacy_notice_version,
        questions: version.questions.into_iter().map(render_question).collect(),
        etag_version: version.etag_version,
    }
}

fn question_domain(index: usize, input: QuestionInput) -> Result<QuestionDraft, ApiError> {
    let options = input
        .options
        .map(|options| {
            options
                .into_iter()
                .map(|option| {
                    let skill_id = option
                        .skill_id
                        .as_deref()
                        .map(|text| {
                            text.parse::<Uuid>().map_err(|_| {
                                ApiError::ValidationFailed(format!(
                                    "questions[{index}]: skill_id is not a UUID."
                                ))
                            })
                        })
                        .transpose()?;
                    // The flags are the zones' to say; `put_version` stamps them.
                    Ok(QuestionOption {
                        value: option.value,
                        label: text_domain(option.label),
                        skill_id,
                        checked_by_default: false,
                        adults_only: false,
                    })
                })
                .collect::<Result<Vec<_>, ApiError>>()
        })
        .transpose()?;
    Ok(QuestionDraft {
        kind: kind_domain(input.kind),
        target_path: input.target_path.map(target_domain),
        consent_purpose: input.consent_purpose.map(purpose_domain),
        label: text_domain(input.label),
        help_text: input.help_text.map(text_domain),
        options,
        is_required: input.is_required,
        is_sensitive: input.is_sensitive,
    })
}

fn refuse(detail: &str, problems: Vec<evp_domain::form::Problem>) -> ApiError {
    ApiError::FormProblems {
        detail: detail.to_owned(),
        problems: problems.into_iter().map(PublishProblem::from).collect(),
    }
}

/// An id that is not a UUID names nothing, which is a `404` like any other
/// id that names nothing.
fn parse_id(text: &str) -> Result<Uuid, ApiError> {
    text.parse().map_err(|_| ApiError::NotFound)
}

/// `{version}` is the version's id, or its number within the form: the list
/// in `Form.versions` carries both, and neither reading is ambiguous.
fn parse_version(text: &str) -> Result<evp_db::forms::VersionRef, ApiError> {
    if let Ok(id) = text.parse::<Uuid>() {
        return Ok(evp_db::forms::VersionRef::Id(id));
    }
    text.parse::<i32>()
        .map(evp_db::forms::VersionRef::Number)
        .map_err(|_| ApiError::NotFound)
}

fn parse_field_uuid(field: &str, value: &str) -> Result<Uuid, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::ValidationFailed(format!("{field} is not a UUID.")))
}

/// A public URL segment: lowercase letters, digits and inner hyphens, which
/// is what `organizations_slug_format` allows an organisation. Checked here
/// rather than by a `CHECK`, since docs/03 leaves the column unconstrained
/// and a URL with a space in it is a support ticket, not a schema question.
fn check_slug(slug: &str) -> Result<(), ApiError> {
    let shaped = !slug.is_empty()
        && slug.len() <= 80
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-')
        && !slug.ends_with('-');
    if shaped {
        Ok(())
    } else {
        Err(ApiError::ValidationFields {
            detail: "slug must be lowercase letters, digits and hyphens, not starting or ending \
                     with a hyphen."
                .to_owned(),
            errors: std::collections::BTreeMap::from([(
                "slug".to_owned(),
                vec!["lowercase letters, digits and inner hyphens only".to_owned()],
            )]),
        })
    }
}

fn check_name(name: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::ValidationFields {
            detail: "A form needs a name.".to_owned(),
            errors: std::collections::BTreeMap::from([(
                "name".to_owned(),
                vec!["must not be blank".to_owned()],
            )]),
        });
    }
    Ok(())
}

fn with_etag<T: Serialize>(status: StatusCode, version: i32, body: T) -> Response {
    (status, [(header::ETAG, etag(version))], axum::Json(body)).into_response()
}

async fn resolve_form(org: &mut OrgTx, form: &str) -> Result<evp_db::forms::Form, ApiError> {
    let id = parse_id(form)?;
    evp_db::forms::get(&mut org.tx, org.org_id, id)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)
}

/// The scope's missions as they stand now.
async fn missions_of(
    org: &mut OrgTx,
    festival_id: Option<Uuid>,
    event_id: Option<Uuid>,
) -> Result<Vec<evp_domain::form::MissionOption>, ApiError> {
    let rows = evp_db::forms::mission_rows(&mut org.tx, org.org_id, festival_id, event_id)
        .await
        .map_err(ApiError::from)?;
    Ok(evp_domain::form::fold_missions(&rows))
}

/// The three outcomes of a draft write that are not success.
fn settled<T>(
    outcome: evp_db::forms::DraftWrite<T>,
    precondition: &Precondition,
    frozen: &str,
) -> Result<T, ApiError> {
    use evp_db::forms::DraftWrite;
    match outcome {
        DraftWrite::Applied(value) => Ok(value),
        DraftWrite::Missing => Err(ApiError::NotFound),
        DraftWrite::Published => Err(ApiError::Conflict(frozen.to_owned())),
        DraftWrite::Stale { current } => applied(
            evp_db::catalog::Versioned::<T>::Stale { current },
            precondition,
        ),
    }
}

const FROZEN_VERSION: &str = "This version is published and cannot be edited; create a new \
                              draft from it with POST …/versions.";

/// A constraint on `form_questions` reached despite the validator: a gap in
/// `evp_domain::form`, reported as the caller's `422` rather than a `500`,
/// since it is still their list that broke it.
fn map_question_write_error(error: evp_db::DbError) -> ApiError {
    match error.sqlstate().as_deref() {
        Some("23505" | "23514") => ApiError::ValidationFailed(
            "The question list breaks a rule of the form schema.".to_owned(),
        ),
        _ => ApiError::Internal(error),
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list_forms(
    Coordinator(mut org): Coordinator,
    Query(filter): Query<FormFilter>,
) -> Result<axum::Json<DataPage<FormBody>>, ApiError> {
    let festival_id = filter
        .festival
        .as_deref()
        .map(|value| parse_field_uuid("festival", value))
        .transpose()?;
    let event_id = filter
        .event
        .as_deref()
        .map(|value| parse_field_uuid("event", value))
        .transpose()?;
    let forms = evp_db::forms::list(&mut org.tx, org.org_id, festival_id, event_id)
        .await
        .map_err(ApiError::from)?;
    org.commit().await?;
    Ok(axum::Json(DataPage {
        data: forms.into_iter().map(render_form).collect(),
        next: None,
    }))
}

/// `POST …/forms`: the form and its seeded version 1 (docs/04 "The seeded
/// draft"), whose missions question offers the scope's missions as they are
/// right now.
async fn create_form(
    Coordinator(mut org): Coordinator,
    JsonBody(request): JsonBody<CreateFormRequest>,
) -> Result<Response, ApiError> {
    check_name(&request.name)?;
    check_slug(&request.slug)?;
    let festival_id = request
        .festival_id
        .as_deref()
        .map(|value| parse_field_uuid("festival_id", value))
        .transpose()?;
    let event_id = request
        .event_id
        .as_deref()
        .map(|value| parse_field_uuid("event_id", value))
        .transpose()?;
    if festival_id.is_some() && event_id.is_some() {
        return Err(ApiError::ValidationFields {
            detail: "A form covers a festival or an event, not both (ADR-0035).".to_owned(),
            errors: std::collections::BTreeMap::from([(
                "event_id".to_owned(),
                vec!["send festival_id or event_id, not both".to_owned()],
            )]),
        });
    }
    if let Some(festival_id) = festival_id
        && evp_db::catalog::get_festival(&mut org.tx, org.org_id, festival_id)
            .await
            .map_err(ApiError::from)?
            .is_none()
    {
        return Err(ApiError::ValidationFailed(
            "festival_id does not name a festival in this organisation.".to_owned(),
        ));
    }
    if let Some(event_id) = event_id
        && evp_db::catalog::get_event(&mut org.tx, org.org_id, event_id)
            .await
            .map_err(ApiError::from)?
            .is_none()
    {
        return Err(ApiError::ValidationFailed(
            "event_id does not name an event in this organisation.".to_owned(),
        ));
    }

    let scoped = festival_id.is_some() || event_id.is_some();
    let missions = missions_of(&mut org, festival_id, event_id).await?;
    let organization = evp_db::forms::organization_name(&mut org.tx, org.org_id)
        .await
        .map_err(ApiError::from)?;
    let seed = evp_domain::form::seed_draft(scoped, &missions, &organization);

    let (form, operation_id) = evp_db::forms::create(
        &mut org.tx,
        org.org_id,
        org.user_id,
        &evp_db::forms::NewForm {
            name: request.name,
            slug: request.slug,
            festival_id,
            event_id,
        },
        &seed,
    )
    .await
    .map_err(|error| match error.sqlstate().as_deref() {
        Some("23505") => ApiError::Conflict(
            "A form with this slug already exists in this organisation.".to_owned(),
        ),
        _ => ApiError::Internal(error),
    })?;
    org.commit().await?;

    Ok(with_etag(
        StatusCode::CREATED,
        form.version,
        FormWritten {
            form: render_form(form),
            operation_id: operation_id.0.to_string(),
        },
    ))
}

async fn get_form(
    Coordinator(mut org): Coordinator,
    Path(path): Path<FormPath>,
) -> Result<Response, ApiError> {
    let form = resolve_form(&mut org, &path.form).await?;
    org.commit().await?;
    Ok(with_etag(StatusCode::OK, form.version, render_form(form)))
}

async fn patch_form(
    Coordinator(mut org): Coordinator,
    Path(path): Path<FormPath>,
    precondition: Precondition,
    JsonBody(request): JsonBody<PatchFormRequest>,
) -> Result<Response, ApiError> {
    let form_id = parse_id(&path.form)?;
    if let Some(name) = &request.name {
        check_name(name)?;
    }
    let changes = evp_db::forms::FormPatch {
        name: request.name,
        public_open: request.public_open,
        default_locale: request
            .default_locale
            .map(|locale| locale_str(locale).to_owned()),
    };
    if changes.is_empty() {
        return Err(ApiError::Invalid(
            "The request body changes nothing; send at least one field.".to_owned(),
        ));
    }

    let outcome = evp_db::forms::update(
        &mut org.tx,
        org.org_id,
        form_id,
        org.user_id,
        precondition_version(&precondition),
        &changes,
    )
    .await
    .map_err(public_slug_taken)?;
    let (form, operation_id) = applied(outcome, &precondition)?;
    org.commit().await?;

    Ok(with_etag(
        StatusCode::OK,
        form.version,
        FormWritten {
            form: render_form(form),
            operation_id: operation_id.0.to_string(),
        },
    ))
}

/// `DELETE …/forms/{form}`: only while nothing was ever published. `200`
/// with the operation id rather than `204`, because the operation id is the
/// only handle on undoing it (ADR-0024).
async fn delete_form(
    Coordinator(mut org): Coordinator,
    Path(path): Path<FormPath>,
    precondition: Precondition,
) -> Result<axum::Json<FormDeleted>, ApiError> {
    let form_id = parse_id(&path.form)?;
    let outcome = evp_db::forms::delete(
        &mut org.tx,
        org.org_id,
        form_id,
        org.user_id,
        precondition_version(&precondition),
    )
    .await
    .map_err(ApiError::from)?;
    let operation_id = settled(
        outcome,
        &precondition,
        "This form has a published version, which submissions may point at; it cannot be \
         deleted. Close it with public_open: false instead.",
    )?;
    org.commit().await?;
    Ok(axum::Json(FormDeleted {
        operation_id: operation_id.0.to_string(),
    }))
}

async fn mission_options(
    Coordinator(mut org): Coordinator,
    Path(path): Path<FormPath>,
) -> Result<axum::Json<MissionOptions>, ApiError> {
    let form = resolve_form(&mut org, &path.form).await?;
    let missions = missions_of(&mut org, form.festival_id, form.event_id).await?;
    org.commit().await?;
    Ok(axum::Json(MissionOptions {
        options: missions
            .into_iter()
            .map(|mission| MissionOptionBody {
                value: mission.value,
                label: mission.label,
                event_ids: mission
                    .event_ids
                    .into_iter()
                    .map(|id| id.to_string())
                    .collect(),
                checked_by_default: mission.checked_by_default,
                adults_only: mission.adults_only,
            })
            .collect(),
    }))
}

async fn create_version(
    Coordinator(mut org): Coordinator,
    Path(path): Path<FormPath>,
) -> Result<Response, ApiError> {
    let form_id = parse_id(&path.form)?;
    let outcome = evp_db::forms::create_draft(&mut org.tx, org.org_id, form_id, org.user_id)
        .await
        .map_err(|error| match error.sqlstate().as_deref() {
            // `form_one_draft`, when another request made one in between.
            Some("23505") => {
                ApiError::Conflict("This form already has a draft; edit that one.".to_owned())
            }
            _ => ApiError::Internal(error),
        })?;
    let (version, operation_id) = match outcome {
        evp_db::forms::NewDraft::Created(created) => *created,
        evp_db::forms::NewDraft::DraftExists => {
            return Err(ApiError::Conflict(
                "This form already has a draft; edit that one.".to_owned(),
            ));
        }
        evp_db::forms::NewDraft::NoLiveVersion => {
            return Err(ApiError::Conflict(
                "Nothing is published yet to copy a draft from.".to_owned(),
            ));
        }
        evp_db::forms::NewDraft::Missing => return Err(ApiError::NotFound),
    };
    org.commit().await?;

    Ok(with_etag(
        StatusCode::CREATED,
        version.etag_version,
        FormVersionWritten {
            version: render_version(version),
            operation_id: operation_id.0.to_string(),
        },
    ))
}

async fn resolve_version(
    org: &mut OrgTx,
    form_id: Uuid,
    version: &str,
) -> Result<evp_db::forms::FormVersion, ApiError> {
    let version = parse_version(version)?;
    evp_db::forms::get_version(&mut org.tx, org.org_id, form_id, version)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)
}

async fn get_version(
    Coordinator(mut org): Coordinator,
    Path(path): Path<VersionPath>,
) -> Result<Response, ApiError> {
    let form_id = parse_id(&path.form)?;
    let version = resolve_version(&mut org, form_id, &path.version).await?;
    org.commit().await?;
    Ok(with_etag(
        StatusCode::OK,
        version.etag_version,
        render_version(version),
    ))
}

/// `PUT …/versions/{v}`: the whole question list, replaced. `409` on a
/// published version or a stale `If-Match`, `422` with `problems` on a list
/// a constraint would refuse.
async fn put_version(
    Coordinator(mut org): Coordinator,
    Path(path): Path<VersionPath>,
    precondition: Precondition,
    JsonBody(request): JsonBody<PutVersionRequest>,
) -> Result<Response, ApiError> {
    let form = resolve_form(&mut org, &path.form).await?;
    let before = resolve_version(&mut org, form.id, &path.version).await?;
    if before.published_at.is_some() {
        return Err(ApiError::Conflict(FROZEN_VERSION.to_owned()));
    }
    precondition.check(before.etag_version)?;

    let mut questions = request
        .questions
        .into_iter()
        .enumerate()
        .map(|(index, input)| question_domain(index, input))
        .collect::<Result<Vec<_>, _>>()?;
    let problems = evp_domain::form::validate_draft(&questions, form.is_scoped());
    if !problems.is_empty() {
        return Err(refuse(
            "The question list breaks the form's rules; see problems.",
            problems,
        ));
    }

    let missions = missions_of(&mut org, form.festival_id, form.event_id).await?;
    evp_domain::form::stamp_missions(&mut questions, &missions);

    let outcome = evp_db::forms::replace_questions(
        &mut org.tx,
        org.org_id,
        form.id,
        before.id,
        org.user_id,
        precondition_version(&precondition),
        request.privacy_notice_version,
        &questions,
    )
    .await
    .map_err(map_question_write_error)?;
    let (version, operation_id) = settled(outcome, &precondition, FROZEN_VERSION)?;
    org.commit().await?;

    Ok(with_etag(
        StatusCode::OK,
        version.etag_version,
        FormVersionWritten {
            version: render_version(version),
            operation_id: operation_id.0.to_string(),
        },
    ))
}

/// Publishing, or reopening the public route, collided on
/// `forms_public_slug`: another organisation already serves this slug at
/// `/f/{slug}` (migration `…200000`). A `409` rather than a `500`, and one
/// that says only what `GET /f/{slug}` already tells anyone.
fn public_slug_taken(error: evp_db::DbError) -> ApiError {
    if error.sqlstate().as_deref() == Some("23505")
        && error.constraint().as_deref() == Some("forms_public_slug")
    {
        return ApiError::Conflict(
            "Another form is already served publicly at this address. Close this form's \
             public link, or create a form with another slug."
                .to_owned(),
        );
    }
    ApiError::from(error)
}

/// `POST …/versions/{v}/publish`: validated against the scope's missions as
/// they are now, then frozen and made live.
async fn publish_version(
    Coordinator(mut org): Coordinator,
    Path(path): Path<VersionPath>,
    precondition: Precondition,
) -> Result<Response, ApiError> {
    let form = resolve_form(&mut org, &path.form).await?;
    let before = resolve_version(&mut org, form.id, &path.version).await?;
    if before.published_at.is_some() {
        return Err(ApiError::Conflict(
            "This version is already published.".to_owned(),
        ));
    }
    precondition.check(before.etag_version)?;

    let missions = missions_of(&mut org, form.festival_id, form.event_id).await?;
    let mission_keys = missions
        .iter()
        .map(|mission| mission.value.clone())
        .collect();
    let problems = evp_domain::form::validate_publish(
        &before.drafts(),
        PublishContext {
            scoped: form.is_scoped(),
            default_locale: Locale::parse(&form.default_locale).unwrap_or(Locale::Fr),
            mission_keys: &mission_keys,
        },
    );
    if !problems.is_empty() {
        return Err(refuse(
            "This version cannot be published yet; see problems.",
            problems,
        ));
    }

    // Same transaction as the publish: a refused or stale publish rolls this
    // back, and the draft keeps what its last `PUT` stamped.
    evp_db::forms::stamp_missions(&mut org.tx, org.org_id, before.id, &missions)
        .await
        .map_err(ApiError::from)?;
    let outcome = evp_db::forms::publish(
        &mut org.tx,
        org.org_id,
        form.id,
        before.id,
        org.user_id,
        precondition_version(&precondition),
    )
    .await
    .map_err(public_slug_taken)?;
    let (version, operation_id) =
        settled(outcome, &precondition, "This version is already published.")?;
    org.commit().await?;

    Ok(with_etag(
        StatusCode::OK,
        version.etag_version,
        FormVersionWritten {
            version: render_version(version),
            operation_id: operation_id.0.to_string(),
        },
    ))
}
