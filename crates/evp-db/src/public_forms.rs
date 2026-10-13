// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The unauthenticated side of the first-party form: finding a form by its
//! public slug, and storing what a volunteer sent (docs/04 §"Public and
//! unauthenticated", docs/08 §9, docs/09 §4–§5).
//!
//! ## How a request with no session gets an organisation
//!
//! [`resolve`] is the only place in the system that learns an `org_id` from
//! something other than a session's membership. It does so through the
//! `forms_public_slug_read` policy (migration `…200100`, where the full
//! argument is written next to the policy): the request names a slug in
//! `app.public_form_slug`, which makes exactly one row of `forms` visible —
//! and only while that form is live and open, i.e. only while it is already
//! public. From that row it takes the `org_id`, clears the slug, and sets
//! `app.current_org_id`; everything the handler reads or writes afterwards
//! (versions, questions, events, intake rows) goes through the ordinary
//! tenant policies, exactly as a coordinator's request would.
//!
//! Every variable is set with `set_config(…, true)`, which is `SET LOCAL`:
//! it ends with the transaction, so nothing leaks onto the next request that
//! borrows the pooled connection. That also makes [`resolve`] fail *closed*
//! if a caller forgets the transaction — outside one, each `set_config` lasts
//! for its own statement only, the `SELECT` that follows sees nothing, and the
//! answer is `None`.
//!
//! Same statement conventions as [`crate::catalog`]: runtime `sqlx::query`.

use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;
use crate::catalog::Event;

/// The organisation and form a public slug names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolved {
    pub org_id: Uuid,
    pub form_id: Uuid,
}

/// Which organisation's live, publicly open form `slug` names — and, when
/// there is one, scopes the caller's transaction to that organisation.
///
/// `None` for an unknown slug, a form with nothing published, and a form whose
/// public route is closed: the three are one answer by design (docs/09 §5, "no
/// enumeration"), because the policy that makes the row visible is the same
/// predicate that decides it is public.
///
/// Must run inside a transaction, before any other tenant statement of the
/// request. On `Some`, `app.current_org_id` is set for the rest of it.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn resolve(conn: &mut PgConnection, slug: &str) -> Result<Option<Resolved>, DbError> {
    sqlx::query("SELECT set_config('app.public_form_slug', $1, true)")
        .bind(slug)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;

    // The predicate repeats the policy's, as every tenant query here repeats
    // `org_id`: belt and braces, and what keeps this statement correct if the
    // policy is ever widened for another reason.
    let rows = sqlx::query(
        "SELECT org_id, id FROM forms \
          WHERE slug = $1::citext AND live_version_id IS NOT NULL AND public_open",
    )
    .bind(slug)
    .fetch_all(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    // Narrowed back straight away: the slug has done its one job, and the
    // rest of the request is scoped by organisation like any other.
    sqlx::query("SELECT set_config('app.public_form_slug', '', true)")
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;

    // `forms_public_slug` makes a second row impossible. Were it ever to
    // exist, picking one would send a volunteer's answers to whichever
    // organisation sorted first, so ambiguity is "no such form".
    let [row] = rows.as_slice() else {
        return Ok(None);
    };
    let resolved = Resolved {
        org_id: row.try_get("org_id").map_err(DbError::Query)?,
        form_id: row.try_get("id").map_err(DbError::Query)?,
    };

    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(resolved.org_id.to_string())
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;

    Ok(Some(resolved))
}

/// The events a form covers, in period order (ADR-0035): every event of its
/// festival as the festival is *now*, its one event, or none for a
/// pool-recruitment form.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn scope_events(
    conn: &mut PgConnection,
    org_id: Uuid,
    festival_id: Option<Uuid>,
    event_id: Option<Uuid>,
) -> Result<Vec<Event>, DbError> {
    let mut events = match (festival_id, event_id) {
        (Some(festival_id), _) => {
            crate::catalog::list_events_for_festival(conn, org_id, festival_id).await?
        }
        (None, Some(event_id)) => crate::catalog::get_event(conn, org_id, event_id)
            .await?
            .into_iter()
            .collect(),
        (None, None) => Vec::new(),
    };
    events.sort_by(|a, b| {
        (a.period_start, a.period_end, a.id).cmp(&(b.period_start, b.period_end, b.id))
    });
    Ok(events)
}

