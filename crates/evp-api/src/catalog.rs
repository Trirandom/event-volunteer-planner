// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Festivals, events, and the worked example that seeds an empty org
//! (ADR-0032, docs/04 §"Events, locations, shifts").
//!
//! Every handler here takes [`crate::org::Coordinator`] or
//! [`crate::org::ZoneLead`] rather than a bare pool, so the tenant scoping and
//! the role check happen before the handler body runs at all — see
//! [`crate::org`] for the mechanism.

use axum::Router;
use axum::extract::{FromRef, Path};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::SessionPolicy;
use crate::error::ApiError;
use crate::extract::{JsonBody, Precondition, etag};
use crate::org::{Coordinator, Owner, ZoneLead};

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
{
    Router::new()
        .route(
            "/api/v1/orgs/{org}/festivals",
            get(list_festivals).post(create_festival),
        )
        .route(
            "/api/v1/orgs/{org}/festivals/example",
            post(create_festival_example),
        )
        .route("/api/v1/orgs/{org}/festivals/{festival}", get(get_festival))
        .route(
            "/api/v1/orgs/{org}/events",
            get(list_events).post(create_event),
        )
        .route(
            "/api/v1/orgs/{org}/events/example",
            post(create_event_example),
        )
        .route(
            "/api/v1/orgs/{org}/events/{event}",
            get(get_event).patch(patch_event).delete(delete_event),
        )
        .route(
            "/api/v1/orgs/{org}/events/{event}/archive",
            post(archive_event),
        )
}

// ---------------------------------------------------------------------------
// Wire shapes. `period.start` / `period.end` travel as RFC 3339 strings
// rather than as `jiff::Timestamp` directly: jiff has no `utoipa::ToSchema`
// impl, and every other DTO in this crate carries one (docs/11 §3, the
// contract this module was built against). Parsing happens once, at the edge
// (`parse_period`), which is also where a caller's malformed timestamp
// becomes a `validation-failed` rather than a `500` from deep inside a query.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct PeriodInput {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Period {
    pub start: String,
    pub end: String,
}

pub(crate) fn render_period(start: jiff::Timestamp, end: jiff::Timestamp) -> Period {
    Period {
        start: start.to_string(),
        end: end.to_string(),
    }
}

/// Parses both ends of a period and checks it is non-empty. `events_period_valid`
/// / `festivals_period_valid` also enforce non-emptiness in the database, but
/// refusing here produces a `validation-failed` naming the field instead of a
/// `23514` translated through [`map_write_error`], which cannot know which of
/// the two timestamps the caller got wrong.
pub(crate) fn parse_period(
    input: &PeriodInput,
) -> Result<(jiff::Timestamp, jiff::Timestamp), ApiError> {
    parse_named_period("period", input)
}

