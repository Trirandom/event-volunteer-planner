// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! What the server writes *to volunteers* in their language: dates, times,
//! schedule lines, the sentences around them, and the default templates.
//!
//! Hand-written tables rather than an ICU dependency (docs/17 §6 leaves the
//! backend's ICU story open): two languages, a dozen month names and one line
//! format do not justify pinning a large crate for a decision that is still
//! open. The tables reproduce what the admin app's `Intl.DateTimeFormat`
//! prints for the same instant — `samedi 5 septembre`, `Saturday, September
//! 5`, `14:00`, `02:00 PM` — and the shared fixture
//! (`fixtures/schedule_render.json`) is what holds the two to that.

use std::collections::BTreeMap;

use jiff::civil::Weekday;
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp, Zoned};
use serde::{Deserialize, Serialize};

use super::lines::ScheduleLine;

/// The language a message is written in. French is the default, as it is for
/// `volunteers.locale` and the admin app.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    #[default]
    Fr,
    En,
}

impl Locale {
    /// `fr` or `en`, exactly; anything else is not a language this server
    /// writes in.
    #[must_use]
    pub fn parse(tag: &str) -> Option<Self> {
        match tag {
            "fr" => Some(Self::Fr),
            "en" => Some(Self::En),
            _ => None,
        }
    }

    #[must_use]
    pub fn tag(self) -> &'static str {
        match self {
            Self::Fr => "fr",
            Self::En => "en",
        }
    }
}

/// Time zones by IANA name, resolved by the caller. Lines carry the name
/// (they are stored), and looking one up reads the system tzdb — I/O this
/// crate does not do.
#[derive(Debug, Clone, Default)]
pub struct Zones(BTreeMap<String, TimeZone>);

impl Zones {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, name: impl Into<String>, zone: TimeZone) {
        self.0.insert(name.into(), zone);
    }

    fn get(&self, name: &str) -> Result<&TimeZone, UnknownTimeZone> {
        self.0
            .get(name)
            .ok_or_else(|| UnknownTimeZone(name.to_owned()))
    }
}

/// A line named a zone the caller did not supply. A programming error, and
/// reported as one: a message with its times in the wrong zone is worse than
/// no message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("no time zone named {0:?} was supplied")]
pub struct UnknownTimeZone(pub String);

const WEEKDAYS_FR: [&str; 7] = [
    "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
];
const WEEKDAYS_EN: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];
const MONTHS_FR: [&str; 12] = [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
];
const MONTHS_EN: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn weekday_name(locale: Locale, weekday: Weekday) -> &'static str {
    let names = match locale {
        Locale::Fr => &WEEKDAYS_FR,
        Locale::En => &WEEKDAYS_EN,
    };
    usize::try_from(weekday.to_monday_zero_offset())
        .ok()
        .and_then(|index| names.get(index))
        .copied()
        .unwrap_or_default()
}

fn month_name(locale: Locale, month: i8) -> &'static str {
    let names = match locale {
        Locale::Fr => &MONTHS_FR,
        Locale::En => &MONTHS_EN,
    };
    usize::try_from(month)
        .ok()
        .and_then(|month| month.checked_sub(1))
        .and_then(|index| names.get(index))
        .copied()
        .unwrap_or_default()
}

/// `samedi 5 septembre` / `Saturday, September 5` — `formatDay` in
/// `@evp/shared/intl`.
#[must_use]
pub fn format_day(instant: Timestamp, zone: &TimeZone, locale: Locale) -> String {
    let zoned = instant.to_zoned(zone.clone());
    let weekday = weekday_name(locale, zoned.weekday());
    let month = month_name(locale, zoned.month());
    let day = zoned.day();
    match locale {
        Locale::Fr => format!("{weekday} {day} {month}"),
        Locale::En => format!("{weekday}, {month} {day}"),
    }
}

/// `14:00` / `02:00 PM` — `formatTime`: two-digit hours in both, a 12-hour
/// clock in English because `Intl`'s `en` is `en-US`.
#[must_use]
pub fn format_time(instant: Timestamp, zone: &TimeZone, locale: Locale) -> String {
    let zoned: Zoned = instant.to_zoned(zone.clone());
    match locale {
        Locale::Fr => zoned.strftime("%H:%M").to_string(),
        Locale::En => zoned.strftime("%I:%M %p").to_string(),
    }
}

