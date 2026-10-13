// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `GET /api/v1/public/forms/{slug}` and `POST …/{slug}/submissions` — the
//! volunteer form, unauthenticated (docs/04 §"Public and unauthenticated",
//! docs/09). The wire shapes are the ones `apps/form/src/api/publicForm.ts`
//! parses; that schema is the contract.
//!
//! **Why these handlers take no authorisation extractor** (docs/12 §9, item
//! 2 and 6). There is no session to check: a volunteer holds no account
//! (ADR-0008). What stands in for the org extractor is
//! [`evp_db::public_forms::resolve`], which learns the organisation from the
//! slug through a policy that makes one `forms` row visible — only while that
//! form is live and open, i.e. only what this route serves to anyone anyway
//! — and then `SET LOCAL`s `app.current_org_id`, so every read and write
//! after it is under the same tenant policies as a coordinator's request. The
//! full argument is in migration `…200100`, beside the policy.
//!
//! What a caller can learn: whether a slug is served (by design — it is a
//! public URL), and the questions and event periods of a form that is. An
//! unknown slug, a form with nothing live and a closed public route are one
//! `404`, byte for byte (docs/09 §5). A `POST` never says what became of it:
//! applied to the pool, held for review, or silently dropped as spam are all
//! `202` — and so the response never confirms whether an address is already
//! known (docs/04, ADR-0042).
//!
//! **Token links are not built.** `?t=` is neither read nor rejected: the
//! bundle already sends it for a token link, and until `form_invite_tokens`
//! exists the only honest behaviour is the public one — no prefill, and a
//! closed form is closed to everybody. Validating a token here is where
//! docs/12 §7 lands when it does.

use std::collections::BTreeMap;

