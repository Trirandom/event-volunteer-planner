// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Reconciling a stored first-party form submission into the pool
//! (docs/08 §6, §8, §9; ADR-0042): read what it stored, ask
//! [`evp_intake`] who it is, and apply that — the volunteer, a confirmed
//! participation per event they are available for, and the windows they
//! declared — or hold it for a coordinator.
//!
//! The deciding is `evp_intake`'s, over values read here. What stays here is
//! what only the database can say: who already holds an address, whose
//! normalised name is similar (the trigram index, under the same unaccent
//! dictionary `display_name_norm` was built with), and which columns a
//! coordinator has locked.
//!
//! Runs on the caller's transaction, inside a savepoint of its own: the
//! public route reconciles in the transaction that stored the submission, and
//! a failure here must cost the volunteer's answers nothing. Rolled back to
//! the savepoint, the submission stays `received`, stored, for
//! `evp-cli reconcile` to retry.

use evp_domain::submission::{Asked, Window, WindowKind};
use evp_intake::internal_form::{self, Derived, MapError};
use evp_intake::reconcile::{self, Candidate, Conflict, Decision, Incoming, MatchKind, Ranked};
use jiff_sqlx::ToSqlx as _;
use sqlx::{Connection as _, PgConnection, PgPool, Row as _};
use uuid::Uuid;

use crate::DbError;

/// The candidates a review item keeps. More than this many people above the
/// threshold is a name so common that a longer list helps nobody decide.
const MAX_CANDIDATES: i64 = 10;

/// What became of one submission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Applied {
        volunteer_id: Uuid,
        kind: MatchKind,
    },
    /// Held for a coordinator: an ambiguous name, an address claimed by
    /// someone else, or a payload that would not map.
    NeedsReview,
    /// Not `received` — already reconciled, held by the timing floor, or not a
    /// form submission — or its payload has expired. Nothing was written.
    Skipped,
}

/// Reconciles one `received` submission of a first-party form.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails — including a `23505` when another
/// submission created a volunteer with the same address in between. The
/// savepoint is rolled back first, so the caller's transaction is usable and
/// the submission is exactly as it was.
pub async fn reconcile(
    conn: &mut PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
) -> Result<Outcome, DbError> {
    let mut savepoint = conn.begin().await.map_err(DbError::Query)?;
    match reconcile_in(&mut savepoint, org_id, submission_id).await {
        Ok(outcome) => {
            savepoint.commit().await.map_err(DbError::Query)?;
            Ok(outcome)
        }
        Err(error) => {
            savepoint.rollback().await.map_err(DbError::Query)?;
            Err(error)
        }
    }
}

/// The `received` first-party submissions of the organisation, in the order
/// they arrived — what a backfill hands to [`reconcile`] one by one, so that
/// a later answer supersedes an earlier one rather than the reverse.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn pending(conn: &mut PgConnection, org_id: Uuid) -> Result<Vec<Uuid>, DbError> {
    sqlx::query(
        "SELECT id FROM submissions \
          WHERE org_id = $1 AND state = 'received' AND form_version_id IS NOT NULL \
          ORDER BY received_at, id",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?
    .iter()
    .map(|row| row.try_get("id").map_err(DbError::Query))
    .collect()
}

// ---------------------------------------------------------------------------
// The review queue (docs/08 §6, docs/04 `…/intake/submissions`)
// ---------------------------------------------------------------------------

/// What the submission said about who they are, for the side-by-side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claimed {
    pub display_name: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
}

/// A volunteer the submission could be: the evidence reconciliation stored,
/// and the volunteer as the pool holds them *now* — read at display time,
/// because the submission keeps ids only.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewCandidate {
    pub volunteer_id: Uuid,
    pub score: f32,
    pub last_name_agrees: bool,
    pub phone_agrees: bool,
    pub display_name: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
}

/// One `{field, code, message}` entry of `submissions.errors`: why it is here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewReason {
    pub field: String,
    pub code: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ReviewItem {
    pub id: Uuid,
    pub received_at: jiff::Timestamp,
    /// `None` for a payload that would not map — only rejecting it is offered.
    pub claimed: Option<Claimed>,
    pub answers: Vec<crate::submissions::Answer>,
    /// The `available` windows the payload declared; nothing is written to
    /// `availability_windows` until it is resolved.
    pub availability: Vec<crate::submissions::AvailabilityWindow>,
    pub reasons: Vec<ReviewReason>,
    /// Best first. Empty for a submission held by the timing floor, which was
    /// never compared with the pool.
    pub candidates: Vec<ReviewCandidate>,
}