/// One schedule line as the volunteer reads it — `emails.message.line` and
/// `lineAcrossDays` in the admin catalogue.
///
/// # Errors
///
/// [`UnknownTimeZone`] when the line's zone was not supplied.
pub fn format_line(
    line: &ScheduleLine,
    zones: &Zones,
    locale: Locale,
) -> Result<String, UnknownTimeZone> {
    let zone = zones.get(&line.timezone)?;
    let day = format_day(line.start, zone, locale);
    // The last millisecond, not the end instant: a shift ending at midnight
    // ended on the day it started, and "samedi 22:00 – dimanche 00:00" says
    // a night nobody worked.
    let last = line
        .end
        .checked_sub(SignedDuration::from_millis(1))
        .unwrap_or(line.end);
    let end_day = format_day(last, zone, locale);
    let start = format_time(line.start, zone, locale);
    let end = format_time(line.end, zone, locale);
    let mission = &line.mission;
    Ok(match (locale, day == end_day) {
        (Locale::Fr, true) => format!("{day}, {start}–{end} : {mission}"),
        (Locale::Fr, false) => format!("{day}, {start} – {end_day}, {end} : {mission}"),
        (Locale::En, true) => format!("{day}, {start}–{end}: {mission}"),
        (Locale::En, false) => format!("{day}, {start} – {end_day}, {end}: {mission}"),
    })
}

/// The sentences a schedule email is built around. Each is plain text; the
/// renderer escapes it.
#[derive(Debug, Clone, Copy)]
pub struct Sentences {
    /// Enrolled, never given a shift — `emails.message.none`.
    pub none_yet: &'static str,
    /// Had shifts, now has none. A different sentence because it is a
    /// different situation: this person may have planned around those shifts,
    /// and silence is what makes them turn up anyway (docs/04 §Publishing).
    pub emptied: &'static str,
    pub added: &'static str,
    pub removed: &'static str,
    pub moved: &'static str,
}

#[must_use]
pub fn sentences(locale: Locale) -> Sentences {
    match locale {
        Locale::Fr => Sentences {
            none_yet: "Aucun créneau ne t’a encore été attribué.",
            emptied: "Tu n’as plus aucun créneau : ceux qui t’avaient été attribués ont été retirés.",
            added: "Ajouté",
            removed: "Retiré",
            moved: "Déplacé",
        },
        Locale::En => Sentences {
            none_yet: "You have not been given any shifts yet.",
            emptied: "You no longer have any shifts: the ones you had been given have been removed.",
            added: "Added",
            removed: "Removed",
            moved: "Moved",
        },
    }
}

/// `Ajouté : …` / `Added: …` — French puts a space before the colon.
#[must_use]
pub fn labelled(locale: Locale, label: &str, text: &str) -> String {
    match locale {
        Locale::Fr => format!("{label} : {text}"),
        Locale::En => format!("{label}: {text}"),
    }
}

/// Which of a festival's two templates a message uses — the spreadsheet's
/// `emailTemplate` and `emailTemplateNext` (docs/10 §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TemplateKind {
    /// Nobody has been sent a schedule for this scope yet.
    First,
    /// Their schedule changed since the last one they were sent.
    Update,
}

/// A subject and an HTML body with `{{placeholders}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    pub subject: String,
    pub body_html: String,
}

