// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The "Soundclash 26" worked example: a festival's structure, and the mock
//! volunteers who applied to it.
//!
//! All of it lives in `example.json` beside this file, dumped from a live
//! organisation by `just dump-example <org-slug>` (see
//! `docker/db/dump-example.sql`): one festival, its events, their missions
//! (locations) and shifts, and the org's volunteers with what they answered,
//! the availability they declared and the shifts they were assigned. A
//! coordinator shapes the example in the app the way they would a real
//! festival, and the dump makes that what "Load the example" recreates, with
//! no hand transcription in between.
//!
//! The file is embedded with `include_str!`, so building it is still pure: no
//! I/O at runtime, and a malformed dump — an index pointing nowhere, an event
//! slug no event has — fails [`build`] (and this module's tests) rather than a
//! request halfway through its inserts.
//!
//! Instants in the file carry their offset (`2026-09-05T22:00:00+02:00`), so
//! each is one absolute instant — a `22:00–01:00` shift is a real range that
//! crosses midnight, not a same-day pair with the date dropped
//! ([ADR-0019](../../../docs/adr/0019-time-discipline.md)).
//!
//! The volunteers are committed, so the org they are dumped from must hold
//! mock people only: CLAUDE.md forbids committing real volunteer data.
//!
//! Pure data assembly: this module does no I/O and reaches no database.
//! `evp-db` is what turns a [`FestivalFixture`] into rows.

use std::collections::HashSet;

use jiff::Timestamp;
use rust_decimal::Decimal;
use serde::Deserialize;

/// The dump. Replaced wholesale by `just dump-example`; edit it by hand only
/// for a quick experiment, since the next dump overwrites it.
const DUMP: &str = include_str!("example.json");

/// Everything [`build`] produces, ready for `evp-db` to persist verbatim.
#[derive(Debug, Clone)]
pub struct FestivalFixture {
    pub name: String,
    pub slug: String,
    pub timezone: String,
    pub period: (Timestamp, Timestamp),
    pub events: Vec<EventFixture>,
    pub volunteers: Vec<VolunteerFixture>,
}

/// One event, as dumped. The scheduling rules are carried verbatim even when
/// they equal the column defaults, so a re-dump after a coordinator changed
/// one is a visible diff rather than a silent reset.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventFixture {
    pub name: String,
    pub slug: String,
    pub period: (Timestamp, Timestamp),
    #[serde(default)]
    pub public_period: Option<(Timestamp, Timestamp)>,
    /// Palette index. Kept rather than re-derived on load, so the example's
    /// days come back in the colours they were dumped with.
    pub color: i16,
    pub max_hours_per_day: Decimal,
    pub min_rest_minutes: i32,
    pub max_consecutive_days: i32,
    /// `HH:MM:SS`, Postgres's own `time` text form.
    pub night_starts_at: String,
    pub night_ends_at: String,
    pub availability_step_minutes: i32,
    /// Every mission of this event. Zones come before their posts, so a
    /// post's [`LocationFixture::parent`] always names an earlier index.
    pub locations: Vec<LocationFixture>,
    pub shifts: Vec<ShiftFixture>,
}

/// One mission: a zone, or a post inside one (docs/03 §3.4).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocationFixture {
    pub name: String,
    /// Index into the owning [`EventFixture::locations`]: `None` for a zone,
    /// the parent zone for a post.
    #[serde(default)]
    pub parent: Option<usize>,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub colour: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub exact_address: Option<String>,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    #[serde(default)]
    pub min_volunteers: Option<i16>,
    #[serde(default)]
    pub max_volunteers: Option<i16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShiftFixture {
    /// Index into the owning [`EventFixture::locations`].
    pub location: usize,
    pub period: (Timestamp, Timestamp),
    #[serde(default)]
    pub title: Option<String>,
    pub required_count: i16,
    #[serde(default)]
    pub max_count: Option<i16>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// One volunteer of the pool, with the one submission that produced them.
///
/// `first_name`/`last_name` are carried as dumped: `None` for a volunteer
/// who came off a single-name-field form, never split out of
/// `display_name` (ADR-0012).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VolunteerFixture {
    pub display_name: String,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub tshirt_size: Option<String>,
    #[serde(default)]
    pub dietary: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub is_core_team: bool,
    /// When the form was answered, if the source said.
    #[serde(default)]
    pub submitted_at: Option<Timestamp>,
    /// Verbatim, in the order the form asked them. Becomes
    /// `submission_payloads.raw` and, from there, the API's `answers[]`
    /// (docs/03 §3.10: raw is "exactly what arrived").
    #[serde(default)]
    pub answers: Vec<Answer>,
    /// One entry per event this volunteer said anything about. Empty for a
    /// volunteer who answered the form but ticked no availability at all —
    /// a real and different case from declaring "not available" (09 §3).
    #[serde(default)]
    pub participations: Vec<ParticipationFixture>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub question: String,
    pub value: serde_json::Value,
}

