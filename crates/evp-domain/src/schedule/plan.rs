// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Who is written to when a roster is published, which message they get, and
//! the message itself (docs/04 §Publishing, docs/03 §3.7).
//!
//! The baseline is what the volunteer was last *sent*, not what was last
//! published: someone who opted out, or had no address, is compared against
//! the last schedule that actually reached them, so the first message they can
//! receive tells them everything that changed in between.

use uuid::Uuid;

use super::lines::{Diff, ScheduleLine, diff, digest, merge_adjacent};
use super::locale::{Locale, Template, TemplateKind, UnknownTimeZone, Zones, sentences};
use super::render::{Values, assignations_html, changes_html, escape_html, render};
use super::text::html_to_text;

/// Which message a volunteer gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Never sent a schedule for this scope. Includes someone enrolled with no
    /// shift at all, who is told so rather than left to guess (docs/01 S10).
    First,
    /// Sent one before, and it changed.
    Update,
    /// Sent one with shifts before, and now has none — the case most likely
    /// to make someone turn up when they should not.
    Emptied,
}

impl Kind {
    #[must_use]
    pub fn template(self) -> TemplateKind {
        match self {
            Self::First => TemplateKind::First,
            Self::Update | Self::Emptied => TemplateKind::Update,
        }
    }
}

/// The comparison of one volunteer's schedule with what they were last sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classification {
    /// `None` when nothing changed and nobody needs writing to.
    pub kind: Option<Kind>,
    /// The merged schedule as it now stands — what a snapshot stores.
    pub lines: Vec<ScheduleLine>,
    pub digest: [u8; 32],
    pub diff: Diff,
}

/// Compares `current` (any order, unmerged) with `baseline`, the merged lines
/// of the last snapshot that was sent, or `None` if none ever was.
#[must_use]
pub fn classify(current: Vec<ScheduleLine>, baseline: Option<&[ScheduleLine]>) -> Classification {
    let lines = merge_adjacent(current);
    let fingerprint = digest(&lines);
    let (kind, changes) = match baseline {
        None => (Some(Kind::First), Diff::default()),
        Some(previous) if digest(previous) == fingerprint => (None, Diff::default()),
        Some(previous) => {
            let kind = if lines.is_empty() {
                Kind::Emptied
            } else {
                Kind::Update
            };
            (Some(kind), diff(previous, &lines))
        }
    };
    Classification {
        kind,
        lines,
        digest: fingerprint,
        diff: changes,
    }
}

/// The volunteer as the message needs them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipient {
    pub volunteer_id: Uuid,
    pub first_name: Option<String>,
    pub display_name: String,
    /// `None` for an anonymised volunteer as well as one who never gave one.
    pub email: Option<String>,
    pub notify_email: bool,
}

impl Recipient {
    /// `coalesce(first_name, display_name)` — "Aurel" once a first name is
    /// known, the full stored name until then (ADR-0012).
    #[must_use]
    pub fn greeting(&self) -> &str {
        self.first_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.display_name)
    }
}

/// Whether a message that should go out can.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Email,
    /// `notify_email` is false. Counted as `skipped_opted_out`.
    OptedOut,
    /// No address on file. Reported in `errors[]` so the coordinator can
    /// reach them another way.
    NoAddress,
}

#[must_use]
pub fn delivery(recipient: &Recipient) -> Delivery {
    if !recipient.notify_email {
        Delivery::OptedOut
    } else if recipient
        .email
        .as_deref()
        .is_none_or(|email| email.trim().is_empty())
    {
        Delivery::NoAddress
    } else {
        Delivery::Email
    }
}

/// What is the same for every message of one publication.
#[derive(Debug, Clone)]
pub struct Context {
    pub locale: Locale,
    pub zones: Zones,
    /// Empty on a festival-wide publication, where no single day's name is
    /// right — `{{eventName|festivalName}}` then falls through.
    pub event_name: String,
    pub festival_name: String,
    pub organization_name: String,
}

/// A rendered message, ready for the outbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub subject: String,
    pub html: String,
    pub text: String,
}

