// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Filling a coordinator's template for one volunteer — a port of
//! `renderTemplate` and its neighbours in `apps/admin/src/plan/emails.ts`, so
//! the message sent is the message previewed.
//!
//! Not minijinja, although it is in the tree: the templates already written
//! use `{{a|b}}` to mean "a, or b where a is empty", and in Jinja the same
//! text means "a passed through the filter b". Reading existing templates
//! with a different meaning is not a migration anyone would notice until the
//! wrong email went out.

use super::lines::{Diff, ScheduleLine};
use super::locale::{Locale, UnknownTimeZone, Zones, format_line, labelled, sentences};

/// Every placeholder a template may use. `assignations` and `changes` are
/// HTML built here; every other one is text, escaped on the way in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variable {
    FirstName,
    DisplayName,
    EventName,
    FestivalName,
    OrganizationName,
    Assignations,
    Changes,
}

impl Variable {
    pub const ALL: [Self; 7] = [
        Self::FirstName,
        Self::DisplayName,
        Self::EventName,
        Self::FestivalName,
        Self::OrganizationName,
        Self::Assignations,
        Self::Changes,
    ];

    /// As written between the braces.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::FirstName => "firstName",
            Self::DisplayName => "displayName",
            Self::EventName => "eventName",
            Self::FestivalName => "festivalName",
            Self::OrganizationName => "organizationName",
            Self::Assignations => "assignations",
            Self::Changes => "changes",
        }
    }

    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|variable| variable.name() == name)
    }
}

/// The values one recipient's message is filled with. Whoever builds it
/// decides whether they are HTML-safe — escaped for a body, raw for a
/// subject line, which is not HTML.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Values {
    pub first_name: String,
    pub display_name: String,
    pub event_name: String,
    pub festival_name: String,
    pub organization_name: String,
    pub assignations: String,
    pub changes: String,
}

impl Values {
    fn get(&self, variable: Variable) -> &str {
        match variable {
            Variable::FirstName => &self.first_name,
            Variable::DisplayName => &self.display_name,
            Variable::EventName => &self.event_name,
            Variable::FestivalName => &self.festival_name,
            Variable::OrganizationName => &self.organization_name,
            Variable::Assignations => &self.assignations,
            Variable::Changes => &self.changes,
        }
    }
}

/// Text made safe to place in HTML. Names are volunteer data typed into a
/// public form; "<b>Zoé</b>" must arrive as the characters typed.
#[must_use]
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// One `{{…}}` occurrence: its byte range in the template and what is
/// between the braces.
struct Placeholder<'t> {
    start: usize,
    end: usize,
    inner: &'t str,
}

/// The admin app's `/\{\{([^{}]*)\}\}/g`, scanned by hand: at each `{{`, the
/// longest run without a brace must be followed by `}}`, otherwise the scan
/// resumes one character later — so `{{{a}}}` holds the placeholder `{{a}}`
/// with a literal brace either side, as it does in the browser.
fn placeholders(template: &str) -> Vec<Placeholder<'_>> {
    let mut found = Vec::new();
    let mut from = 0_usize;
    while let Some(open) = template
        .get(from..)
        .and_then(|rest| rest.find("{{"))
        .map(|offset| from.saturating_add(offset))
    {
        let inner_start = open.saturating_add(2);
        let rest = template.get(inner_start..).unwrap_or_default();
        let closed = rest
            .find(['{', '}'])
            .filter(|&stop| rest.get(stop..).is_some_and(|tail| tail.starts_with("}}")));
        match closed {
            Some(stop) => {
                let end = inner_start.saturating_add(stop).saturating_add(2);
                found.push(Placeholder {
                    start: open,
                    end,
                    inner: rest.get(..stop).unwrap_or_default(),
                });
                from = end;
            }
            None => from = open.saturating_add(1),
        }
    }
    found
}

/// `{{a|b}}` is "a, or b where a is empty", which lets one template name the
/// day on a one-day run and the festival on a festival-wide one.
fn alternatives(inner: &str) -> impl Iterator<Item = &str> {
    inner.split('|').map(str::trim)
}

/// Placeholders the template names that nothing fills, in the order first
/// written, each once. Publishing refuses a template with any: `{{firstname}}`
/// sent to four hundred people as literal braces is the typo this catches.
#[must_use]
pub fn unknown_placeholders(template: &str) -> Vec<String> {
    let mut unknown: Vec<String> = Vec::new();
    for placeholder in placeholders(template) {
        for name in alternatives(placeholder.inner) {
            if Variable::parse(name).is_none() && !unknown.iter().any(|seen| seen == name) {
                unknown.push(name.to_owned());
            }
        }
    }
    unknown
}