/// One volunteer's standing in one event.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParticipationFixture {
    /// Matches one of the parent [`FestivalFixture::events`] by
    /// [`EventFixture::slug`].
    #[serde(rename = "event")]
    pub event_slug: String,
    #[serde(default)]
    pub status: ParticipationStatus,
    /// Possibly several disjoint ranges, never merged across a gap the
    /// volunteer did not fill in themselves.
    #[serde(default)]
    pub windows: Vec<WindowFixture>,
    #[serde(default)]
    pub assignments: Vec<AssignmentFixture>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticipationStatus {
    #[default]
    Invited,
    Confirmed,
    Declined,
    Withdrawn,
}

impl ParticipationStatus {
    /// The `participation_status` enum label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Invited => "invited",
            Self::Confirmed => "confirmed",
            Self::Declined => "declined",
            Self::Withdrawn => "withdrawn",
        }
    }
}

/// One declared range (09 §3): exact bounds, no slot options.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowFixture {
    pub kind: AvailabilityKind,
    pub period: (Timestamp, Timestamp),
    #[serde(default)]
    pub note: Option<String>,
    /// Typed in by a coordinator rather than read off the submission. The
    /// schema lets the two provenances overlap each other but not
    /// themselves, so which one a window had must survive the round trip.
    #[serde(default)]
    pub declared: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AvailabilityKind {
    Available,
    Unavailable,
}

impl AvailabilityKind {
    /// The `availability_kind` enum label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
        }
    }
}

/// A live assignment. Cancelled ones are not dumped: they are history, not
/// part of the plan a fresh example should show.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssignmentFixture {
    /// Index into the [`EventFixture::shifts`] of the participation's event.
    pub shift: usize,
    #[serde(default)]
    pub status: AssignmentStatus,
    #[serde(default)]
    pub acknowledged_warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentStatus {
    #[default]
    Draft,
    Published,
}

impl AssignmentStatus {
    /// The `assignment_status` enum label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Published => "published",
        }
    }
}