/// Renders one volunteer's message from the template their [`Kind`] selects.
///
/// # Errors
///
/// [`UnknownTimeZone`] when a line's zone is missing from the context.
pub fn compose(
    recipient: &Recipient,
    kind: Kind,
    classification: &Classification,
    template: &Template,
    context: &Context,
) -> Result<Message, UnknownTimeZone> {
    let words = sentences(context.locale);
    let none = match kind {
        Kind::Emptied => words.emptied,
        Kind::First | Kind::Update => words.none_yet,
    };
    let assignations =
        assignations_html(&classification.lines, &context.zones, context.locale, none)?;
    let changes = match kind {
        Kind::First => String::new(),
        Kind::Update | Kind::Emptied => {
            changes_html(&classification.diff, &context.zones, context.locale)?
        }
    };

    // A subject line is not HTML: its values go in raw, and the schedule
    // itself has no place in it.
    let subject_values = Values {
        first_name: recipient.greeting().to_owned(),
        display_name: recipient.display_name.clone(),
        event_name: context.event_name.clone(),
        festival_name: context.festival_name.clone(),
        organization_name: context.organization_name.clone(),
        assignations: String::new(),
        changes: String::new(),
    };
    let body_values = Values {
        first_name: escape_html(&subject_values.first_name),
        display_name: escape_html(&subject_values.display_name),
        event_name: escape_html(&subject_values.event_name),
        festival_name: escape_html(&subject_values.festival_name),
        organization_name: escape_html(&subject_values.organization_name),
        assignations,
        changes,
    };

    let html = render(&template.body_html, &body_values);
    // Newlines in a subject would be a header injection; lettre rejects them,
    // and a template typed in a textarea can contain one.
    let subject = render(&template.subject, &subject_values)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Ok(Message {
        subject,
        text: html_to_text(&html),
        html,
    })
}

#[cfg(test)]
mod tests {
    use jiff::tz::TimeZone;
    use uuid::Uuid;

    use super::{Classification, Context, Delivery, Kind, Recipient, classify, compose, delivery};
    use crate::schedule::lines::ScheduleLine;
    use crate::schedule::locale::{Locale, Template, TemplateKind, Zones, default_template};

    const BAR: Uuid = Uuid::from_u128(0xBA);
    const GATE: Uuid = Uuid::from_u128(0x6A);

    fn line(post: Uuid, start: &str, end: &str) -> ScheduleLine {
        ScheduleLine {
            event_id: Uuid::from_u128(0xE),
            location_id: post,
            mission: if post == BAR { "Bar" } else { "Gate" }.to_owned(),
            timezone: "Europe/Paris".to_owned(),
            start: start.parse().expect("instant"),
            end: end.parse().expect("instant"),
        }
    }

    fn morning() -> ScheduleLine {
        line(BAR, "2026-09-05T08:00:00Z", "2026-09-05T12:00:00Z")
    }

    fn afternoon() -> ScheduleLine {
        line(BAR, "2026-09-05T12:00:00Z", "2026-09-05T16:00:00Z")
    }

    fn recipient() -> Recipient {
        Recipient {
            volunteer_id: Uuid::from_u128(1),
            first_name: Some("Aurel".to_owned()),
            display_name: "MARCHAND Aurel".to_owned(),
            email: Some("aurel@example.test".to_owned()),
            notify_email: true,
        }
    }

    fn context() -> Context {
        let mut zones = Zones::new();
        zones.insert("Europe/Paris", TimeZone::get("Europe/Paris").expect("tzdb"));
        Context {
            locale: Locale::Fr,
            zones,
            event_name: String::new(),
            festival_name: "Soundclash <26>".to_owned(),
            organization_name: "Asso & Co".to_owned(),
        }
    }

    // ── classification ──────────────────────────────────────────────────

    #[test]
    fn never_sent_is_first_with_or_without_shifts() {
        assert_eq!(classify(vec![morning()], None).kind, Some(Kind::First));
        assert_eq!(classify(vec![], None).kind, Some(Kind::First));
    }

    #[test]
    fn the_same_hours_are_unchanged_even_split_differently() {
        // Sent as one merged line; now two touching shifts.
        let merged = classify(vec![morning(), afternoon()], None).lines;
        let again = classify(vec![afternoon(), morning()], Some(&merged));
        assert_eq!(again.kind, None);
        assert!(again.diff.is_empty());
    }

    #[test]
    fn different_hours_are_an_update_with_a_diff() {
        let sent = classify(vec![morning()], None).lines;
        let now = classify(vec![afternoon()], Some(&sent));
        assert_eq!(now.kind, Some(Kind::Update));
        assert_eq!(now.diff.moved.len(), 1);
    }

    #[test]
    fn losing_every_shift_is_emptied() {
        let sent = classify(vec![morning()], None).lines;
        let now = classify(vec![], Some(&sent));
        assert_eq!(now.kind, Some(Kind::Emptied));
        assert_eq!(now.diff.removed, sent);
    }

    #[test]
    fn still_nothing_after_nothing_is_unchanged() {
        assert_eq!(classify(vec![], Some(&[])).kind, None);
    }

    #[test]
    fn gaining_a_first_shift_after_an_empty_message_is_an_update() {
        let now = classify(vec![morning()], Some(&[]));
        assert_eq!(now.kind, Some(Kind::Update));
        assert_eq!(now.diff.added, vec![morning()]);
    }