/// One recipient's message. An unknown placeholder is left exactly as
/// written, so a preview shows the mistake where it is.
#[must_use]
pub fn render(template: &str, values: &Values) -> String {
    let mut out = String::with_capacity(template.len());
    let mut copied = 0_usize;
    for placeholder in placeholders(template) {
        out.push_str(template.get(copied..placeholder.start).unwrap_or_default());
        let variables: Option<Vec<Variable>> = alternatives(placeholder.inner)
            .map(Variable::parse)
            .collect();
        match variables {
            Some(variables) => out.push_str(
                variables
                    .into_iter()
                    .map(|variable| values.get(variable))
                    .find(|value| !value.is_empty())
                    .unwrap_or_default(),
            ),
            None => out.push_str(
                template
                    .get(placeholder.start..placeholder.end)
                    .unwrap_or_default(),
            ),
        }
        copied = placeholder.end;
    }
    out.push_str(template.get(copied..).unwrap_or_default());
    out
}

/// A schedule as HTML: one list item per line, or a sentence — never an
/// empty list, which reads as a rendering fault. `none` is the sentence for
/// an empty schedule, which differs between "never had any" and "had some,
/// now has none".
///
/// # Errors
///
/// [`UnknownTimeZone`] when a line's zone was not supplied.
pub fn assignations_html(
    lines: &[ScheduleLine],
    zones: &Zones,
    locale: Locale,
    none: &str,
) -> Result<String, UnknownTimeZone> {
    if lines.is_empty() {
        return Ok(format!("<p>{}</p>", escape_html(none)));
    }
    let mut out = String::from("<ul>");
    for line in lines {
        out.push_str("<li>");
        out.push_str(&escape_html(&format_line(line, zones, locale)?));
        out.push_str("</li>");
    }
    out.push_str("</ul>");
    Ok(out)
}