/// A bad `example.json`, which this module's tests catch before it ships.
#[derive(Debug, thiserror::Error)]
pub enum ExampleError {
    #[error("example.json does not parse")]
    InvalidDump(#[source] serde_json::Error),
    /// An index or slug that names nothing, a post whose parent is not an
    /// earlier zone, or two participations of one volunteer in one event.
    #[error("example.json: {0}")]
    DanglingReference(String),
}

/// The top level of `example.json`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Dump {
    festival: FestivalHeader,
    events: Vec<EventFixture>,
    #[serde(default)]
    volunteers: Vec<VolunteerFixture>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FestivalHeader {
    name: String,
    slug: String,
    timezone: String,
    period: (Timestamp, Timestamp),
}

/// Build the Soundclash 26 fixture.
///
/// # Errors
///
/// [`ExampleError`] if `example.json` does not parse, or references
/// something that is not there.
pub fn build() -> Result<FestivalFixture, ExampleError> {
    let dump: Dump = serde_json::from_str(DUMP).map_err(ExampleError::InvalidDump)?;
    for event in &dump.events {
        check_event(event)?;
    }
    for volunteer in &dump.volunteers {
        check_volunteer(volunteer, &dump.events)?;
    }

    Ok(FestivalFixture {
        name: dump.festival.name,
        slug: dump.festival.slug,
        timezone: dump.festival.timezone,
        period: dump.festival.period,
        events: dump.events,
        volunteers: dump.volunteers,
    })
}

/// Every index in `event` resolves, and every post hangs off an earlier
/// zone — the order `evp-db` inserts them in, so a parent id always exists
/// by the time its post is written.
fn check_event(event: &EventFixture) -> Result<(), ExampleError> {
    for (index, location) in event.locations.iter().enumerate() {
        if let Some(parent) = location.parent {
            let parent_is_an_earlier_zone = parent < index
                && event
                    .locations
                    .get(parent)
                    .is_some_and(|zone| zone.parent.is_none());
            if !parent_is_an_earlier_zone {
                return Err(ExampleError::DanglingReference(format!(
                    "post {:?} of {} has parent {parent}, which is not an earlier zone",
                    location.name, event.slug
                )));
            }
        }
    }
    for shift in &event.shifts {
        if shift.location >= event.locations.len() {
            return Err(ExampleError::DanglingReference(format!(
                "a shift of {} names location {}, but it has {}",
                event.slug,
                shift.location,
                event.locations.len()
            )));
        }
    }
    Ok(())
}

/// Every participation names an event of this festival, at most once, and
/// every assignment a shift of that event.
fn check_volunteer(
    volunteer: &VolunteerFixture,
    events: &[EventFixture],
) -> Result<(), ExampleError> {
    let mut seen = HashSet::with_capacity(volunteer.participations.len());
    for participation in &volunteer.participations {
        let Some(event) = events
            .iter()
            .find(|event| event.slug == participation.event_slug)
        else {
            return Err(ExampleError::DanglingReference(format!(
                "{} participates in {:?}, which is not an event of the festival",
                volunteer.display_name, participation.event_slug
            )));
        };
        if !seen.insert(participation.event_slug.as_str()) {
            return Err(ExampleError::DanglingReference(format!(
                "{} participates in {} twice",
                volunteer.display_name, participation.event_slug
            )));
        }
        for assignment in &participation.assignments {
            if assignment.shift >= event.shifts.len() {
                return Err(ExampleError::DanglingReference(format!(
                    "{} is assigned shift {} of {}, which has {}",
                    volunteer.display_name,
                    assignment.shift,
                    event.slug,
                    event.shifts.len()
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        EventFixture, ExampleError, FestivalFixture, VolunteerFixture, build, check_event,
        check_volunteer,
    };

    fn festival() -> FestivalFixture {
        build().expect("example.json parses and every reference in it resolves")
    }

    fn tz() -> jiff::tz::TimeZone {
        jiff::tz::TimeZone::get(&festival().timezone)
            .expect("the festival's timezone is in this environment's tzdb")
    }

    #[test]
    fn the_dump_parses_into_a_festival_with_events_and_volunteers() {
        let festival = festival();
        assert!(!festival.name.is_empty());
        assert!(!festival.events.is_empty(), "example.json has no events");
        assert!(
            !festival.volunteers.is_empty(),
            "example.json has no volunteers"
        );

        let mut slugs: Vec<&str> = festival
            .events
            .iter()
            .map(|event| event.slug.as_str())
            .collect();
        slugs.sort_unstable();
        let before = slugs.len();
        slugs.dedup();
        assert_eq!(before, slugs.len(), "two events share a slug");
    }

    #[test]
    fn every_event_period_covers_every_shift_of_that_event() {
        // The database refuses this too (`shifts_within_event`), but only
        // once a coordinator clicks the button; failing here fails the build.
        for event in &festival().events {
            for shift in &event.shifts {
                assert!(
                    shift.period.0 >= event.period.0 && shift.period.1 <= event.period.1,
                    "a shift of {} falls outside its own event period",
                    event.name
                );
            }
        }
    }

    #[test]
    fn some_shift_crosses_midnight_in_the_festival_s_timezone() {
        // What makes the example exercise ADR-0019 end to end: a late shift
        // whose wall-clock date changes, even though — Paris being UTC+2 in
        // September — the *UTC* date may not. Asserting against the
        // festival's own timezone is the point. If a re-dump loses every
        // overnight shift, this is the test that says so.
        let tz = tz();
        let crosses = festival()
            .events
            .iter()
            .flat_map(|event| &event.shifts)
            .any(|shift| {
                shift.period.0.to_zoned(tz.clone()).date()
                    != shift.period.1.to_zoned(tz.clone()).date()
            });
        assert!(crosses, "no shift of the example crosses midnight");
    }

    #[test]
    fn some_availability_window_crosses_midnight_too() {
        // The same, one layer up: a volunteer's declared range is a real
        // instant pair, not a same-day pair with the date dropped.
        let tz = tz();
        let crosses = festival()
            .volunteers
            .iter()
            .flat_map(|volunteer| &volunteer.participations)
            .flat_map(|participation| &participation.windows)
            .any(|window| {
                window.period.0.to_zoned(tz.clone()).date()
                    != window.period.1.to_zoned(tz.clone()).date()
            });
        assert!(
            crosses,
            "no availability window of the example crosses midnight"
        );
    }

    #[test]
    fn slot_lengths_are_deliberately_uneven() {
        // "document uneven slot length": the source sheet never used one
        // uniform width, and code assuming it did must fail on the example.
        let mut lengths: Vec<i64> = festival()
            .events
            .iter()
            .flat_map(|event| &event.shifts)
            .map(|shift| shift.period.1.duration_since(shift.period.0).as_secs())
            .collect();
        lengths.sort_unstable();
        lengths.dedup();

        assert!(
            lengths.len() > 1,
            "every slot came out the same length: {lengths:?}"
        );
    }

    #[test]
    fn some_volunteers_answered_the_form_with_no_availability_at_all() {
        // A real case, distinct from declaring "not available" (09 §3), and
        // one the submissions UI must show rather than drop.
        let festival = festival();
        let silent = festival
            .volunteers
            .iter()
            .find(|volunteer| volunteer.participations.is_empty())
            .expect("some volunteer of the example ticked no availability");
        assert!(
            !silent.answers.is_empty(),
            "declaring no availability is different from not having answered at all"
        );
    }

    const NIGHT: &str = r#"{
        "name": "Night", "slug": "night",
        "period": ["2026-09-05T20:00:00+02:00", "2026-09-06T02:00:00+02:00"],
        "color": 0, "max_hours_per_day": "10.00", "min_rest_minutes": 480,
        "max_consecutive_days": 5, "night_starts_at": "22:00:00",
        "night_ends_at": "06:00:00", "availability_step_minutes": 30,
        "locations": LOCATIONS,
        "shifts": SHIFTS
    }"#;

    fn night(locations: &str, shifts: &str) -> EventFixture {
        serde_json::from_str(
            &NIGHT
                .replace("LOCATIONS", locations)
                .replace("SHIFTS", shifts),
        )
        .expect("the event itself is well-formed")
    }

    #[test]
    fn a_shift_naming_a_missing_location_is_refused() {
        let event = night(
            r#"[{ "name": "Bar" }]"#,
            r#"[{ "location": 1, "required_count": 1,
                  "period": ["2026-09-05T20:00:00+02:00", "2026-09-05T22:00:00+02:00"] }]"#,
        );
        assert!(matches!(
            check_event(&event),
            Err(ExampleError::DanglingReference(_))
        ));
    }

    #[test]
    fn a_post_must_hang_off_an_earlier_zone() {
        let event = night(
            r#"[{ "name": "Tireuse", "parent": 1 }, { "name": "Bar" }]"#,
            "[]",
        );
        assert!(matches!(
            check_event(&event),
            Err(ExampleError::DanglingReference(_))
        ));
    }

    #[test]
    fn a_volunteer_in_an_unknown_event_or_shift_is_refused() {
        let events = vec![night(
            r#"[{ "name": "Bar" }]"#,
            r#"[{ "location": 0, "required_count": 1,
                  "period": ["2026-09-05T20:00:00+02:00", "2026-09-05T22:00:00+02:00"] }]"#,
        )];
        for participations in [
            r#"[{ "event": "day" }]"#,
            r#"[{ "event": "night" }, { "event": "night" }]"#,
            r#"[{ "event": "night", "assignments": [{ "shift": 1 }] }]"#,
        ] {
            let volunteer: VolunteerFixture = serde_json::from_str(&format!(
                r#"{{ "display_name": "Jo", "participations": {participations} }}"#
            ))
            .expect("the volunteer itself is well-formed");
            assert!(
                matches!(
                    check_volunteer(&volunteer, &events),
                    Err(ExampleError::DanglingReference(_))
                ),
                "{participations} was accepted"
            );
        }
    }
}