    #[test]
    fn kinds_pick_their_template() {
        assert_eq!(Kind::First.template(), TemplateKind::First);
        assert_eq!(Kind::Update.template(), TemplateKind::Update);
        assert_eq!(Kind::Emptied.template(), TemplateKind::Update);
    }

    // ── recipients ──────────────────────────────────────────────────────

    #[test]
    fn the_greeting_prefers_a_first_name() {
        assert_eq!(recipient().greeting(), "Aurel");
        for missing in [None, Some(String::new()), Some("  ".to_owned())] {
            let unknown = Recipient {
                first_name: missing,
                ..recipient()
            };
            assert_eq!(unknown.greeting(), "MARCHAND Aurel");
        }
    }

    #[test]
    fn delivery_respects_opt_out_before_address() {
        assert_eq!(delivery(&recipient()), Delivery::Email);
        let opted_out = Recipient {
            notify_email: false,
            email: None,
            ..recipient()
        };
        assert_eq!(delivery(&opted_out), Delivery::OptedOut);
        for missing in [None, Some(String::new()), Some(" ".to_owned())] {
            let unreachable = Recipient {
                email: missing,
                ..recipient()
            };
            assert_eq!(delivery(&unreachable), Delivery::NoAddress);
        }
    }

    // ── composition ─────────────────────────────────────────────────────

    fn compose_with(
        kind: Kind,
        classification: &Classification,
        template: &Template,
    ) -> super::Message {
        compose(&recipient(), kind, classification, template, &context()).expect("zone supplied")
    }

    #[test]
    fn a_first_message_lists_the_schedule_and_escapes_names() {
        let classification = classify(vec![morning(), afternoon()], None);
        let message = compose_with(
            Kind::First,
            &classification,
            &default_template(Locale::Fr, TemplateKind::First),
        );
        assert_eq!(message.subject, "Tes créneaux bénévoles – Soundclash <26>");
        assert!(message.html.contains("Bonjour Aurel,"));
        assert!(message.html.contains("au Soundclash &lt;26&gt; !"));
        assert!(
            message
                .html
                .contains("<li>samedi 5 septembre, 10:00–18:00 : Bar</li>")
        );
        assert!(message.html.contains("L’équipe Asso &amp; Co"));
        assert!(
            message
                .text
                .contains("• samedi 5 septembre, 10:00–18:00 : Bar")
        );
        assert!(message.text.contains("L’équipe Asso & Co"));
    }

    #[test]
    fn someone_with_no_shift_is_told_so() {
        let message = compose_with(
            Kind::First,
            &classify(vec![], None),
            &default_template(Locale::Fr, TemplateKind::First),
        );
        assert!(
            message
                .html
                .contains("<p>Aucun créneau ne t’a encore été attribué.</p>")
        );
    }

    #[test]
    fn an_update_lists_what_changed_and_the_new_schedule() {
        let sent = classify(vec![morning()], None).lines;
        let classification = classify(
            vec![line(GATE, "2026-09-05T14:00:00Z", "2026-09-05T16:00:00Z")],
            Some(&sent),
        );
        let message = compose_with(
            Kind::Update,
            &classification,
            &default_template(Locale::Fr, TemplateKind::Update),
        );
        assert!(
            message
                .html
                .contains("<li>Ajouté : samedi 5 septembre, 16:00–18:00 : Gate</li>")
        );
        assert!(
            message
                .html
                .contains("<li>Retiré : samedi 5 septembre, 10:00–14:00 : Bar</li>")
        );
        assert!(
            message
                .subject
                .starts_with("Ton planning bénévole a changé")
        );
    }

    #[test]
    fn an_emptied_schedule_says_so_explicitly() {
        let sent = classify(vec![morning()], None).lines;
        let classification = classify(vec![], Some(&sent));
        let message = compose_with(
            Kind::Emptied,
            &classification,
            &default_template(Locale::Fr, TemplateKind::Update),
        );
        assert!(message.html.contains("<p>Tu n’as plus aucun créneau"));
        assert!(
            message
                .html
                .contains("Retiré : samedi 5 septembre, 10:00–14:00 : Bar")
        );
    }

    #[test]
    fn a_first_message_never_shows_changes() {
        let template = Template {
            subject: "s".to_owned(),
            body_html: "[{{changes}}]".to_owned(),
        };
        let message = compose_with(Kind::First, &classify(vec![morning()], None), &template);
        assert_eq!(message.html, "[]");
    }

    #[test]
    fn a_subject_cannot_carry_a_line_break() {
        let template = Template {
            subject: "Bonjour\r\nBcc: x@y {{firstName}}".to_owned(),
            body_html: String::new(),
        };
        let message = compose_with(Kind::First, &classify(vec![], None), &template);
        assert_eq!(message.subject, "Bonjour Bcc: x@y Aurel");
    }
}