/// Every `needs_review` form submission of the organisation, oldest first.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn review_queue(
    conn: &mut PgConnection,
    org_id: Uuid,
) -> Result<Vec<ReviewItem>, DbError> {
    use std::collections::HashMap;
    use std::collections::hash_map::Entry;

    let rows = sqlx::query(
        "SELECT s.id, s.received_at, s.locale, s.form_version_id, s.errors, s.match_candidates, \
                p.raw \
           FROM submissions s \
           LEFT JOIN submission_payloads p ON p.submission_id = s.id AND p.org_id = s.org_id \
          WHERE s.org_id = $1 AND s.state = 'needs_review' AND s.form_version_id IS NOT NULL \
          ORDER BY s.received_at, s.id",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let mut versions: HashMap<Uuid, Vec<crate::forms::Question>> = HashMap::new();
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let version_id: Uuid = row.try_get("form_version_id").map_err(DbError::Query)?;
        if let Entry::Vacant(slot) = versions.entry(version_id) {
            slot.insert(crate::forms::questions_of(conn, org_id, version_id).await?);
        }
        let questions = versions.get(&version_id).map_or(&[][..], Vec::as_slice);
        items.push(review_item(conn, org_id, row, questions).await?);
    }
    Ok(items)
}

async fn review_item(
    conn: &mut PgConnection,
    org_id: Uuid,
    row: &sqlx::postgres::PgRow,
    questions: &[crate::forms::Question],
) -> Result<ReviewItem, DbError> {
    let locale = row
        .try_get::<Option<String>, _>("locale")
        .map_err(DbError::Query)?
        .and_then(|locale| evp_domain::form::Locale::parse(&locale))
        .unwrap_or(evp_domain::form::Locale::Fr);
    let raw: Option<serde_json::Value> = row.try_get("raw").map_err(DbError::Query)?;
    let raw = raw.unwrap_or(serde_json::Value::Null);

    let asked: Vec<Asked<'_>> = questions
        .iter()
        .map(|question| Asked {
            id: question.id,
            question: &question.draft,
        })
        .collect();
    let derived = internal_form::parse_payload(&raw)
        .and_then(|payload| internal_form::derive(&asked, &payload))
        .ok();
    let answers = raw
        .get("answers")
        .and_then(serde_json::Value::as_object)
        .map(|answers| crate::submissions::form_answers(answers, questions, locale))
        .unwrap_or_default();
    let availability = derived
        .as_ref()
        .map(|derived| {
            derived
                .windows
                .iter()
                .filter(|window| window.kind == WindowKind::Available)
                .map(|window| crate::submissions::AvailabilityWindow {
                    event_id: window.event_id,
                    start: window.start,
                    end: window.end,
                })
                .collect()
        })
        .unwrap_or_default();
    let claimed = derived.map(|derived| Claimed {
        display_name: derived.display_name,
        first_name: derived.volunteer.first_name,
        last_name: derived.volunteer.last_name,
        email: derived.volunteer.email,
        phone: derived.volunteer.phone,
    });

    let errors: Option<serde_json::Value> = row.try_get("errors").map_err(DbError::Query)?;
    let reasons = errors
        .as_ref()
        .and_then(serde_json::Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(|error| {
                    Some(ReviewReason {
                        field: error.get("field")?.as_str()?.to_owned(),
                        code: error.get("code")?.as_str()?.to_owned(),
                        message: error
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let stored: Option<serde_json::Value> =
        row.try_get("match_candidates").map_err(DbError::Query)?;
    let candidates = review_candidates(conn, org_id, stored.as_ref()).await?;

    Ok(ReviewItem {
        id: row.try_get("id").map_err(DbError::Query)?,
        received_at: row
            .try_get::<jiff_sqlx::Timestamp, _>("received_at")
            .map_err(DbError::Query)?
            .to_jiff(),
        claimed,
        answers,
        availability,
        reasons,
        candidates,
    })
}

/// The stored candidates, joined to the pool as it is now. A candidate since
/// deleted or anonymised is no longer one.
async fn review_candidates(
    conn: &mut PgConnection,
    org_id: Uuid,
    stored: Option<&serde_json::Value>,
) -> Result<Vec<ReviewCandidate>, DbError> {
    let Some(stored) = stored.and_then(serde_json::Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut candidates = Vec::with_capacity(stored.len());
    for entry in stored {
        let Some(volunteer_id) = entry
            .get("volunteer_id")
            .and_then(serde_json::Value::as_str)
            .and_then(|id| id.parse::<Uuid>().ok())
        else {
            continue;
        };
        let row = sqlx::query(
            "SELECT display_name, first_name, last_name, email::text AS email, phone \
               FROM volunteers \
              WHERE org_id = $1 AND id = $2 AND anonymized_at IS NULL",
        )
        .bind(org_id)
        .bind(volunteer_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(DbError::Query)?;
        let Some(row) = row else {
            continue;
        };
        let flag = |name: &str| entry.get(name).and_then(serde_json::Value::as_bool);
        candidates.push(ReviewCandidate {
            volunteer_id,
            score: entry
                .get("score")
                .and_then(|score| serde_json::from_value::<f32>(score.clone()).ok())
                .unwrap_or(0.0),
            last_name_agrees: flag("last_name_agrees").unwrap_or(false),
            phone_agrees: flag("phone_agrees").unwrap_or(false),
            display_name: row.try_get("display_name").map_err(DbError::Query)?,
            first_name: row.try_get("first_name").map_err(DbError::Query)?,
            last_name: row.try_get("last_name").map_err(DbError::Query)?,
            email: row.try_get("email").map_err(DbError::Query)?,
            phone: row.try_get("phone").map_err(DbError::Query)?,
        });
    }
    Ok(candidates)
}

/// A coordinator's decision on a held submission (docs/04
/// `…/intake/submissions/{sub}/resolve`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// It is this volunteer: apply it to them (`match_kind = 'manual'`).
    Match(Uuid),
    /// It is nobody in the pool: create them (`match_kind = 'new'`).
    CreateNew,
    /// Spam, a test, a duplicate: keep it, apply nothing.
    Reject(String),
    /// Run the ladder again — for a submission the timing floor held, which
    /// was never compared with the pool. Its old reasons are cleared: a
    /// coordinator has looked at them. It may come straight back, with new
    /// ones.
    Reconcile,
}

impl Resolution {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Match(_) => "match",
            Self::CreateNew => "create_new",
            Self::Reject(_) => "reject",
            Self::Reconcile => "reconcile",
        }
    }
}

/// What a resolution did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reviewed {
    Applied {
        volunteer_id: Uuid,
        kind: MatchKind,
        /// The submitted address belongs to another volunteer, so it was not
        /// written to this one (ADR-0028).
        email_withheld: bool,
    },
    Rejected,
    /// [`Resolution::Reconcile`] found it ambiguous after all.
    StillNeedsReview,
}

/// Why a resolution was refused, with nothing written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Not `needs_review` any more (someone else resolved it), or not a form
    /// submission of this organisation.
    NotPending,
    /// [`Resolution::Match`] names no volunteer of the organisation.
    UnknownVolunteer,
    /// Its payload does not map, so there is nothing to apply: reject it.
    Unmappable,
}

/// Resolves one `needs_review` submission, on the caller's transaction, and
/// records it as an operation (ADR-0024).
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn resolve(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
    submission_id: Uuid,
    resolution: &Resolution,
) -> Result<Result<(Reviewed, crate::catalog::OperationId), Refused>, DbError> {
    let reviewed = match resolution {
        Resolution::Reject(reason) => {
            if lock(conn, org_id, submission_id, "needs_review")
                .await?
                .is_none()
            {
                return Ok(Err(Refused::NotPending));
            }
            reject(conn, org_id, submission_id, reason).await?;
            Reviewed::Rejected
        }
        Resolution::Reconcile => {
            if lock(conn, org_id, submission_id, "needs_review")
                .await?
                .is_none()
            {
                return Ok(Err(Refused::NotPending));
            }
            sqlx::query(
                "UPDATE submissions SET state = 'received', match_candidates = NULL, errors = NULL \
                  WHERE org_id = $1 AND id = $2",
            )
            .bind(org_id)
            .bind(submission_id)
            .execute(&mut *conn)
            .await
            .map_err(DbError::Query)?;
            match reconcile_in(conn, org_id, submission_id).await? {
                Outcome::Applied { volunteer_id, kind } => Reviewed::Applied {
                    volunteer_id,
                    kind,
                    email_withheld: false,
                },
                Outcome::NeedsReview | Outcome::Skipped => Reviewed::StillNeedsReview,
            }
        }
        Resolution::Match(target) => {
            match apply_manually(conn, org_id, submission_id, Some(*target)).await? {
                Ok(reviewed) => reviewed,
                Err(refused) => return Ok(Err(refused)),
            }
        }
        Resolution::CreateNew => match apply_manually(conn, org_id, submission_id, None).await? {
            Ok(reviewed) => reviewed,
            Err(refused) => return Ok(Err(refused)),
        },
    };

    sqlx::query(
        "UPDATE submissions SET reviewed_by = $3, reviewed_at = now() \
          WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(submission_id)
    .bind(actor_id)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let operation_id = record_resolution(
        conn,
        (org_id, actor_id, submission_id),
        resolution,
        reviewed,
    )
    .await?;
    Ok(Ok((reviewed, operation_id)))
}

/// [`Resolution::Match`] (`target`) or [`Resolution::CreateNew`] (`None`).
async fn apply_manually(
    conn: &mut PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
    target: Option<Uuid>,
) -> Result<Result<Reviewed, Refused>, DbError> {
    let ready = match load(conn, org_id, submission_id, "needs_review").await? {
        Loaded::Missing => return Ok(Err(Refused::NotPending)),
        Loaded::Unmappable(..) => return Ok(Err(Refused::Unmappable)),
        Loaded::Ready(ready) => ready,
    };
    let email_owner = match &ready.derived.volunteer.email {
        Some(email) => {
            sqlx::query("SELECT id FROM volunteers WHERE org_id = $1 AND email = $2::citext")
                .bind(org_id)
                .bind(email)
                .fetch_optional(&mut *conn)
                .await
                .map_err(DbError::Query)?
                .map(|row| row.try_get::<Uuid, _>("id").map_err(DbError::Query))
                .transpose()?
        }
        None => None,
    };
    let (volunteer_id, kind) = if let Some(volunteer_id) = target {
        let known = sqlx::query(
            "SELECT 1 FROM volunteers WHERE org_id = $1 AND id = $2 AND anonymized_at IS NULL",
        )
        .bind(org_id)
        .bind(volunteer_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(DbError::Query)?;
        if known.is_none() {
            return Ok(Err(Refused::UnknownVolunteer));
        }
        update_volunteer(conn, org_id, volunteer_id, &ready).await?;
        (volunteer_id, MatchKind::Manual)
    } else {
        (
            insert_volunteer(conn, org_id, &ready, email_owner.is_some()).await?,
            MatchKind::New,
        )
    };
    apply(conn, (org_id, submission_id, volunteer_id), &ready, kind).await?;
    Ok(Ok(Reviewed::Applied {
        volunteer_id,
        kind,
        email_withheld: email_owner.is_some_and(|owner| owner != volunteer_id),
    }))
}

/// The resolution as an ADR-0024 operation. There is no undo executor yet
/// (ADR-0024 §2); the inverse is the command it will run: put the submission
/// back in the queue and, for a volunteer this created, remove them again.
async fn record_resolution(
    conn: &mut PgConnection,
    (org_id, actor_id, submission_id): (Uuid, Uuid, Uuid),
    resolution: &Resolution,
    reviewed: Reviewed,
) -> Result<crate::catalog::OperationId, DbError> {
    let mut entity_ids = vec![submission_id];
    let mut created = None;
    if let Reviewed::Applied {
        volunteer_id, kind, ..
    } = reviewed
    {
        entity_ids.push(volunteer_id);
        created = (kind == MatchKind::New).then_some(volunteer_id);
    }
    crate::catalog::record_form_operation(
        conn,
        org_id,
        None,
        actor_id,
        "submission.resolve",
        serde_json::json!({ "submission_id": submission_id, "action": resolution.as_str() }),
        serde_json::json!({
            "command": "submission.reopen",
            "submission_id": submission_id,
            "delete_volunteer_id": created,
        }),
        &entity_ids,
    )
    .await
}

async fn reject(
    conn: &mut PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
    reason: &str,
) -> Result<(), DbError> {
    let reason = reason.trim();
    let entry = serde_json::json!([{
        "field": "review",
        "code": "rejected",
        "message": (!reason.is_empty()).then_some(reason),
    }]);
    sqlx::query(
        "UPDATE submissions \
            SET state = 'rejected', errors = coalesce(errors, '[]'::jsonb) || $3 \
          WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(submission_id)
    .bind(entry)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    Ok(())
}

/// What [`backfill`] did, submission by submission.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Backfilled {
    pub applied: usize,
    pub needs_review: usize,
    pub skipped: usize,
    /// Rolled back and left `received`; each is logged with its id.
    pub failed: usize,
}

/// Reconciles every [`pending`] submission of `org_id`, each in its own
/// transaction — the retry path for a submission whose inline reconcile
/// failed, and the catch-up for those stored before reconciliation existed.
///
/// Connects as whatever role `pool` is: run it as `evp_api`, so the tenant
/// policies hold exactly as they do for a request. One transaction per
/// submission, so one that fails costs the others nothing, and a resubmission
/// sees the volunteer its predecessor created.
///
/// # Errors
///
/// [`DbError::Query`] if a transaction cannot begin or commit, or the list of
/// pending submissions cannot be read. A failing reconcile is counted, not
/// returned.
pub async fn backfill(pool: &PgPool, org_id: Uuid) -> Result<Backfilled, DbError> {
    let pending = {
        let mut tx = scoped(pool, org_id).await?;
        let pending = pending(&mut tx, org_id).await?;
        tx.commit().await.map_err(DbError::Query)?;
        pending
    };
    let mut done = Backfilled::default();
    for submission_id in pending {
        let mut tx = scoped(pool, org_id).await?;
        let count = match reconcile(&mut tx, org_id, submission_id).await {
            Ok(Outcome::Applied { .. }) => &mut done.applied,
            Ok(Outcome::NeedsReview) => &mut done.needs_review,
            Ok(Outcome::Skipped) => &mut done.skipped,
            Err(error) => {
                tracing::warn!(%org_id, %submission_id, error = ?error, "reconcile failed");
                &mut done.failed
            }
        };
        *count = count.saturating_add(1);
        tx.commit().await.map_err(DbError::Query)?;
    }
    Ok(done)
}

/// A transaction under `org_id`'s tenant policies, as the org extractor
/// leaves a request's.
async fn scoped(
    pool: &PgPool,
    org_id: Uuid,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, DbError> {
    let mut tx = pool.begin().await.map_err(DbError::Query)?;
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(DbError::Query)?;
    Ok(tx)
}

/// The submission row and what it needs from its source and payload.
struct Stored {
    source_id: Uuid,
    batch_id: Uuid,
    form_id: Uuid,
    form_version_id: Uuid,
    locale: String,
    received_at: jiff_sqlx::Timestamp,
    threshold: f32,
    raw: serde_json::Value,
}

async fn reconcile_in(
    conn: &mut PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
) -> Result<Outcome, DbError> {
    let ready = match load(conn, org_id, submission_id, "received").await? {
        Loaded::Missing => return Ok(Outcome::Skipped),
        Loaded::Unmappable(stored, error) => {
            hold(
                conn,
                org_id,
                submission_id,
                &stored,
                &[],
                Some(unmappable(&error)),
            )
            .await?;
            return Ok(Outcome::NeedsReview);
        }
        Loaded::Ready(ready) => ready,
    };

    let decision = decide(conn, org_id, &ready.derived, ready.stored.threshold).await?;
    let (volunteer_id, kind) = match decision {
        Decision::Apply { volunteer_id, kind } => {
            update_volunteer(conn, org_id, volunteer_id, &ready).await?;
            (volunteer_id, kind)
        }
        Decision::Create => (
            insert_volunteer(conn, org_id, &ready, false).await?,
            MatchKind::New,
        ),
        Decision::Review {
            candidates,
            conflict,
        } => {
            let errors = conflict.map(conflict_error);
            hold(
                conn,
                org_id,
                submission_id,
                &ready.stored,
                &candidates,
                errors,
            )
            .await?;
            return Ok(Outcome::NeedsReview);
        }
    };
    apply(conn, (org_id, submission_id, volunteer_id), &ready, kind).await?;
    Ok(Outcome::Applied { volunteer_id, kind })
}

/// Everything applying a submission needs, read once.
struct Ready {
    stored: Stored,
    form: crate::forms::Form,
    version: crate::forms::FormVersion,
    derived: Derived,
}

enum Loaded {
    /// Not in the expected state, not a form submission, or its payload or
    /// version is gone.
    Missing,
    Unmappable(Stored, MapError),
    Ready(Box<Ready>),
}

/// The submission in `state`, locked, with its form, the version it pinned and
/// what its payload maps to.
async fn load(
    conn: &mut PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
    state: &str,
) -> Result<Loaded, DbError> {
    let Some(stored) = lock(conn, org_id, submission_id, state).await? else {
        return Ok(Loaded::Missing);
    };
    let Some(form) = crate::forms::get(conn, org_id, stored.form_id).await? else {
        return Ok(Loaded::Missing);
    };
    let Some(version) = crate::forms::get_version(
        conn,
        org_id,
        stored.form_id,
        crate::forms::VersionRef::Id(stored.form_version_id),
    )
    .await?
    else {
        return Ok(Loaded::Missing);
    };
    let asked: Vec<Asked<'_>> = version
        .questions
        .iter()
        .map(|question| Asked {
            id: question.id,
            question: &question.draft,
        })
        .collect();
    let derived = internal_form::parse_payload(&stored.raw)
        .and_then(|payload| internal_form::derive(&asked, &payload));
    Ok(match derived {
        Ok(derived) => Loaded::Ready(Box::new(Ready {
            stored,
            form,
            version,
            derived,
        })),
        Err(error) => Loaded::Unmappable(stored, error),
    })
}

/// Availability, then the submission marked applied — the part every way of
/// resolving an identity shares.
async fn apply(
    conn: &mut PgConnection,
    (org_id, submission_id, volunteer_id): (Uuid, Uuid, Uuid),
    ready: &Ready,
    kind: MatchKind,
) -> Result<(), DbError> {
    let events = crate::public_forms::scope_events(
        conn,
        org_id,
        ready.form.festival_id,
        ready.form.event_id,
    )
    .await?
    .into_iter()
    .map(|event| event.id)
    .collect::<Vec<_>>();
    apply_availability(
        conn,
        (org_id, volunteer_id, submission_id),
        &events,
        &ready.derived.windows,
    )
    .await?;
    mark_applied(
        conn,
        (org_id, submission_id, volunteer_id),
        &ready.stored,
        kind,
    )
    .await
}

/// The submission, locked against a concurrent reconcile or review of the
/// same row — `None` unless it is a form submission in `expected` state whose
/// payload is still there to read.
async fn lock(
    conn: &mut PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
    expected: &str,
) -> Result<Option<Stored>, DbError> {
    let row = sqlx::query(
        "SELECT s.state::text AS state, s.source_id, s.batch_id, s.form_version_id, s.locale, \
                s.received_at, src.form_id, src.fuzzy_threshold, p.raw \
           FROM submissions s \
           JOIN intake_sources src ON src.id = s.source_id AND src.org_id = s.org_id \
           LEFT JOIN submission_payloads p ON p.submission_id = s.id AND p.org_id = s.org_id \
          WHERE s.org_id = $1 AND s.id = $2 \
            FOR UPDATE OF s",
    )
    .bind(org_id)
    .bind(submission_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let state: String = row.try_get("state").map_err(DbError::Query)?;
    let form_id: Option<Uuid> = row.try_get("form_id").map_err(DbError::Query)?;
    let form_version_id: Option<Uuid> = row.try_get("form_version_id").map_err(DbError::Query)?;
    let raw: Option<serde_json::Value> = row.try_get("raw").map_err(DbError::Query)?;
    let (Some(form_id), Some(form_version_id), Some(raw)) = (form_id, form_version_id, raw) else {
        return Ok(None);
    };
    if state != expected {
        return Ok(None);
    }
    Ok(Some(Stored {
        source_id: row.try_get("source_id").map_err(DbError::Query)?,
        batch_id: row.try_get("batch_id").map_err(DbError::Query)?,
        form_id,
        form_version_id,
        locale: row
            .try_get::<Option<String>, _>("locale")
            .map_err(DbError::Query)?
            .unwrap_or_else(|| "fr".to_owned()),
        received_at: row.try_get("received_at").map_err(DbError::Query)?,
        threshold: row.try_get("fuzzy_threshold").map_err(DbError::Query)?,
        raw,
    }))
}

/// Reads who the submission could be, and lets the ladder decide.
async fn decide(
    conn: &mut PgConnection,
    org_id: Uuid,
    derived: &Derived,
    threshold: f32,
) -> Result<Decision, DbError> {
    let fields = &derived.volunteer;
    // Folded by PostgreSQL, exactly as `display_name_norm` is, so the incoming
    // side and the stored side are compared under one definition of "same".
    let norms = sqlx::query(
        "SELECT lower(regexp_replace(immutable_unaccent($1), '\\s+', ' ', 'g')) AS display_norm, \
                lower(immutable_unaccent(btrim($2))) AS first_norm, \
                lower(immutable_unaccent(btrim($3))) AS last_norm",
    )
    .bind(&derived.display_name)
    .bind(&fields.first_name)
    .bind(&fields.last_name)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    let display_norm: String = norms.try_get("display_norm").map_err(DbError::Query)?;
    let first_norm: Option<String> = norms.try_get("first_norm").map_err(DbError::Query)?;
    let last_norm: Option<String> = norms.try_get("last_norm").map_err(DbError::Query)?;

    let email_owner = match &fields.email {
        Some(email) => sqlx::query(
            "SELECT id, similarity(display_name_norm, $3) AS score, \
                    lower(immutable_unaccent(btrim(first_name))) AS first_norm, \
                    lower(immutable_unaccent(btrim(last_name))) AS last_norm, phone \
               FROM volunteers \
              WHERE org_id = $1 AND email = $2::citext \
                FOR UPDATE",
        )
        .bind(org_id)
        .bind(email)
        .bind(&display_norm)
        .fetch_optional(&mut *conn)
        .await
        .map_err(DbError::Query)?
        .as_ref()
        .map(candidate)
        .transpose()?,
        None => None,
    };

    // `%` narrows through the trigram index at pg_trgm's own (lower) default;
    // the source's threshold is then applied exactly, without a session
    // setting that would outlive this statement.
    let by_name = if email_owner.is_none() {
        sqlx::query(
            "SELECT id, similarity(display_name_norm, $2) AS score, \
                    lower(immutable_unaccent(btrim(first_name))) AS first_norm, \
                    lower(immutable_unaccent(btrim(last_name))) AS last_norm, phone \
               FROM volunteers \
              WHERE org_id = $1 AND anonymized_at IS NULL \
                AND display_name_norm % $2 AND similarity(display_name_norm, $2) >= $3 \
              ORDER BY score DESC, id \
              LIMIT $4",
        )
        .bind(org_id)
        .bind(&display_norm)
        .bind(threshold)
        .bind(MAX_CANDIDATES)
        .fetch_all(&mut *conn)
        .await
        .map_err(DbError::Query)?
        .iter()
        .map(candidate)
        .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };

    let incoming = Incoming {
        first_name: first_norm.as_deref(),
        last_name: last_norm.as_deref(),
        phone: fields.phone.as_deref(),
    };
    Ok(reconcile::decide(
        &incoming,
        email_owner.as_ref(),
        &by_name,
        threshold,
    ))
}

fn candidate(row: &sqlx::postgres::PgRow) -> Result<Candidate, DbError> {
    Ok(Candidate {
        volunteer_id: row.try_get("id").map_err(DbError::Query)?,
        score: row.try_get("score").map_err(DbError::Query)?,
        first_name: row.try_get("first_norm").map_err(DbError::Query)?,
        last_name: row.try_get("last_norm").map_err(DbError::Query)?,
        phone: row.try_get("phone").map_err(DbError::Query)?,
    })
}

/// docs/15: pool consent lasts this long after the last contact. A constant
/// until organisations can set their own (up to 36 months).
const POOL_CONSENT_INTERVAL: &str = "18 months";

/// A new volunteer from the submission. `without_email` is a coordinator's
/// "create new" on an address that already belongs to someone else: the
/// address stays with its owner (ADR-0028), and the new volunteer is recorded
/// with none until the coordinator gives them their own.
async fn insert_volunteer(
    conn: &mut PgConnection,
    org_id: Uuid,
    ready: &Ready,
    without_email: bool,
) -> Result<Uuid, DbError> {
    let (derived, stored) = (&ready.derived, &ready.stored);
    let fields = &derived.volunteer;
    let volunteer_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO volunteers \
           (id, org_id, display_name, first_name, last_name, email, phone, tshirt_size, \
            dietary, notes, locale, pool_consent_at, pool_consent_version, pool_consent_expires) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, \
                 CASE WHEN $12 THEN $13 END, \
                 CASE WHEN $12 THEN $14 END, \
                 CASE WHEN $12 THEN $13 + $15::interval END)",
    )
    .bind(volunteer_id)
    .bind(org_id)
    .bind(&derived.display_name)
    .bind(&fields.first_name)
    .bind(&fields.last_name)
    .bind(if without_email {
        None
    } else {
        fields.email.as_deref()
    })
    .bind(&fields.phone)
    .bind(&fields.tshirt_size)
    .bind(&fields.dietary)
    .bind(&fields.notes)
    .bind(&stored.locale)
    .bind(derived.pool_consent)
    .bind(stored.received_at)
    .bind(&ready.version.privacy_notice_version)
    .bind(POOL_CONSENT_INTERVAL)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    Ok(volunteer_id)
}

/// docs/08 §8: the newest answer wins, except over a column a coordinator
/// has locked by editing it, and except where this answer said nothing. An
/// address that belongs to another volunteer stays theirs (ADR-0028) — only a
/// coordinator's manual match can reach here with one.
///
/// `display_name` is not touched: on an existing volunteer it is the roster
/// label, which may well be one a coordinator chose (ADR-0012). Pool consent
/// is given or renewed, never withdrawn by a form that did not ask — and a
/// submission is contact, so an existing consent's expiry moves forward
/// (docs/15: "last contact + org policy").
async fn update_volunteer(
    conn: &mut PgConnection,
    org_id: Uuid,
    volunteer_id: Uuid,
    ready: &Ready,
) -> Result<(), DbError> {
    let (derived, stored, version) = (&ready.derived, &ready.stored, &ready.version);
    let fields = &derived.volunteer;
    sqlx::query(
        "UPDATE volunteers SET \
           first_name  = CASE WHEN $3::text  IS NULL OR 'first_name'  = ANY(locked_fields) \
                              THEN first_name  ELSE $3  END, \
           last_name   = CASE WHEN $4::text  IS NULL OR 'last_name'   = ANY(locked_fields) \
                              THEN last_name   ELSE $4  END, \
           email       = CASE WHEN $5::citext IS NULL OR 'email'      = ANY(locked_fields) \
                                   OR EXISTS (SELECT 1 FROM volunteers other \
                                               WHERE other.org_id = $1 AND other.email = $5 \
                                                 AND other.id <> $2) \
                              THEN email       ELSE $5  END, \
           phone       = CASE WHEN $6::text  IS NULL OR 'phone'       = ANY(locked_fields) \
                              THEN phone       ELSE $6  END, \
           tshirt_size = CASE WHEN $7::text  IS NULL OR 'tshirt_size' = ANY(locked_fields) \
                              THEN tshirt_size ELSE $7  END, \
           dietary     = CASE WHEN $8::text  IS NULL OR 'dietary'     = ANY(locked_fields) \
                              THEN dietary     ELSE $8  END, \
           notes       = CASE WHEN $9::text  IS NULL OR 'notes'       = ANY(locked_fields) \
                              THEN notes       ELSE $9  END, \
           locale      = CASE WHEN 'locale' = ANY(locked_fields) THEN locale ELSE $10 END, \
           pool_consent_at      = CASE WHEN $11 THEN $12 ELSE pool_consent_at END, \
           pool_consent_version = CASE WHEN $11 THEN $13 ELSE pool_consent_version END, \
           pool_consent_expires = CASE WHEN $11 OR pool_consent_at IS NOT NULL \
                                       THEN $12 + $14::interval \
                                       ELSE pool_consent_expires END, \
           updated_at = now() \
         WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(volunteer_id)
    .bind(&fields.first_name)
    .bind(&fields.last_name)
    .bind(&fields.email)
    .bind(&fields.phone)
    .bind(&fields.tshirt_size)
    .bind(&fields.dietary)
    .bind(&fields.notes)
    .bind(&stored.locale)
    .bind(derived.pool_consent)
    .bind(stored.received_at)
    .bind(&version.privacy_notice_version)
    .bind(POOL_CONSENT_INTERVAL)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    Ok(())
}

/// One participation per event the volunteer said they are available for,
/// and that submission's windows on it — replacing the windows an earlier
/// submission of theirs left on the form's events (docs/08 §8: a
/// resubmission replaces its predecessor wholesale). Windows a coordinator
/// declared are never touched (docs/04 §"Participation and availability").
///
/// A form submission is someone offering to come, so the participation is
/// `confirmed`; one a coordinator already moved to `declined` or `withdrawn`
/// keeps their decision. An event answered only with `unavailable` gets no
/// participation (docs/09 §3) — its windows stay in the payload.
async fn apply_availability(
    conn: &mut PgConnection,
    (org_id, volunteer_id, submission_id): (Uuid, Uuid, Uuid),
    scope: &[Uuid],
    windows: &[Window],
) -> Result<(), DbError> {
    sqlx::query(
        "DELETE FROM availability_windows aw \
          USING participations p \
          WHERE aw.participation_id = p.id AND aw.org_id = p.org_id \
            AND aw.org_id = $1 AND p.volunteer_id = $2 AND p.event_id = ANY($3) \
            AND aw.source_submission_id IS NOT NULL",
    )
    .bind(org_id)
    .bind(volunteer_id)
    .bind(scope)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    for &event_id in scope {
        let ours = || {
            windows
                .iter()
                .filter(move |window| window.event_id == event_id)
        };
        if !ours().any(|window| window.kind == WindowKind::Available) {
            continue;
        }
        sqlx::query(
            "INSERT INTO participations (id, org_id, event_id, volunteer_id, status) \
             VALUES ($1, $2, $3, $4, 'confirmed') \
             ON CONFLICT (event_id, volunteer_id) DO UPDATE \
               SET status = 'confirmed', updated_at = now() \
               WHERE participations.status = 'invited'",
        )
        .bind(Uuid::now_v7())
        .bind(org_id)
        .bind(event_id)
        .bind(volunteer_id)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;
        let participation_id: Uuid = sqlx::query(
            "SELECT id FROM participations \
              WHERE org_id = $1 AND event_id = $2 AND volunteer_id = $3",
        )
        .bind(org_id)
        .bind(event_id)
        .bind(volunteer_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(DbError::Query)?
        .try_get("id")
        .map_err(DbError::Query)?;

        for window in ours() {
            sqlx::query(
                "INSERT INTO availability_windows \
                   (id, org_id, participation_id, kind, period, source_submission_id) \
                 VALUES ($1, $2, $3, $4::availability_kind, tstzrange($5, $6), $7)",
            )
            .bind(Uuid::now_v7())
            .bind(org_id)
            .bind(participation_id)
            .bind(match window.kind {
                WindowKind::Available => "available",
                WindowKind::Unavailable => "unavailable",
            })
            .bind(window.start.to_sqlx())
            .bind(window.end.to_sqlx())
            .bind(submission_id)
            .execute(&mut *conn)
            .await
            .map_err(DbError::Query)?;
        }
    }
    Ok(())
}

/// The submission applied, and the volunteer's earlier applied answer to the
/// same form superseded by it — so the coordinator's list shows each person
/// once, with what they said last.
async fn mark_applied(
    conn: &mut PgConnection,
    (org_id, submission_id, volunteer_id): (Uuid, Uuid, Uuid),
    stored: &Stored,
    kind: MatchKind,
) -> Result<(), DbError> {
    let superseded: Option<Uuid> = sqlx::query(
        "WITH older AS ( \
           UPDATE submissions SET state = 'superseded' \
            WHERE org_id = $1 AND source_id = $2 AND volunteer_id = $3 \
              AND state = 'applied' AND id <> $4 \
           RETURNING id, received_at) \
         SELECT id FROM older ORDER BY received_at DESC, id DESC LIMIT 1",
    )
    .bind(org_id)
    .bind(stored.source_id)
    .bind(volunteer_id)
    .bind(submission_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?
    .map(|row| row.try_get("id").map_err(DbError::Query))
    .transpose()?;

    sqlx::query(
        "UPDATE submissions \
            SET state = 'applied', volunteer_id = $3, match_kind = $4::match_kind, \
                applied_at = now(), supersedes_id = $5 \
          WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(submission_id)
    .bind(volunteer_id)
    .bind(kind.as_str())
    .bind(superseded)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let stats = match kind {
        MatchKind::New => serde_json::json!({ "created": 1 }),
        MatchKind::ExactEmail | MatchKind::FuzzyConfirmed | MatchKind::Manual => {
            serde_json::json!({ "updated": 1 })
        }
    };
    batch_stats(conn, org_id, stored.batch_id, &stats, true).await
}

/// Held for a coordinator, with the candidates the review queue will offer —
/// ids and evidence only ([`Ranked`]) — and why, when there is more to say
/// than "similar name".
async fn hold(
    conn: &mut PgConnection,
    org_id: Uuid,
    submission_id: Uuid,
    stored: &Stored,
    candidates: &[Ranked],
    errors: Option<serde_json::Value>,
) -> Result<(), DbError> {
    let candidates: Vec<serde_json::Value> = candidates
        .iter()
        .map(|candidate| {
            serde_json::json!({
                "volunteer_id": candidate.volunteer_id,
                "score": candidate.score,
                "last_name_agrees": candidate.last_name_agrees,
                "phone_agrees": candidate.phone_agrees,
            })
        })
        .collect();
    sqlx::query(
        "UPDATE submissions \
            SET state = 'needs_review', match_candidates = $3, \
                errors = CASE WHEN $4::jsonb IS NULL THEN errors \
                              ELSE coalesce(errors, '[]'::jsonb) || $4 END \
          WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(submission_id)
    .bind(serde_json::Value::Array(candidates))
    .bind(errors)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    batch_stats(
        conn,
        org_id,
        stored.batch_id,
        &serde_json::json!({ "review": 1 }),
        false,
    )
    .await
}

async fn batch_stats(
    conn: &mut PgConnection,
    org_id: Uuid,
    batch_id: Uuid,
    stats: &serde_json::Value,
    applied: bool,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE submission_batches \
            SET stats = $3, applied_at = CASE WHEN $4 THEN now() ELSE applied_at END \
          WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(batch_id)
    .bind(stats)
    .bind(applied)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;
    Ok(())
}

/// `submissions.errors` entries, in the `[{field, code, message}]` shape the
/// timing floor already writes.
fn conflict_error(conflict: Conflict) -> serde_json::Value {
    let message = match conflict {
        Conflict::EmailInUse => {
            "This address already belongs to another volunteer, and the name does not match \
             theirs (ADR-0028)."
        }
    };
    serde_json::json!([{ "field": "email", "code": conflict.as_str(), "message": message }])
}

fn unmappable(error: &MapError) -> serde_json::Value {
    serde_json::json!([{
        "field": "payload",
        "code": "unmappable",
        "message": error.to_string(),
    }])
}