/// The template a festival starts from. `First` in each language is the admin
/// app's `emails.template.default` with its placeholders filled in as the page
/// fills them, byte for byte, so a coordinator who never edited theirs sends
/// what they previewed.
#[must_use]
pub fn default_template(locale: Locale, kind: TemplateKind) -> Template {
    let (subject, body) = match (locale, kind) {
        (Locale::Fr, TemplateKind::First) => (
            "Tes créneaux bénévoles – {{eventName|festivalName}}",
            "<div dir=\"ltr\">\nBonjour {{firstName}},<br>\n<br>\nMerci pour ton engagement bénévole au {{eventName|festivalName}} !<br>\n<br>\n<b>Voici tes créneaux bénévoles :</b><br>\n<div>\n{{assignations}}\n</div><br>\nSi tu as le moindre souci avec l’un des créneaux qui t’a été attribué, merci de nous prévenir en répondant à cet e-mail.<br>\n<br>\nÀ bientôt<br>\n<br>\n<b>L’équipe {{organizationName}}</b>\n</div>",
        ),
        (Locale::Fr, TemplateKind::Update) => (
            "Ton planning bénévole a changé – {{eventName|festivalName}}",
            "<div dir=\"ltr\">\nBonjour {{firstName}},<br>\n<br>\nTon planning bénévole au {{eventName|festivalName}} a changé.<br>\n<br>\n<b>Ce qui change :</b><br>\n<div>\n{{changes}}\n</div><br>\n<b>Tes créneaux à jour :</b><br>\n<div>\n{{assignations}}\n</div><br>\nSi l’un de ces créneaux te pose problème, merci de nous prévenir en répondant à cet e-mail.<br>\n<br>\nÀ bientôt<br>\n<br>\n<b>L’équipe {{organizationName}}</b>\n</div>",
        ),
        (Locale::En, TemplateKind::First) => (
            "Your volunteer shifts – {{eventName|festivalName}}",
            "<div dir=\"ltr\">\nHi {{firstName}},<br>\n<br>\nThank you for volunteering at {{eventName|festivalName}}!<br>\n<br>\n<b>Here are your volunteer shifts:</b><br>\n<div>\n{{assignations}}\n</div><br>\nIf anything is wrong with one of the shifts you have been given, please let us know by replying to this email.<br>\n<br>\nSee you soon<br>\n<br>\n<b>The {{organizationName}} team</b>\n</div>",
        ),
        (Locale::En, TemplateKind::Update) => (
            "Your volunteer schedule has changed – {{eventName|festivalName}}",
            "<div dir=\"ltr\">\nHi {{firstName}},<br>\n<br>\nYour volunteer schedule for {{eventName|festivalName}} has changed.<br>\n<br>\n<b>What changed:</b><br>\n<div>\n{{changes}}\n</div><br>\n<b>Your shifts as they are now:</b><br>\n<div>\n{{assignations}}\n</div><br>\nIf any of these shifts is a problem for you, please let us know by replying to this email.<br>\n<br>\nSee you soon<br>\n<br>\n<b>The {{organizationName}} team</b>\n</div>",
        ),
    };
    Template {
        subject: subject.to_owned(),
        body_html: body.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use jiff::tz::TimeZone;
    use rstest::rstest;
    use uuid::Uuid;

    use super::{
        Locale, TemplateKind, UnknownTimeZone, Zones, default_template, format_day, format_line,
        format_time,
    };
    use crate::schedule::lines::ScheduleLine;
    use crate::schedule::render::unknown_placeholders;

    fn paris() -> TimeZone {
        TimeZone::get("Europe/Paris").expect("Europe/Paris is in the tzdb")
    }

    fn zones() -> Zones {
        let mut zones = Zones::new();
        zones.insert("Europe/Paris", paris());
        zones
    }

    fn utc(text: &str) -> Timestamp {
        text.parse().expect("an RFC 3339 instant")
    }

    fn line(start: &str, end: &str) -> ScheduleLine {
        ScheduleLine {
            event_id: Uuid::nil(),
            location_id: Uuid::nil(),
            mission: "Bar & Snack".to_owned(),
            timezone: "Europe/Paris".to_owned(),
            start: utc(start),
            end: utc(end),
        }
    }

    #[rstest]
    #[case(Locale::Fr, "samedi 5 septembre")]
    #[case(Locale::En, "Saturday, September 5")]
    fn a_day_reads_as_intl_prints_it(#[case] locale: Locale, #[case] expected: &str) {
        assert_eq!(
            format_day(utc("2026-09-05T12:00:00Z"), &paris(), locale),
            expected
        );
    }

    #[test]
    fn the_day_is_the_events_not_utcs() {
        // 23:30 UTC on the 5th is already the 6th in Paris.
        assert_eq!(
            format_day(utc("2026-09-05T23:30:00Z"), &paris(), Locale::Fr),
            "dimanche 6 septembre"
        );
    }

    #[rstest]
    #[case("2026-09-05T12:00:00Z", Locale::Fr, "14:00")]
    #[case("2026-09-05T12:00:00Z", Locale::En, "02:00 PM")]
    #[case("2026-09-05T22:00:00Z", Locale::Fr, "00:00")]
    #[case("2026-09-05T22:00:00Z", Locale::En, "12:00 AM")]
    #[case("2026-09-05T10:05:00Z", Locale::En, "12:05 PM")]
    #[case("2026-09-05T23:00:00Z", Locale::En, "01:00 AM")]
    fn times_read_as_intl_prints_them(
        #[case] instant: &str,
        #[case] locale: Locale,
        #[case] expected: &str,
    ) {
        assert_eq!(format_time(utc(instant), &paris(), locale), expected);
    }

    #[test]
    fn the_october_change_is_followed() {
        // 25 October 2026: at 01:00 UTC Paris goes from +02:00 to +01:00, so
        // 02:30 happens twice. Each instant is shown at its own offset.
        assert_eq!(
            format_time(utc("2026-10-25T00:30:00Z"), &paris(), Locale::Fr),
            "02:30"
        );
        assert_eq!(
            format_time(utc("2026-10-25T01:30:00Z"), &paris(), Locale::Fr),
            "02:30"
        );
        assert_eq!(
            format_time(utc("2026-10-25T02:30:00Z"), &paris(), Locale::Fr),
            "03:30"
        );
    }

    #[rstest]
    #[case(Locale::Fr, "samedi 5 septembre, 10:00–14:00 : Bar & Snack")]
    #[case(Locale::En, "Saturday, September 5, 10:00 AM–02:00 PM: Bar & Snack")]
    fn a_line_within_one_day(#[case] locale: Locale, #[case] expected: &str) {
        let shift = line("2026-09-05T08:00:00Z", "2026-09-05T12:00:00Z");
        assert_eq!(
            format_line(&shift, &zones(), locale).expect("zone supplied"),
            expected
        );
    }

    #[test]
    fn a_shift_ending_at_midnight_stays_on_its_day() {
        let shift = line("2026-09-05T20:00:00Z", "2026-09-05T22:00:00Z");
        assert_eq!(
            format_line(&shift, &zones(), Locale::Fr).expect("zone supplied"),
            "samedi 5 septembre, 22:00–00:00 : Bar & Snack"
        );
    }

    #[rstest]
    #[case(
        Locale::Fr,
        "samedi 5 septembre, 22:00 – dimanche 6 septembre, 02:00 : Bar & Snack"
    )]
    #[case(
        Locale::En,
        "Saturday, September 5, 10:00 PM – Sunday, September 6, 02:00 AM: Bar & Snack"
    )]
    fn a_shift_across_midnight_names_both_days(#[case] locale: Locale, #[case] expected: &str) {
        let shift = line("2026-09-05T20:00:00Z", "2026-09-06T00:00:00Z");
        assert_eq!(
            format_line(&shift, &zones(), locale).expect("zone supplied"),
            expected
        );
    }

    #[test]
    fn a_missing_zone_is_an_error_not_a_guess() {
        let shift = line("2026-09-05T08:00:00Z", "2026-09-05T12:00:00Z");
        assert_eq!(
            format_line(&shift, &Zones::new(), Locale::Fr),
            Err(UnknownTimeZone("Europe/Paris".to_owned()))
        );
    }

    #[test]
    fn locale_tags_round_trip() {
        for locale in [Locale::Fr, Locale::En] {
            assert_eq!(Locale::parse(locale.tag()), Some(locale));
        }
        assert_eq!(Locale::parse("de"), None);
        assert_eq!(Locale::parse("FR"), None);
    }

    #[test]
    fn every_default_template_uses_only_known_placeholders() {
        for locale in [Locale::Fr, Locale::En] {
            for kind in [TemplateKind::First, TemplateKind::Update] {
                let template = default_template(locale, kind);
                assert!(unknown_placeholders(&template.subject).is_empty());
                assert!(unknown_placeholders(&template.body_html).is_empty());
                assert!(template.body_html.contains("{{assignations}}"));
                assert_eq!(
                    template.body_html.contains("{{changes}}"),
                    kind == TemplateKind::Update
                );
            }
        }
    }
}