use axum::Router;
use axum::extract::{DefaultBodyLimit, FromRef, Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::{MethodRouter, get};
use evp_domain::submission::{self as domain, Answer, Asked, WindowKind};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::captcha::CaptchaPolicy;
use crate::catalog::{Period, render_period};
use crate::error::ApiError;
use crate::extract::JsonBody;
use crate::forms::{
    ConsentPurposeBody, LocaleBody, LocalizedText, QuestionKindBody, TargetPathBody, kind_body,
    locale_body, purpose_body, target_body, text_body,
};

/// docs/09 §5, "timing floor": a form answered faster than a person can read
/// it is held for review — stored, never refused, because a volunteer whose
/// browser restored a draft can be that fast too.
const TIMING_FLOOR_MS: u64 = 3_000;

/// docs/09 §5, "payload caps". A full festival answered at the finest step is
/// a few tens of kilobytes; this is several times that and far below axum's
/// 2 MiB default, which is sized for coordinators, not for the internet.
const SUBMISSION_BODY_LIMIT: usize = 262_144;

/// `forms` slugs are at most 80 characters (docs/04); anything longer cannot
/// name a form, so it is a `404` without a round trip.
const MAX_SLUG_LEN: usize = 80;

/// The two routes. `submit` arrives already wrapped in its rate limit by
/// [`crate::router`], which owns the bucket store's sweeper.
pub(crate) fn router<S>(submit: MethodRouter<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    CaptchaPolicy: FromRef<S>,
{
    Router::new()
        .route("/api/v1/public/forms/{slug}", get(get_form))
        .route(
            "/api/v1/public/forms/{slug}/submissions",
            submit.layer(DefaultBodyLimit::max(SUBMISSION_BODY_LIMIT)),
        )
}

/// The unwrapped submission handler, for [`crate::router`] to rate-limit.
pub(crate) fn submit_route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    CaptchaPolicy: FromRef<S>,
{
    axum::routing::post(submit)
}

// ---------------------------------------------------------------------------
// Wire shapes (apps/form/src/api/publicForm.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct PublicFormBody {
    pub form: PublicFormHead,
    pub version: PublicVersion,
    /// In scope, in period order: one availability group each. Empty for a
    /// pool-recruitment form.
    pub events: Vec<PublicEvent>,
    /// Always `null` until token links exist: prefill is only ever for the
    /// volunteer a token names (docs/09 §4).
    pub prefill: Option<serde_json::Value>,
    /// The proof of work the submission must carry (ADR-0043). A fresh one
    /// with every load, which is also how the bundle renews a lapsed one.
    pub captcha: CaptchaChallengeBody,
}

/// ALTCHA's challenge shape (`evp_domain::captcha`).
#[derive(Debug, Serialize, ToSchema)]
pub struct CaptchaChallengeBody {
    pub algorithm: String,
    pub challenge: String,
    pub salt: String,
    pub maxnumber: u64,
    pub signature: String,
}

/// The solved challenge, echoed back with the number found.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CaptchaSolutionInput {
    pub challenge: String,
    pub salt: String,
    pub number: u64,
    pub signature: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PublicFormHead {
    pub slug: String,
    pub name: String,
    pub default_locale: LocaleBody,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PublicVersion {
    /// What the submission must echo as `form_version_id`.
    pub id: String,
    pub version: i32,
    pub privacy_notice_version: Option<String>,
    /// In position order.
    pub questions: Vec<PublicQuestion>,
}

/// The admin `Question` without `position` (array order is position),
/// `builtin` (a coordinator's concern) and each option's `skill_id` (an
/// internal id a volunteer has no use for).
#[derive(Debug, Serialize, ToSchema)]
pub struct PublicQuestion {
    pub id: String,
    pub kind: QuestionKindBody,
    pub target_path: Option<TargetPathBody>,
    pub consent_purpose: Option<ConsentPurposeBody>,
    pub label: LocalizedText,
    pub help_text: Option<LocalizedText>,
    pub options: Option<Vec<PublicOption>>,
    pub is_required: bool,
    pub is_sensitive: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PublicOption {
    pub value: String,
    pub label: LocalizedText,
    /// `missions` only: start with this option ticked. The volunteer can still
    /// untick it.
    pub checked_by_default: bool,
    /// `missions` only: show that the mission is for volunteers aged 18 or
    /// over. Information, not a refusal.
    pub adults_only: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PublicEvent {
    pub id: String,
    pub name: String,
    pub timezone: String,
    /// The operational window availability is clamped to (ADR-0044).
    pub period: Period,
    /// The public hours, shown as context only; `null` when not decided.
    pub public_period: Option<Period>,
    pub availability_step_minutes: i32,
    /// Suggested chips. Always empty: `intake_slot_options` is not built, and
    /// the chips are a convenience, never a constraint (docs/09 §3).
    pub slot_options: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WindowKindBody {
    Available,
    Unavailable,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct WindowInput {
    pub event_id: String,
    pub kind: WindowKindBody,
    /// RFC 3339.
    pub start: String,
    pub end: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SubmissionInput {
    /// The version the volunteer rendered; anything but the live one is `409`.
    pub form_version_id: String,
    pub locale: LocaleBody,
    /// Question id → `string | boolean | string[] | null`. Read as raw JSON so
    /// a wrong-typed answer is refused *by question* rather than as a body
    /// nobody can locate the fault in.
    #[serde(default)]
    pub answers: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub availability: Vec<WindowInput>,
    /// The honeypot (docs/09 §5). Anything but `""` is dropped, silently.
    #[serde(default)]
    pub website: String,
    /// Milliseconds from render to send, judged against [`TIMING_FLOOR_MS`].
    pub elapsed_ms: u64,
    /// The solved proof of work. Optional in the schema so that its absence
    /// is the captcha's refusal, not a body nobody can read.
    #[serde(default)]
    pub captcha: Option<CaptchaSolutionInput>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// A resolved form, its live version and its events, on a transaction scoped
/// to its organisation.
struct Served {
    tx: sqlx::Transaction<'static, sqlx::Postgres>,
    org_id: Uuid,
    form: evp_db::forms::Form,
    version: evp_db::forms::FormVersion,
    events: Vec<evp_db::catalog::Event>,
}

/// Everything both routes need, or the one `404`.
async fn serve(pool: &PgPool, slug: &str) -> Result<Served, ApiError> {
    if slug.len() > MAX_SLUG_LEN {
        return Err(ApiError::NotFound);
    }
    let mut tx = pool.begin().await.map_err(evp_db::DbError::Query)?;
    let resolved = evp_db::public_forms::resolve(&mut tx, slug)
        .await?
        .ok_or(ApiError::NotFound)?;
    let form = evp_db::forms::get(&mut tx, resolved.org_id, resolved.form_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let live = form.live_version_id.ok_or(ApiError::NotFound)?;
    let version = evp_db::forms::get_version(
        &mut tx,
        resolved.org_id,
        form.id,
        evp_db::forms::VersionRef::Id(live),
    )
    .await?
    .ok_or(ApiError::NotFound)?;
    let events = evp_db::public_forms::scope_events(
        &mut tx,
        resolved.org_id,
        form.festival_id,
        form.event_id,
    )
    .await?;
    Ok(Served {
        tx,
        org_id: resolved.org_id,
        form,
        version,
        events,
    })
}

async fn get_form(
    State(pool): State<PgPool>,
    State(captcha): State<CaptchaPolicy>,
    Path(slug): Path<String>,
) -> Result<Response, ApiError> {
    let mut served = serve(&pool, &slug).await?;
    let challenge = captcha.issue(database_now(&mut served.tx).await?);
    served.tx.commit().await.map_err(evp_db::DbError::Query)?;

    let body = PublicFormBody {
        form: PublicFormHead {
            slug: served.form.slug,
            name: served.form.name,
            default_locale: locale_body(&served.form.default_locale),
        },
        version: PublicVersion {
            id: served.version.id.to_string(),
            version: served.version.version,
            privacy_notice_version: served.version.privacy_notice_version,
            questions: served
                .version
                .questions
                .into_iter()
                .map(render_question)
                .collect(),
        },
        events: served.events.into_iter().map(render_event).collect(),
        prefill: None,
        captcha: CaptchaChallengeBody {
            algorithm: challenge.algorithm.to_owned(),
            challenge: challenge.challenge,
            salt: challenge.salt,
            maxnumber: challenge.max_number,
            signature: challenge.signature,
        },
    };
    // Not cached anywhere: closing the public route, or publishing a new
    // version, has to take effect on the next load, not after a TTL.
    Ok((
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(body),
    )
        .into_response())
}

fn render_question(question: evp_db::forms::Question) -> PublicQuestion {
    let draft = question.draft;
    PublicQuestion {
        id: question.id.to_string(),
        kind: kind_body(draft.kind),
        target_path: draft.target_path.map(target_body),
        consent_purpose: draft.consent_purpose.map(purpose_body),
        label: text_body(draft.label),
        help_text: draft.help_text.map(text_body),
        options: draft.options.map(|options| {
            options
                .into_iter()
                .map(|option| PublicOption {
                    value: option.value,
                    label: text_body(option.label),
                    checked_by_default: option.checked_by_default,
                    adults_only: option.adults_only,
                })
                .collect()
        }),
        is_required: draft.is_required,
        is_sensitive: draft.is_sensitive,
    }
}

fn render_event(event: evp_db::catalog::Event) -> PublicEvent {
    PublicEvent {
        id: event.id.to_string(),
        name: event.name,
        timezone: event.timezone,
        period: render_period(event.period_start, event.period_end),
        public_period: event
            .public_period_start
            .zip(event.public_period_end)
            .map(|(start, end)| render_period(start, end)),
        availability_step_minutes: event.availability_step_minutes,
        slot_options: Vec::new(),
    }
}

/// `POST …/submissions`: `202` once stored, `409` for a stale version, `422`
/// with an `errors` map for a submission the version would not accept.
///
/// Stored, then reconciled into the pool on the same transaction (ADR-0042),
/// unless the timing floor held it: a held submission waits for a coordinator
/// whoever it turns out to be. A reconcile that fails rolls back to its own
/// savepoint and leaves the submission stored and `received` — the volunteer's
/// answers are kept either way, and `evp-cli reconcile` retries it.
///
/// Not an ADR-0024 operation: nothing a coordinator did is being recorded,
/// so there is no inverse to offer and no `operation_id` in a body the
/// contract says is empty. Rejecting spam from the review queue is the undo.
async fn submit(
    State(pool): State<PgPool>,
    State(captcha): State<CaptchaPolicy>,
    Path(slug): Path<String>,
    JsonBody(input): JsonBody<SubmissionInput>,
) -> Result<Response, ApiError> {
    let served = serve(&pool, &slug).await?;
    let Served {
        mut tx,
        org_id,
        form,
        version,
        events,
    } = served;

    if !input.website.is_empty() {
        // A person never sees the field. Dropped before anything is read out
        // of the body, and answered exactly as a stored submission would be,
        // so a bot learns nothing from the difference. Logged without the
        // body: it is unsolicited, and may well carry someone's details.
        tracing::info!(%org_id, form_id = %form.id, "honeypot filled; submission dropped");
        return Ok(StatusCode::ACCEPTED.into_response());
    }

    // Checked before anything costs a validation pass, and spent only once
    // the submission is about to be stored: a volunteer who is sent back to
    // fix an answer keeps the work their browser already did.
    let now = database_now(&mut tx).await?;
    let solution = checked_captcha(&captcha, input.captcha.as_ref(), now)?;

    let claimed: Uuid = input.form_version_id.parse().map_err(|_| {
        ApiError::Invalid("form_version_id is not an id this form issued.".to_owned())
    })?;
    if claimed != version.id {
        // docs/04: the volunteer re-renders rather than answering questions
        // that no longer exist. The bundle refetches on this status.
        return Err(ApiError::Conflict(
            "This form has changed since it was opened. Reload it to see the current questions."
                .to_owned(),
        ));
    }

    let (windows, mut refusals) = parse_windows(&input.availability);
    let answers: BTreeMap<String, Answer> = input
        .answers
        .iter()
        .map(|(key, value)| (key.clone(), Answer::from_json(value)))
        .collect();
    let asked: Vec<Asked<'_>> = version
        .questions
        .iter()
        .map(|question| Asked {
            id: question.id,
            question: &question.draft,
        })
        .collect();
    let scope: Vec<domain::ScopeEvent> = events
        .iter()
        .map(|event| domain::ScopeEvent {
            id: event.id,
            start: event.period_start,
            end: event.period_end,
        })
        .collect();
    refusals.extend(domain::validate(&asked, &scope, &answers, &windows));
    if !refusals.is_empty() {
        return Err(refuse(refusals));
    }

    let held = timing_hold(input.elapsed_ms);
    let opened_by = version.published_by.ok_or_else(|| {
        ApiError::Internal(evp_db::DbError::Query(sqlx::Error::Decode(
            "a live form version with no publisher".into(),
        )))
    })?;

    if !captcha.spend(&solution, now) {
        tracing::info!(%org_id, form_id = %form.id, "captcha solution replayed");
        return Err(ApiError::CaptchaFailed);
    }

    let submission_id = evp_db::public_forms::record_submission(
        &mut tx,
        &evp_db::public_forms::NewSubmission {
            org_id,
            form_id: form.id,
            form_slug: &form.slug,
            event_id: form.event_id,
            form_version_id: version.id,
            opened_by,
            locale: crate::forms::locale_str(input.locale),
            raw: raw_payload(&input),
            raw_keys: answered_keys(&answers),
            held: held.clone(),
        },
    )
    .await?;
    let (reconciled, match_kind) = if held.is_some() {
        ("held", "")
    } else {
        reconcile(&mut tx, org_id, submission_id).await
    };
    tx.commit().await.map_err(evp_db::DbError::Query)?;

    tracing::info!(
        %org_id,
        form_id = %form.id,
        %submission_id,
        held = held.is_some(),
        reconciled,
        match_kind,
        "public form submission stored"
    );
    Ok(StatusCode::ACCEPTED.into_response())
}

/// [`evp_db::intake::reconcile`], told as the outcome and the match kind
/// only: who it matched, and what they wrote, are the volunteer's, not the
/// log's. A failure is logged and swallowed — the savepoint has already put
/// the submission back as stored, and the volunteer's `202` does not depend
/// on it.
async fn reconcile(
    conn: &mut sqlx::PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
) -> (&'static str, &'static str) {
    match evp_db::intake::reconcile(conn, org_id, submission_id).await {
        Ok(evp_db::intake::Outcome::Applied { kind, .. }) => ("applied", kind.as_str()),
        Ok(evp_db::intake::Outcome::NeedsReview) => ("needs_review", ""),
        Ok(evp_db::intake::Outcome::Skipped) => ("skipped", ""),
        Err(error) => {
            tracing::warn!(
                %org_id,
                %submission_id,
                error = ?error,
                "reconciling a public form submission failed; it stays received"
            );
            ("received", "")
        }
    }
}

/// docs/09 §5's timing floor: the `errors` a submission answered too fast is
/// held for review with, or `None`.
fn timing_hold(elapsed_ms: u64) -> Option<serde_json::Value> {
    (elapsed_ms < TIMING_FLOOR_MS).then(|| {
        serde_json::json!([{
            "field": "elapsed_ms",
            "code": "too_fast",
            "message": format!(
                "Answered in {elapsed_ms} ms, under the {TIMING_FLOOR_MS} ms floor (docs/09 §5)."
            ),
        }])
    })
}

/// The submitted proof of work, verified but not yet spent.
fn checked_captcha(
    captcha: &CaptchaPolicy,
    input: Option<&CaptchaSolutionInput>,
    now: i64,
) -> Result<evp_domain::captcha::Solution, ApiError> {
    let solution = input
        .map(|solution| evp_domain::captcha::Solution {
            challenge: solution.challenge.clone(),
            salt: solution.salt.clone(),
            number: solution.number,
            signature: solution.signature.clone(),
        })
        .ok_or(ApiError::CaptchaFailed)?;
    captcha.verify(&solution, now).map_err(|refusal| {
        // Which check failed is for the log, never the response.
        tracing::info!(%refusal, "captcha refused");
        ApiError::CaptchaFailed
    })?;
    Ok(solution)
}

/// The database's clock, in unix seconds — the one every expiry on this route
/// is judged by, as sessions' are (`evp_db::auth`), so no caller can postpone
/// "expired" by having a different idea of the time.
async fn database_now(conn: &mut sqlx::PgConnection) -> Result<i64, ApiError> {
    let now: i64 = sqlx::query_scalar("SELECT extract(epoch FROM statement_timestamp())::bigint")
        .fetch_one(&mut *conn)
        .await
        .map_err(evp_db::DbError::Query)?;
    Ok(now)
}

/// Windows whose three fields parse, and a refusal for each that does not.
/// A window that does not parse is left out of the domain check rather than
/// guessed at, so it earns exactly one refusal.
fn parse_windows(inputs: &[WindowInput]) -> (Vec<domain::Window>, Vec<domain::Refusal>) {
    let mut windows = Vec::with_capacity(inputs.len());
    let mut refusals = Vec::new();
    for (index, input) in inputs.iter().enumerate() {
        let event_id = input.event_id.parse::<Uuid>();
        let start = input.start.parse::<jiff::Timestamp>();
        let end = input.end.parse::<jiff::Timestamp>();
        match (event_id, start, end) {
            (Ok(event_id), Ok(start), Ok(end)) => windows.push(domain::Window {
                event_id,
                kind: match input.kind {
                    WindowKindBody::Available => WindowKind::Available,
                    WindowKindBody::Unavailable => WindowKind::Unavailable,
                },
                start,
                end,
            }),
            (Err(_), _, _) => refusals.push(domain::Refusal {
                field: format!("availability[{index}]"),
                code: domain::Code::UnknownEvent,
            }),
            (Ok(_), _, _) => refusals.push(domain::Refusal {
                field: format!("availability[{index}]"),
                code: domain::Code::InvalidInstant,
            }),
        }
    }
    (windows, refusals)
}

/// docs/04 §Error format: `errors: {field: [msg]}`. The messages are the
/// stable codes, which is what a client can act on; `detail` is the prose.
fn refuse(refusals: Vec<domain::Refusal>) -> ApiError {
    let mut errors: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for refusal in refusals {
        errors
            .entry(refusal.field)
            .or_default()
            .push(refusal.code.as_str().to_owned());
    }
    ApiError::ValidationFields {
        detail: "Some answers cannot be accepted; see errors.".to_owned(),
        errors,
    }
}

/// Exactly what arrived, minus the honeypot (which is empty by now) — the
/// replay source when a question's mapping is corrected later (docs/08 §9).
fn raw_payload(input: &SubmissionInput) -> serde_json::Value {
    let availability: Vec<serde_json::Value> = input
        .availability
        .iter()
        .map(|window| {
            serde_json::json!({
                "event_id": window.event_id,
                "kind": match window.kind {
                    WindowKindBody::Available => "available",
                    WindowKindBody::Unavailable => "unavailable",
                },
                "start": window.start,
                "end": window.end,
            })
        })
        .collect();
    serde_json::json!({
        "form_version_id": input.form_version_id,
        "locale": crate::forms::locale_str(input.locale),
        "answers": input.answers,
        "availability": availability,
        "elapsed_ms": input.elapsed_ms,
    })
}

/// The question ids that carried something, for `submissions.raw_keys`.
fn answered_keys(answers: &BTreeMap<String, Answer>) -> Vec<String> {
    answers
        .iter()
        .filter(|(_, answer)| match answer {
            Answer::Null => false,
            Answer::Text(text) => !text.trim().is_empty(),
            Answer::List(values) => !values.is_empty(),
            Answer::Flag(_) | Answer::Other => true,
        })
        .map(|(key, _)| key.clone())
        .collect()
}
