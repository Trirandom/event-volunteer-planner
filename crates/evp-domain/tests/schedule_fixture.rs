// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The server half of `fixtures/schedule_render.json`. The admin app's half is
//! `apps/admin/src/plan/emails.fixture.test.ts`; together they keep the sent
//! message and the previewed one the same.

use evp_domain::schedule::lines::ScheduleLine;
use evp_domain::schedule::locale::{Locale, Zones, format_line};
use evp_domain::schedule::render::{Values, escape_html, render, unknown_placeholders};
use evp_domain::schedule::text::html_to_text;
use jiff::tz::TimeZone;
use serde_json::Value;
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test helper: a malformed fixture should fail the test that reads it"
)]
fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/schedule_render.json")).expect("valid JSON")
}

#[expect(
    clippy::expect_used,
    reason = "test helper: a malformed fixture should fail the test that reads it"
)]
fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

#[expect(
    clippy::expect_used,
    reason = "test helper: a malformed fixture should fail the test that reads it"
)]
fn cases<'a>(fixture: &'a Value, name: &str) -> &'a Vec<Value> {
    fixture[name].as_array().expect("an array of cases")
}

#[test]
fn lines() {
    let fixture = fixture();
    for case in cases(&fixture, "lines") {
        let timezone = text(&case["timezone"]);
        let mut zones = Zones::new();
        zones.insert(timezone, TimeZone::get(timezone).expect("in the tzdb"));
        let line = ScheduleLine {
            event_id: Uuid::nil(),
            location_id: Uuid::nil(),
            mission: text(&case["mission"]).to_owned(),
            timezone: timezone.to_owned(),
            start: text(&case["start"]).parse().expect("instant"),
            end: text(&case["end"]).parse().expect("instant"),
        };
        let locale = Locale::parse(text(&case["locale"])).expect("fr or en");
        assert_eq!(
            format_line(&line, &zones, locale).expect("zone supplied"),
            text(&case["expected"]),
            "{case}"
        );
    }
}

#[test]
fn templates() {
    let fixture = fixture();
    let values = &fixture["values"];
    let values = Values {
        first_name: text(&values["firstName"]).to_owned(),
        display_name: text(&values["displayName"]).to_owned(),
        event_name: text(&values["eventName"]).to_owned(),
        festival_name: text(&values["festivalName"]).to_owned(),
        organization_name: text(&values["organizationName"]).to_owned(),
        assignations: text(&values["assignations"]).to_owned(),
        changes: String::new(),
    };
    for case in cases(&fixture, "render") {
        let template = text(&case["template"]);
        assert_eq!(render(template, &values), text(&case["expected"]), "{case}");
        let unknown: Vec<&str> = case["unknown"]
            .as_array()
            .expect("an array")
            .iter()
            .map(text)
            .collect();
        assert_eq!(unknown_placeholders(template), unknown, "{case}");
    }
}

#[test]
fn escaping() {
    let fixture = fixture();
    for case in cases(&fixture, "escape") {
        assert_eq!(escape_html(text(&case["text"])), text(&case["expected"]));
    }
}

#[test]
fn plain_text() {
    let fixture = fixture();
    for case in cases(&fixture, "htmlToText") {
        assert_eq!(
            html_to_text(text(&case["html"])),
            text(&case["expected"]),
            "{case}"
        );
    }
}
