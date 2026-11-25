// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `POST …/events/{event}/publish/test` and `…/festivals/{festival}/publish/test`:
//! the schedule email run, every message sent to one address (ADR-0054,
//! docs/04 §Publishing).
//!
//! **The relay is called from the handler.** ADR-0006 puts every real send
//! through the outbox, and that still holds for `send`. A test send changes
//! no data and must not move anyone's "last sent" baseline, and the
//! coordinator is waiting to be told whether the relay took their address.
//! It writes no outbox row, no snapshot and no operation, and the only
//! address it can reach is the one in the request.
//!
//! The template comes in the body because it has no server-side home yet,
//! and it is rendered by `evp_domain::schedule::plan::compose`, the renderer
//! `send` will use. Rendering it on the page and posting the result would
//! test the page and leave the server untested.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::Arc;

use axum::extract::{FromRef, Path, State};
use axum::{Json, Router};
use evp_domain::schedule::locale::{Locale, Template, Zones};
use evp_domain::schedule::plan::{self, Context, Delivery, Kind, Recipient};
use evp_domain::submission::looks_like_email;
use evp_worker::mail::{MailError, MailSender, OutgoingMail};
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::error::ApiError;
use crate::extract::JsonBody;
use crate::org::Coordinator;

/// The relay every message goes through. A newtype so that `ApiState` can
/// keep deriving `Debug` without asking the relay to format itself, since
/// its transport holds the relay's credentials.
#[derive(Clone)]
pub struct Mailer(Arc<dyn MailSender>);

impl Mailer {
    pub fn new<M: MailSender + 'static>(sender: Arc<M>) -> Self {
        Self(sender)
    }
}

impl fmt::Debug for Mailer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Mailer").finish_non_exhaustive()
    }
}

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
    Mailer: FromRef<S>,
{
    Router::new()
        .route(
            "/api/v1/orgs/{org}/events/{event}/publish/test",
            axum::routing::post(test_event),
        )
        .route(
            "/api/v1/orgs/{org}/festivals/{festival}/publish/test",
            axum::routing::post(test_festival),
        )
}

#[derive(Debug, Deserialize)]
struct EventPath {
    event: Uuid,
}