/// A validated submission, as [`record_submission`] stores it.
#[derive(Debug, Clone)]
pub struct NewSubmission<'a> {
    pub org_id: Uuid,
    pub form_id: Uuid,
    /// For the intake source's name, which is unique per organisation.
    pub form_slug: &'a str,
    /// The form's event scope, if it has one; `NULL` for a festival form,
    /// whose submission belongs to several events at once.
    pub event_id: Option<Uuid>,
    pub form_version_id: Uuid,
    /// Who the form's intake source is recorded as created by, when this is
    /// its first submission: the coordinator who published the live version,
    /// which is what opened the channel.
    pub opened_by: Uuid,
    /// `fr` or `en` (`submissions_locale_known`).
    pub locale: &'a str,
    /// Exactly what arrived, minus the honeypot.
    pub raw: serde_json::Value,
    /// The question ids that carried an answer, kept after the payload
    /// expires so replay history stays coherent (docs/03 §3.10).
    pub raw_keys: Vec<String>,
    /// `Some` holds the submission for review (`needs_review`) with these
    /// `errors`; `None` leaves it `received`, for [`crate::intake::reconcile`].
    pub held: Option<serde_json::Value>,
}

/// Stores one submission: the form's intake source (created on its first
/// submission), a batch of one, the `submissions` row pinned to the version
/// it answered, and its payload — which expires on its own 30-day clock
/// (ADR-0026) — all on the caller's transaction.
///
/// Nothing is reconciled or applied here: no volunteer, participation or
/// availability row is written. That is [`crate::intake::reconcile`]'s, from
/// the payload stored here — which the public route calls next, on the same
/// transaction (ADR-0042), and which a backfill can call again later.
///
/// # Errors
///
/// [`DbError::Query`] if a statement fails.
pub async fn record_submission(
    conn: &mut PgConnection,
    input: &NewSubmission<'_>,
) -> Result<Uuid, DbError> {
    let source_id = form_source(conn, input).await?;

    let batch_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO submission_batches (id, org_id, source_id, trigger, row_count, outcome) \
         VALUES ($1, $2, $3, 'form', 1, 'accepted')",
    )
    .bind(batch_id)
    .bind(input.org_id)
    .bind(source_id)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let (state, errors) = match &input.held {
        Some(errors) => ("needs_review", Some(errors)),
        None => ("received", None),
    };
    // There is no provider response id, so the submission's own id is the
    // idempotency key — which makes every POST a new submission. A volunteer
    // who sends twice is two submissions, superseded at reconciliation
    // (docs/09 §9), not a replay to swallow here.
    let submission_id = Uuid::now_v7();
    let received_at: jiff_sqlx::Timestamp = sqlx::query(
        "INSERT INTO submissions \
           (id, org_id, source_id, batch_id, event_id, external_id, raw_keys, state, errors, \
            form_version_id, locale) \
         VALUES ($1, $2, $3, $4, $5, $1::text, $6, $7::submission_state, $8, $9, $10) \
         RETURNING received_at",
    )
    .bind(submission_id)
    .bind(input.org_id)
    .bind(source_id)
    .bind(batch_id)
    .bind(input.event_id)
    .bind(&input.raw_keys)
    .bind(state)
    .bind(errors)
    .bind(input.form_version_id)
    .bind(input.locale)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?
    .try_get("received_at")
    .map_err(DbError::Query)?;

    sqlx::query(
        "INSERT INTO submission_payloads (submission_id, org_id, raw, received_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(submission_id)
    .bind(input.org_id)
    .bind(&input.raw)
    .bind(received_at)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    sqlx::query("UPDATE intake_sources SET last_submission_at = $3 WHERE org_id = $1 AND id = $2")
        .bind(input.org_id)
        .bind(source_id)
        .bind(received_at)
        .execute(&mut *conn)
        .await
        .map_err(DbError::Query)?;

    Ok(submission_id)
}

/// The form's `internal_form` source, created if this is its first
/// submission. Two first submissions racing meet on
/// `intake_sources_one_per_form` and both read back the one that won.
async fn form_source(conn: &mut PgConnection, input: &NewSubmission<'_>) -> Result<Uuid, DbError> {
    sqlx::query(
        "INSERT INTO intake_sources (id, org_id, event_id, kind, name, form_id, created_by) \
         VALUES ($1, $2, $3, 'internal_form', $4, $5, $6) \
         ON CONFLICT (form_id) WHERE form_id IS NOT NULL DO NOTHING",
    )
    .bind(Uuid::now_v7())
    .bind(input.org_id)
    .bind(input.event_id)
    .bind(format!("Formulaire /f/{}", input.form_slug))
    .bind(input.form_id)
    .bind(input.opened_by)
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    sqlx::query("SELECT id FROM intake_sources WHERE org_id = $1 AND form_id = $2")
        .bind(input.org_id)
        .bind(input.form_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(DbError::Query)?
        .try_get("id")
        .map_err(DbError::Query)
}