/// [`parse_period`] for a body that carries more than one of them, so the
/// refusal says which. An event patch can move the operational window and the
/// door times in the same request, and "period.end must be after period.start"
/// pointed at the wrong pair half the time.
pub(crate) fn parse_named_period(
    field: &str,
    input: &PeriodInput,
) -> Result<(jiff::Timestamp, jiff::Timestamp), ApiError> {
    let start: jiff::Timestamp = input
        .start
        .parse()
        .map_err(|_| ApiError::ValidationFailed(format!("{field}.start is not RFC 3339.")))?;
    let end: jiff::Timestamp = input
        .end
        .parse()
        .map_err(|_| ApiError::ValidationFailed(format!("{field}.end is not RFC 3339.")))?;
    if end <= start {
        return Err(ApiError::ValidationFailed(format!(
            "{field}.end must be after {field}.start."
        )));
    }
    Ok((start, end))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FestivalResponse {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub timezone: String,
    pub period: Period,
    pub status: String,
    pub event_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub version: i32,
    /// Only populated on `GET …/festivals/{festival}`, per the API contract.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<EventResponse>>,
}

fn render_festival(festival: evp_db::catalog::Festival) -> FestivalResponse {
    FestivalResponse {
        id: festival.id.to_string(),
        name: festival.name,
        slug: festival.slug,
        timezone: festival.timezone,
        period: render_period(festival.period_start, festival.period_end),
        status: festival.status,
        event_count: festival.event_count,
        created_at: festival.created_at.to_string(),
        updated_at: festival.updated_at.to_string(),
        version: festival.version,
        events: None,
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EventResponse {
    pub id: String,
    pub festival_id: Option<String>,
    pub name: String,
    pub slug: String,
    pub timezone: String,
    /// The **operational** window: everything this edition covers, including
    /// the hours volunteers work before the doors open and after they close.
    /// Every shift lives inside it — that is one of the six hard rules
    /// (docs/02 §5) — which is why it is the one that grows.
    pub period: Period,
    /// When the doors are open to the public, if anyone has said. Absent
    /// otherwise — never inferred from `period`, which is a different fact
    /// about the day and not a stand-in for this one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_period: Option<Period>,
    pub status: String,
    /// Index into the 64-colour event palette
    /// (`packages/shared/src/eventColors.ts`). The server stores the index and
    /// never the colour: the palette is what guarantees the value clears 4.5:1
    /// against black and white, and a hex on the wire would be a hex nobody
    /// proved.
    pub color: i16,
    pub availability_step_minutes: i32,
    pub created_at: String,
    pub updated_at: String,
    pub version: i32,
}

fn render_event(event: evp_db::catalog::Event) -> EventResponse {
    EventResponse {
        id: event.id.to_string(),
        festival_id: event.festival_id.map(|id| id.to_string()),
        name: event.name,
        slug: event.slug,
        timezone: event.timezone,
        period: render_period(event.period_start, event.period_end),
        public_period: event
            .public_period_start
            .zip(event.public_period_end)
            .map(|(start, end)| render_period(start, end)),
        status: event.status,
        color: event.color,
        availability_step_minutes: event.availability_step_minutes,
        created_at: event.created_at.to_string(),
        updated_at: event.updated_at.to_string(),
        version: event.version,
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DataPage<T> {
    pub data: Vec<T>,
    pub next: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateFestivalRequest {
    pub name: String,
    pub slug: String,
    pub timezone: String,
    pub period: PeriodInput,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateEventRequest {
    pub name: String,
    pub slug: String,
    pub timezone: String,
    pub period: PeriodInput,
    #[serde(default)]
    pub festival_id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FestivalCreated {
    pub festival: FestivalResponse,
    pub operation_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EventCreated {
    pub event: EventResponse,
    pub operation_id: String,
}

#[derive(Debug, Deserialize)]
pub struct StatusFilter {
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EventFilter {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub festival: Option<String>,
}

/// Translates a write failure that reached the database into the `type` a
/// caller can branch on, using the SQLSTATE and constraint name PostgreSQL
/// attached to it. Anything not recognised here stays [`ApiError::Internal`]
/// — a constraint this function does not know about must not be reported to
/// the caller as if it were their mistake.
fn map_write_error(error: evp_db::DbError) -> ApiError {
    match error.sqlstate().as_deref() {
        // unique_violation: (org_id, slug) already taken.
        Some("23505") => ApiError::Conflict(
            "An event or festival with this slug already exists in this organisation.".to_owned(),
        ),
        // foreign_key_violation: an unknown timezone, or a festival_id that
        // does not exist in this organisation.
        Some("23503") => {
            let what = error.constraint().unwrap_or_default();
            if what.contains("timezone") {
                ApiError::ValidationFailed(
                    "timezone is not a known IANA time zone name.".to_owned(),
                )
            } else {
                ApiError::ValidationFailed(
                    "festival_id does not name a festival in this organisation.".to_owned(),
                )
            }
        }
        // check_violation: an empty or inverted period slipped past parse_period
        // (it cannot, but the database is the actual authority — ADR-0007's
        // sibling principle applies to hard rules too).
        Some("23514") => {
            ApiError::ValidationFailed("The submitted period is not valid.".to_owned())
        }
        _ => ApiError::Internal(error),
    }
}

fn parse_uuid(field: &str, value: &str) -> Result<Uuid, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::ValidationFailed(format!("{field} is not a UUID.")))
}

// ---------------------------------------------------------------------------
// Festivals
// ---------------------------------------------------------------------------

async fn list_festivals(
    ZoneLead(mut org): ZoneLead,
    axum::extract::Query(filter): axum::extract::Query<StatusFilter>,
) -> Result<axum::Json<DataPage<FestivalResponse>>, ApiError> {
    let festivals =
        evp_db::catalog::list_festivals(&mut org.tx, org.org_id, filter.status.as_deref())
            .await
            .map_err(ApiError::from)?;
    org.commit().await?;

    Ok(axum::Json(DataPage {
        data: festivals.into_iter().map(render_festival).collect(),
        next: None,
    }))
}

async fn create_festival(
    Coordinator(mut org): Coordinator,
    JsonBody(request): JsonBody<CreateFestivalRequest>,
) -> Result<(StatusCode, axum::Json<FestivalCreated>), ApiError> {
    let period = parse_period(&request.period)?;
    let id = Uuid::now_v7();

    let (festival, operation_id) = evp_db::catalog::create_festival(
        &mut org.tx,
        id,
        org.org_id,
        org.user_id,
        &request.name,
        &request.slug,
        &request.timezone,
        period,
    )
    .await
    .map_err(map_write_error)?;
    org.commit().await?;

    Ok((
        StatusCode::CREATED,
        axum::Json(FestivalCreated {
            festival: render_festival(festival),
            operation_id: operation_id.0.to_string(),
        }),
    ))
}

#[derive(Debug, Deserialize)]
struct FestivalPath {
    festival: String,
}

async fn get_festival(
    ZoneLead(mut org): ZoneLead,
    Path(path): Path<FestivalPath>,
) -> Result<Response, ApiError> {
    let festival_id = parse_uuid("festival", &path.festival)?;

    let festival = evp_db::catalog::get_festival(&mut org.tx, org.org_id, festival_id)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)?;

    let events = evp_db::catalog::list_events_for_festival(&mut org.tx, org.org_id, festival_id)
        .await
        .map_err(ApiError::from)?;
    org.commit().await?;

    let version = festival.version;
    let mut response = render_festival(festival);
    response.events = Some(events.into_iter().map(render_event).collect());
    Ok(tagged(version, response))
}

/// `POST /api/v1/orgs/{org}/festivals/example`.
///
/// `409` when the org already has any festival, so the button that offers
/// this is safe to click twice: the second click cannot silently duplicate
/// the whole worked example under a coordinator's nose.
async fn create_festival_example(
    Coordinator(mut org): Coordinator,
) -> Result<(StatusCode, axum::Json<FestivalCreated>), ApiError> {
    if evp_db::catalog::org_has_any_festival(&mut org.tx, org.org_id)
        .await
        .map_err(ApiError::from)?
    {
        return Err(ApiError::Conflict(
            "This organisation already has a festival; the example loads only into an empty org."
                .to_owned(),
        ));
    }

    let fixture = evp_domain::example::build()
        .map_err(evp_db::DbError::Fixture)
        .map_err(ApiError::from)?;

    let (festival, operation_id) =
        evp_db::catalog::create_example(&mut org.tx, org.org_id, org.user_id, &fixture)
            .await
            .map_err(map_write_error)?;
    org.commit().await?;

    Ok((
        StatusCode::CREATED,
        axum::Json(FestivalCreated {
            festival: render_festival(festival),
            operation_id: operation_id.0.to_string(),
        }),
    ))
}

/// A body plus the `ETag` a client sends back as `If-Match` (docs/04 §1).
///
/// One helper rather than a header pair written out at each site: an endpoint
/// that answers `428` to a missing `If-Match` and then forgets to *supply* the
/// tag is unusable, and that pairing is easier to get right in one place than
/// to remember at six.
fn tagged<T: Serialize>(version: i32, body: T) -> Response {
    ([(header::ETAG, etag(version))], axum::Json(body)).into_response()
}

/// Reads a nullable `PATCH` field into [`evp_db::catalog::Patch`].
///
/// `#[serde(default)]` alone cannot do this: an absent key and an explicit
/// `null` both deserialise to `None`, so the two collapse and
/// `{"festival_id": null}` becomes indistinguishable from not mentioning the
/// festival. Paired with `#[serde(default)]` on the field — which supplies
/// `Patch::Unchanged` when the key is absent — this function sees only the
/// keys that *were* sent, and so can tell `null` apart from a value.
pub(crate) fn sent_field<'de, T, D>(deserializer: D) -> Result<evp_db::catalog::Patch<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer)
        .map(|value| value.map_or(evp_db::catalog::Patch::Clear, evp_db::catalog::Patch::Set))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchEventRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub period: Option<PeriodInput>,
    /// The door times. `null` says there are none published; omitted leaves
    /// them alone. Never derived from `period` — see `EventResponse`.
    #[serde(default, deserialize_with = "sent_field")]
    #[schema(value_type = Option<PeriodInput>)]
    pub public_period: evp_db::catalog::Patch<PeriodInput>,
    /// `null` detaches the event from its festival; omitted leaves it alone.
    #[serde(default, deserialize_with = "sent_field")]
    #[schema(value_type = Option<String>)]
    pub festival_id: evp_db::catalog::Patch<String>,
    /// `null` removes the event-level default; omitted leaves it alone.
    #[serde(default, deserialize_with = "sent_field")]
    #[schema(value_type = Option<String>)]
    pub default_shift_pattern_id: evp_db::catalog::Patch<String>,
    #[serde(default)]
    pub availability_step_minutes: Option<i32>,
    /// Palette index, 0–63.
    #[serde(default)]
    pub color: Option<i16>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EventUpdated {
    pub event: EventResponse,
    pub operation_id: String,
}

/// How many colours `events_color_in_palette` admits. Duplicated from the
/// migration rather than read from it, and checked here rather than only left
/// to the `CHECK`, so an out-of-range index is a `422` naming the field
/// instead of a `23514` naming a constraint.
const PALETTE_SIZE: i16 = 64;

/// [`parse_named_period`] through a tri-state patch: `Unchanged` and `Clear`
/// pass straight through, and only a sent value is parsed.
fn parse_patch_period(
    field: &str,
    value: evp_db::catalog::Patch<PeriodInput>,
) -> Result<evp_db::catalog::Patch<(jiff::Timestamp, jiff::Timestamp)>, ApiError> {
    use evp_db::catalog::Patch;
    Ok(match value {
        Patch::Unchanged => Patch::Unchanged,
        Patch::Clear => Patch::Clear,
        Patch::Set(input) => Patch::Set(parse_named_period(field, &input)?),
    })
}

pub(crate) fn parse_patch_uuid(
    field: &str,
    value: evp_db::catalog::Patch<String>,
) -> Result<evp_db::catalog::Patch<Uuid>, ApiError> {
    use evp_db::catalog::Patch;
    Ok(match value {
        Patch::Unchanged => Patch::Unchanged,
        Patch::Clear => Patch::Clear,
        Patch::Set(text) => Patch::Set(parse_uuid(field, &text)?),
    })
}

/// `PATCH /api/v1/orgs/{org}/events/{event}`.
///
/// Takes [`Precondition`], so a caller who omits `If-Match` is refused `428`
/// by the extractor before this body runs at all — the same mechanism that
/// puts the role check in the signature rather than inside the handler.
async fn patch_event(
    Coordinator(mut org): Coordinator,
    Path(path): Path<EventPath>,
    precondition: Precondition,
    JsonBody(request): JsonBody<PatchEventRequest>,
) -> Result<Response, ApiError> {
    let event_id = parse_uuid("event", &path.event)?;
    let period = request.period.as_ref().map(parse_period).transpose()?;
    let public_period = parse_patch_period("public_period", request.public_period)?;
    if let Some(color) = request.color
        && !(0..PALETTE_SIZE).contains(&color)
    {
        return Err(ApiError::ValidationFields {
            detail: format!(
                "color must be a palette index between 0 and {}.",
                PALETTE_SIZE - 1
            ),
            errors: std::collections::BTreeMap::from([(
                "color".to_owned(),
                vec![format!("must be between 0 and {}", PALETTE_SIZE - 1)],
            )]),
        });
    }
    if let Some(step) = request.availability_step_minutes
        && !matches!(step, 15 | 30 | 60)
    {
        return Err(ApiError::ValidationFields {
            detail: "availability_step_minutes must be 15, 30 or 60.".to_owned(),
            errors: std::collections::BTreeMap::from([(
                "availability_step_minutes".to_owned(),
                vec!["must be one of 15, 30, 60".to_owned()],
            )]),
        });
    }

    let festival_id = parse_patch_uuid("festival_id", request.festival_id)?;
    let default_shift_pattern_id =
        parse_patch_uuid("default_shift_pattern_id", request.default_shift_pattern_id)?;

    let changes = evp_db::catalog::EventPatch {
        name: request.name,
        slug: request.slug,
        timezone: request.timezone,
        period,
        public_period,
        festival_id,
        default_shift_pattern_id,
        availability_step_minutes: request.availability_step_minutes,
        color: request.color,
    };
    // An empty PATCH would otherwise succeed, bump the version and write an
    // operation describing nothing — an undo stack entry a coordinator cannot
    // account for.
    if changes.is_empty() {
        return Err(ApiError::Invalid(
            "The request body changes nothing; send at least one field.".to_owned(),
        ));
    }

    // The pattern/step rule (docs/04 §"Shift patterns"). Checked before the
    // update rather than after, so a refusal leaves nothing to undo, and
    // against the step *this request* asks for — a caller raising the step and
    // attaching the pattern in one PATCH is doing exactly what the refusal
    // message tells them to do, and must not be refused for it.
    if let evp_db::catalog::Patch::Set(pattern_id) = default_shift_pattern_id {
        let step = match changes.availability_step_minutes {
            Some(step) => step,
            None => {
                evp_db::catalog::get_event(&mut org.tx, org.org_id, event_id)
                    .await
                    .map_err(ApiError::from)?
                    .ok_or(ApiError::NotFound)?
                    .availability_step_minutes
            }
        };
        let pattern = evp_db::patterns::get(&mut org.tx, org.org_id, pattern_id)
            .await
            .map_err(ApiError::from)?
            .ok_or_else(|| {
                ApiError::ValidationFailed(
                    "default_shift_pattern_id does not name a shift pattern in this \
                     organisation."
                        .to_owned(),
                )
            })?;
        check_step_divides(step, &pattern, "default_shift_pattern_id")?;
    }

    let outcome = evp_db::catalog::update_event(
        &mut org.tx,
        org.org_id,
        org.user_id,
        event_id,
        precondition_version(&precondition),
        &changes,
    )
    .await
    .map_err(map_write_error)?;

    let (event, operation_id) = applied(outcome, &precondition)?;
    org.commit().await?;

    Ok(tagged(
        event.version,
        EventUpdated {
            event: render_event(event),
            operation_id: operation_id.0.to_string(),
        },
    ))
}

/// Refuses a pattern finer than the availability picker can express
/// (docs/04 §"Shift patterns").
///
/// A 45-minute segment under a 30-minute step means a volunteer can never
/// declare availability that lines up with the shift the generator would
/// produce, so every such shift arrives already unfillable. The message names
/// the step that *would* work, because "set it to 15 first" is the whole
/// remedy and a refusal without it sends the coordinator guessing.
///
/// `field` is a parameter because the same rule guards two attachment points —
/// `events.default_shift_pattern_id` and `locations.shift_pattern_id` — and
/// the `errors` map has to name whichever one the caller sent.
pub(crate) fn check_step_divides(
    step: i32,
    pattern: &evp_db::patterns::ShiftPattern,
    field: &str,
) -> Result<(), ApiError> {
    let durations = pattern.durations();
    let offending: Vec<i32> = durations
        .iter()
        .copied()
        .filter(|duration| step <= 0 || duration.checked_rem(step) != Some(0))
        .collect();
    if offending.is_empty() {
        return Ok(());
    }

    // The largest step that divides every segment: any smaller divisor of it
    // would work too, and naming the largest is the least disruptive change to
    // the picker a coordinator can make.
    let workable = durations.iter().copied().try_fold(0_i32, gcd).unwrap_or(1);
    let offending = offending
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");

    Err(ApiError::ValidationFields {
        detail: format!(
            "Segments of {offending} min are not a multiple of the event's {step}-minute \
             availability step. Set the step to {workable} minutes first."
        ),
        errors: std::collections::BTreeMap::from([(
            field.to_owned(),
            vec![format!("requires availability_step_minutes ≤ {workable}")],
        )]),
    })
}

/// Greatest common divisor. `None` on an input this cannot answer for, which
/// `validate` in [`crate::patterns`] has already excluded — a zero-length
/// segment never reaches here.
fn gcd(a: i32, b: i32) -> Option<i32> {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        let remainder = a.checked_rem(b)?;
        a = b;
        b = remainder;
    }
    (a > 0).then_some(a)
}

/// `POST /api/v1/orgs/{org}/events/{event}/archive`.
///
/// No `If-Match`: this is a state transition, not an edit of a field two
/// coordinators might be racing on, and it is idempotent — archiving an
/// archived event answers `200` and changes nothing.
async fn archive_event(
    Coordinator(mut org): Coordinator,
    Path(path): Path<EventPath>,
) -> Result<Response, ApiError> {
    let event_id = parse_uuid("event", &path.event)?;

    let (event, operation_id) =
        evp_db::catalog::archive_event(&mut org.tx, org.org_id, org.user_id, event_id)
            .await
            .map_err(map_write_error)?
            .ok_or(ApiError::NotFound)?;
    org.commit().await?;

    Ok(tagged(
        event.version,
        EventUpdated {
            event: render_event(event),
            operation_id: operation_id.0.to_string(),
        },
    ))
}

/// `DELETE /api/v1/orgs/{org}/events/{event}` — owner only (docs/04 §4).
///
/// The `409`-once-published refusal docs/04 also specifies is **not** here:
/// `roster_versions` does not exist until M4, so there is nothing to consult.
/// It belongs in this handler the day that table lands, and is noted rather
/// than approximated — a check against a table that does not exist would be a
/// check that always passes.
async fn delete_event(
    Owner(mut org): Owner,
    Path(path): Path<EventPath>,
    precondition: Precondition,
) -> Result<StatusCode, ApiError> {
    let event_id = parse_uuid("event", &path.event)?;

    let outcome = evp_db::catalog::delete_event(
        &mut org.tx,
        org.org_id,
        event_id,
        precondition_version(&precondition),
    )
    .await
    .map_err(map_write_error)?;

    applied(outcome, &precondition)?;
    org.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The version a `WHERE version = $n` predicate should carry: `None` for
/// `If-Match: *`, and for a multi-tag list, which no single predicate can
/// express — those are settled by [`applied`] against the row that came back.
pub(crate) fn precondition_version(precondition: &Precondition) -> Option<i32> {
    match precondition.0.as_slice() {
        [single] => single.version(),
        _ => None,
    }
}

/// Turns a [`evp_db::catalog::Versioned`] into the three answers docs/04 §2
/// distinguishes: the value, `404`, or `409`.
pub(crate) fn applied<T>(
    outcome: evp_db::catalog::Versioned<T>,
    precondition: &Precondition,
) -> Result<T, ApiError> {
    match outcome {
        evp_db::catalog::Versioned::Applied(value) => Ok(value),
        evp_db::catalog::Versioned::Missing => Err(ApiError::NotFound),
        evp_db::catalog::Versioned::Stale { current } => {
            // `check` is what renders the message, so a multi-tag `If-Match`
            // whose members all miss is described the same way a single one is.
            precondition.check(current)?;
            // The tag did match the version we read, and the write still did
            // not apply: another transaction committed between the two
            // statements. Same answer, same remedy.
            Err(ApiError::Conflict(
                "This resource changed while the request was being processed. \
                 Re-read it and reapply your change."
                    .to_owned(),
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async fn list_events(
    ZoneLead(mut org): ZoneLead,
    axum::extract::Query(filter): axum::extract::Query<EventFilter>,
) -> Result<axum::Json<DataPage<EventResponse>>, ApiError> {
    let festival_id = filter
        .festival
        .as_deref()
        .map(|value| parse_uuid("festival", value))
        .transpose()?;

    let events = evp_db::catalog::list_events(
        &mut org.tx,
        org.org_id,
        filter.status.as_deref(),
        festival_id,
    )
    .await
    .map_err(ApiError::from)?;
    org.commit().await?;

    Ok(axum::Json(DataPage {
        data: events.into_iter().map(render_event).collect(),
        next: None,
    }))
}

async fn create_event(
    Coordinator(mut org): Coordinator,
    JsonBody(request): JsonBody<CreateEventRequest>,
) -> Result<(StatusCode, axum::Json<EventCreated>), ApiError> {
    let period = parse_period(&request.period)?;
    let festival_id = request
        .festival_id
        .as_deref()
        .map(|value| parse_uuid("festival_id", value))
        .transpose()?;
    let id = Uuid::now_v7();

    let (event, operation_id) = evp_db::catalog::create_event(
        &mut org.tx,
        id,
        org.org_id,
        org.user_id,
        festival_id,
        &request.name,
        &request.slug,
        &request.timezone,
        period,
    )
    .await
    .map_err(map_write_error)?;
    org.commit().await?;

    Ok((
        StatusCode::CREATED,
        axum::Json(EventCreated {
            event: render_event(event),
            operation_id: operation_id.0.to_string(),
        }),
    ))
}

#[derive(Debug, Deserialize)]
struct EventPath {
    event: String,
}

async fn get_event(
    ZoneLead(mut org): ZoneLead,
    Path(path): Path<EventPath>,
) -> Result<Response, ApiError> {
    let event_id = parse_uuid("event", &path.event)?;

    let event = evp_db::catalog::get_event(&mut org.tx, org.org_id, event_id)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)?;
    org.commit().await?;

    Ok(tagged(event.version, render_event(event)))
}

/// `POST /api/v1/orgs/{org}/events/example`.
///
/// Loads the same fixture as [`create_festival_example`] — the example is a
/// festival, so there is exactly one worked example regardless of which of
/// the two routes a caller used to ask for it. `409` when the org already has
/// *any* event (not just a standalone one): loading it again would create a
/// second "Soundclash 26" alongside events that already reference the first.
async fn create_event_example(
    Coordinator(mut org): Coordinator,
) -> Result<(StatusCode, axum::Json<EventCreated>), ApiError> {
    if evp_db::catalog::org_has_any_event(&mut org.tx, org.org_id)
        .await
        .map_err(ApiError::from)?
    {
        return Err(ApiError::Conflict(
            "This organisation already has an event; the example loads only into an empty org."
                .to_owned(),
        ));
    }

    let fixture = evp_domain::example::build()
        .map_err(evp_db::DbError::Fixture)
        .map_err(ApiError::from)?;

    let (festival, operation_id) =
        evp_db::catalog::create_example(&mut org.tx, org.org_id, org.user_id, &fixture)
            .await
            .map_err(map_write_error)?;

    let events = evp_db::catalog::list_events_for_festival(&mut org.tx, org.org_id, festival.id)
        .await
        .map_err(ApiError::from)?;
    // The fixture always has at least one event (`build` never returns an
    // empty `events` vec); a `NotFound` here would mean `create_example`
    // committed a festival with none, which is a bug in this module, not a
    // caller mistake — so it is reported the same way any other internal
    // inconsistency is, rather than folded into the 404 a caller would read
    // as "no such festival".
    let first_event = events.into_iter().next().ok_or(ApiError::ValidationFailed(
        "the example fixture produced no events".to_owned(),
    ))?;
    org.commit().await?;

    Ok((
        StatusCode::CREATED,
        axum::Json(EventCreated {
            event: render_event(first_event),
            operation_id: operation_id.0.to_string(),
        }),
    ))
}