#[derive(Debug, Deserialize)]
struct FestivalPath {
    festival: Uuid,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TemplateInput {
    pub subject: String,
    pub body_html: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TestSendRequest {
    /// Where every message of the run goes. Exactly one address.
    pub test_recipient: String,
    /// `fr` or `en`: the language the dates and the fixed sentences are
    /// written in, which is the language the coordinator previewed.
    pub locale: String,
    pub template: TemplateInput,
}

/// Why the run stopped. The first failure ends it: when the relay refuses
/// or is unreachable, the next few hundred messages would fail the same way,
/// and each failure can take the relay's full timeout.
#[derive(Debug, Serialize, ToSchema)]
pub struct TestSendFailure {
    /// The volunteer whose message was being sent.
    pub name: String,
    /// `refused` (the relay will not take it), `relay_unavailable` (worth
    /// trying again later), or `render_failed`.
    pub reason: &'static str,
    pub detail: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TestSendResponse {
    pub sent: usize,
    pub skipped_opted_out: usize,
    /// The names of people `send` could not email, so the coordinator can
    /// reach them some other way.
    pub no_address: Vec<String>,
    pub failed: Option<TestSendFailure>,
}

struct Scope {
    event_ids: Vec<Uuid>,
    event_name: String,
    festival_name: String,
}

async fn test_event(
    Coordinator(org): Coordinator,
    State(mailer): State<Mailer>,
    Path(path): Path<EventPath>,
    JsonBody(request): JsonBody<TestSendRequest>,
) -> Result<Json<TestSendResponse>, ApiError> {
    let mut org = org;
    let event = evp_db::catalog::get_event(&mut org.tx, org.org_id, path.event)
        .await?
        .ok_or(ApiError::NotFound)?;
    let festival_name = match event.festival_id {
        Some(festival_id) => evp_db::catalog::get_festival(&mut org.tx, org.org_id, festival_id)
            .await?
            .map(|festival| festival.name)
            .unwrap_or_default(),
        None => String::new(),
    };
    let scope = Scope {
        event_ids: vec![event.id],
        event_name: event.name,
        festival_name,
    };
    run(org, &mailer, scope, request).await
}

async fn test_festival(
    Coordinator(org): Coordinator,
    State(mailer): State<Mailer>,
    Path(path): Path<FestivalPath>,
    JsonBody(request): JsonBody<TestSendRequest>,
) -> Result<Json<TestSendResponse>, ApiError> {
    let mut org = org;
    let festival = evp_db::catalog::get_festival(&mut org.tx, org.org_id, path.festival)
        .await?
        .ok_or(ApiError::NotFound)?;
    let events =
        evp_db::catalog::list_events_for_festival(&mut org.tx, org.org_id, festival.id).await?;
    let scope = Scope {
        event_ids: events.iter().map(|event| event.id).collect(),
        // Empty on purpose: no single day's name is right for a festival-wide
        // message, and `{{eventName|festivalName}}` then falls through.
        event_name: String::new(),
        festival_name: festival.name,
    };
    run(org, &mailer, scope, request).await
}

/// Refuses what no relay would take before anything is sent, with the field
/// named.
fn validate(request: &TestSendRequest) -> Result<(String, Locale), ApiError> {
    let recipient = request.test_recipient.trim();
    if !looks_like_email(recipient) {
        return Err(field_error(
            "test_recipient",
            "test_recipient must be one email address.",
        ));
    }
    let locale = Locale::parse(&request.locale)
        .ok_or_else(|| field_error("locale", "locale must be \"fr\" or \"en\"."))?;
    Ok((recipient.to_owned(), locale))
}

fn field_error(field: &str, message: &str) -> ApiError {
    ApiError::ValidationFields {
        detail: message.to_owned(),
        errors: [(field.to_owned(), vec![message.to_owned()])]
            .into_iter()
            .collect(),
    }
}

async fn run(
    mut org: crate::org::OrgTx,
    mailer: &Mailer,
    scope: Scope,
    request: TestSendRequest,
) -> Result<Json<TestSendResponse>, ApiError> {
    let (to, locale) = validate(&request)?;
    let organization_name = evp_db::schedule::organization_name(&mut org.tx, org.org_id)
        .await?
        .unwrap_or_default();
    let people = evp_db::schedule::run(&mut org.tx, org.org_id, &scope.event_ids).await?;
    // Read-only, and committed before the first message: a few hundred SMTP
    // transactions must not hold a pooled connection and a transaction open.
    org.commit().await?;

    let mut zones = Zones::new();
    let names: BTreeSet<&str> = people
        .iter()
        .flat_map(|person| person.lines.iter().map(|line| line.timezone.as_str()))
        .collect();
    for name in names {
        // `events.timezone` is a foreign key to `timezones`, so jiff knowing
        // every name there is the expectation. One it does not know is left
        // out, and `compose` then reports it as that message's failure.
        if let Ok(zone) = TimeZone::get(name) {
            zones.insert(name, zone);
        }
    }
    let context = Context {
        locale,
        zones,
        event_name: scope.event_name,
        festival_name: scope.festival_name,
        organization_name: organization_name.clone(),
    };
    let template = Template {
        subject: request.template.subject,
        body_html: request.template.body_html,
    };

    let mut response = TestSendResponse {
        sent: 0,
        skipped_opted_out: 0,
        no_address: Vec::new(),
        failed: None,
    };
    for person in people {
        let recipient = Recipient {
            volunteer_id: person.volunteer_id,
            first_name: person.first_name,
            display_name: person.display_name,
            email: person.email,
            notify_email: person.notify_email,
        };
        match plan::delivery(&recipient) {
            Delivery::OptedOut => {
                response.skipped_opted_out = response.skipped_opted_out.saturating_add(1);
                continue;
            }
            Delivery::NoAddress => {
                response.no_address.push(recipient.display_name);
                continue;
            }
            Delivery::Email => {}
        }
        let addressed = Addressed {
            to: &to,
            organization_name: &organization_name,
        };
        if let Err(failure) = send_one(
            mailer,
            &recipient,
            person.lines,
            &template,
            &context,
            addressed,
        )
        .await
        {
            response.failed = Some(failure);
            break;
        }
        response.sent = response.sent.saturating_add(1);
    }
    tracing::info!(
        sent = response.sent,
        skipped_opted_out = response.skipped_opted_out,
        no_address = response.no_address.len(),
        stopped = response.failed.is_some(),
        "schedule email test send"
    );
    Ok(Json(response))
}

/// Where a test message goes and who it is from: the same for every message
/// of a run.
#[derive(Clone, Copy)]
struct Addressed<'a> {
    to: &'a str,
    organization_name: &'a str,
}

/// Renders one volunteer's message and hands it to the relay.
async fn send_one(
    mailer: &Mailer,
    recipient: &Recipient,
    lines: Vec<evp_domain::schedule::lines::ScheduleLine>,
    template: &Template,
    context: &Context,
    addressed: Addressed<'_>,
) -> Result<(), TestSendFailure> {
    let failure = |reason, detail: String| TestSendFailure {
        name: recipient.display_name.clone(),
        reason,
        detail,
    };
    // Nobody has been sent anything yet, so `send` would write the first
    // message to everyone, and the test sends what `send` would.
    let classification = plan::classify(lines, None);
    let message = plan::compose(recipient, Kind::First, &classification, template, context)
        .map_err(|error| failure("render_failed", error.to_string()))?;
    let mail = OutgoingMail {
        id: Uuid::now_v7().to_string(),
        to: addressed.to.to_owned(),
        from_name: Some(addressed.organization_name.to_owned()).filter(|name| !name.is_empty()),
        reply_to: None,
        // Several hundred messages land in one inbox, so each one says whose
        // it is.
        subject: format!("[Test: {}] {}", recipient.display_name, message.subject),
        html: message.html,
        text: message.text,
    };
    mailer.0.send(&mail).await.map_err(|error| {
        tracing::warn!(error = %error, "test send stopped at a relay failure");
        let reason = match error {
            MailError::Permanent(_) => "refused",
            MailError::Transient(_) => "relay_unavailable",
        };
        failure(reason, error.to_string())
    })
}