/// What changed, as a list: moves, then additions, then removals, each
/// chronological. Empty when nothing did, so a `first` message using
/// `{{changes}}` renders nothing there rather than an empty list.
///
/// # Errors
///
/// [`UnknownTimeZone`] when a line's zone was not supplied.
pub fn changes_html(diff: &Diff, zones: &Zones, locale: Locale) -> Result<String, UnknownTimeZone> {
    if diff.is_empty() {
        return Ok(String::new());
    }
    let words = sentences(locale);
    let mut items: Vec<String> = Vec::new();
    for change in &diff.moved {
        let from = format_line(&change.from, zones, locale)?;
        let to = format_line(&change.to, zones, locale)?;
        items.push(labelled(locale, words.moved, &format!("{from} → {to}")));
    }
    for line in &diff.added {
        items.push(labelled(
            locale,
            words.added,
            &format_line(line, zones, locale)?,
        ));
    }
    for line in &diff.removed {
        items.push(labelled(
            locale,
            words.removed,
            &format_line(line, zones, locale)?,
        ));
    }
    let mut out = String::from("<ul>");
    for item in items {
        out.push_str("<li>");
        out.push_str(&escape_html(&item));
        out.push_str("</li>");
    }
    out.push_str("</ul>");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use jiff::tz::TimeZone;
    use uuid::Uuid;

    use super::{
        Values, Variable, assignations_html, changes_html, escape_html, render,
        unknown_placeholders,
    };
    use crate::schedule::lines::{Diff, Move, ScheduleLine};
    use crate::schedule::locale::{Locale, Zones};

    fn values() -> Values {
        Values {
            first_name: "Camille".to_owned(),
            display_name: "DUPONT Camille".to_owned(),
            event_name: String::new(),
            festival_name: "Soundclash 26".to_owned(),
            organization_name: "Asso".to_owned(),
            assignations: "<ul><li>x</li></ul>".to_owned(),
            changes: String::new(),
        }
    }

    #[test]
    fn variables_round_trip_by_name() {
        for variable in Variable::ALL {
            assert_eq!(Variable::parse(variable.name()), Some(variable));
        }
        assert_eq!(Variable::parse("firstname"), None);
    }

    #[test]
    fn escaping_covers_the_five_characters() {
        assert_eq!(
            escape_html(r#"<b>Zoé</b> & "Bar" 'n'"#),
            "&lt;b&gt;Zoé&lt;/b&gt; &amp; &quot;Bar&quot; &#39;n&#39;"
        );
    }

    #[test]
    fn placeholders_are_filled_and_html_values_go_in_as_is() {
        assert_eq!(
            render("Bonjour {{firstName}} : {{assignations}}", &values()),
            "Bonjour Camille : <ul><li>x</li></ul>"
        );
    }

    #[test]
    fn a_fallback_takes_the_first_non_empty_value() {
        assert_eq!(
            render("{{eventName|festivalName}}", &values()),
            "Soundclash 26"
        );
        assert_eq!(
            render("{{ eventName | festivalName }}", &values()),
            "Soundclash 26"
        );
        let one_day = Values {
            event_name: "Samedi".to_owned(),
            ..values()
        };
        assert_eq!(render("{{eventName|festivalName}}", &one_day), "Samedi");
        assert_eq!(render("{{changes|eventName}}", &values()), "");
    }

    #[test]
    fn an_unknown_placeholder_is_left_as_written_and_reported_once() {
        let template = "{{firstname}} {{firstName}} {{eventName|nope}} {{firstname}}";
        assert_eq!(
            render(template, &values()),
            "{{firstname}} Camille {{eventName|nope}} {{firstname}}"
        );
        assert_eq!(unknown_placeholders(template), vec!["firstname", "nope"]);
    }

    #[test]
    fn braces_scan_as_the_browser_regex_does() {
        assert_eq!(render("{{{firstName}}}", &values()), "{Camille}");
        assert_eq!(render("{{first{Name}}", &values()), "{{first{Name}}");
        assert_eq!(render("{{firstName}", &values()), "{{firstName}");
        assert_eq!(render("{{}}", &values()), "{{}}");
        assert_eq!(unknown_placeholders("{{}}"), vec![""]);
        assert_eq!(render("é{{firstName}}ü", &values()), "éCamilleü");
        assert_eq!(render("", &values()), "");
    }

    fn zones() -> Zones {
        let mut zones = Zones::new();
        zones.insert("Europe/Paris", TimeZone::get("Europe/Paris").expect("tzdb"));
        zones
    }

    fn line(post: &str, start: &str, end: &str) -> ScheduleLine {
        ScheduleLine {
            event_id: Uuid::nil(),
            location_id: Uuid::nil(),
            mission: post.to_owned(),
            timezone: "Europe/Paris".to_owned(),
            start: start.parse().expect("instant"),
            end: end.parse().expect("instant"),
        }
    }

    #[test]
    fn a_schedule_is_a_list_with_names_escaped() {
        let html = assignations_html(
            &[line(
                "Bar & <Snack>",
                "2026-09-05T08:00:00Z",
                "2026-09-05T12:00:00Z",
            )],
            &zones(),
            Locale::Fr,
            "rien",
        )
        .expect("zone supplied");
        assert_eq!(
            html,
            "<ul><li>samedi 5 septembre, 10:00–14:00 : Bar &amp; &lt;Snack&gt;</li></ul>"
        );
    }

    #[test]
    fn an_empty_schedule_is_a_sentence() {
        assert_eq!(
            assignations_html(&[], &zones(), Locale::Fr, "Rien d’attribué.").expect("no lines"),
            "<p>Rien d’attribué.</p>"
        );
    }

    #[test]
    fn changes_list_moves_then_additions_then_removals() {
        let diff = Diff {
            added: vec![line("Gate", "2026-09-05T14:00:00Z", "2026-09-05T16:00:00Z")],
            removed: vec![line("Bar", "2026-09-05T06:00:00Z", "2026-09-05T07:00:00Z")],
            moved: vec![Move {
                from: line("Bar", "2026-09-05T08:00:00Z", "2026-09-05T12:00:00Z"),
                to: line("Bar", "2026-09-05T09:00:00Z", "2026-09-05T13:00:00Z"),
            }],
        };
        assert_eq!(
            changes_html(&diff, &zones(), Locale::En).expect("zones supplied"),
            "<ul>\
             <li>Moved: Saturday, September 5, 10:00 AM–02:00 PM: Bar → Saturday, September 5, 11:00 AM–03:00 PM: Bar</li>\
             <li>Added: Saturday, September 5, 04:00 PM–06:00 PM: Gate</li>\
             <li>Removed: Saturday, September 5, 08:00 AM–09:00 AM: Bar</li>\
             </ul>"
        );
        assert_eq!(
            changes_html(&Diff::default(), &zones(), Locale::En).expect("nothing to format"),
            ""
        );
    }
}
