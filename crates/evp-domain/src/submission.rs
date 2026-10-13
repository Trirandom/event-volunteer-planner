// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! What a public form submission must satisfy before it is stored
//! (docs/04 §"Public and unauthenticated", docs/09 §3 and §5).
//!
//! The form bundle checks the same things first, so a volunteer is told
//! beside the field rather than after sending. This is the check that still
//! holds when the bundle is skipped — a script posting straight at the
//! endpoint — and it is deliberately no *stricter* than the bundle: a rule
//! only the server knows about is a submission refused after ten minutes of
//! typing, with nothing on screen to explain it (docs/09 §9, "clamped
//! client-side, revalidated and rejected server-side").
//!
//! What is *not* here, and why:
//!
//! * The honeypot and the timing floor. Neither is a property of the answers;
//!   they decide what happens to a submission that is otherwise valid, and
//!   they live with the handler that decides it.
//! * "This address already belongs to someone else" (ADR-0028). That needs the
//!   pool, and is reconciliation's to decide, not the form's.
//! * Step alignment of availability windows. The bundle rounds to
//!   `availability_step_minutes` in the event's timezone; a range that is not
//!   aligned is imprecise, not wrong, and refusing it would reject a real
//!   volunteer over a rounding difference.

use std::collections::{BTreeMap, BTreeSet};

use jiff::Timestamp;
use uuid::Uuid;

use crate::form::{ConsentPurpose, QuestionDraft, QuestionKind};

/// More ranges than a festival's day rows could produce: six events of four
/// days at a 15-minute step, fully fragmented, is still well under this.
pub const MAX_WINDOWS: usize = 500;
/// Characters in any single-line answer — a name, an address, a date.
pub const MAX_SHORT_TEXT: usize = 500;
/// Characters in a `long_text` answer.
pub const MAX_LONG_TEXT: usize = 5_000;
/// Entries in one `multi_choice` or `missions` answer. Every entry must be a
/// known option, so only a list padded with repeats could approach it.
pub const MAX_CHOICES: usize = 200;

/// One answer as it arrived: the wire's `string | boolean | string[] | null`,
/// plus [`Self::Other`] for anything else JSON can say (a number, an object,
/// a list holding a non-string), which is refused per field rather than
/// turning the whole body into a parse failure nobody can locate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Text(String),
    Flag(bool),
    List(Vec<String>),
    Null,
    Other,
}

impl Answer {
    /// One value of the wire's `answers` map — or of a stored payload's, which
    /// is the same map kept verbatim — read the one way both the handler that
    /// validates it and the reconciliation that applies it must agree on.
    #[must_use]
    pub fn from_json(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(flag) => Self::Flag(*flag),
            serde_json::Value::String(text) => Self::Text(text.clone()),
            serde_json::Value::Array(items) => items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .map_or(Self::Other, Self::List),
            serde_json::Value::Number(_) | serde_json::Value::Object(_) => Self::Other,
        }
    }
}

/// `availability_kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowKind {
    Available,
    Unavailable,
}

/// One declared range, half-open `[start, end)`, for one event in scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub event_id: Uuid,
    pub kind: WindowKind,
    pub start: Timestamp,
    pub end: Timestamp,
}

/// An event the form covers, with the operational `period` windows are
/// clamped to (ADR-0044) — not the public hours, which are context only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeEvent {
    pub id: Uuid,
    pub start: Timestamp,
    pub end: Timestamp,
}

/// A question of the version being answered, with its id.
#[derive(Debug, Clone, Copy)]
pub struct Asked<'a> {
    pub id: Uuid,
    pub question: &'a QuestionDraft,
}

/// Why one field was refused. The string form is what a client branches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Code {
    /// The key names no question of this version.
    UnknownQuestion,
    /// The value's JSON type is not the one this kind takes, or the kind
    /// takes no answer at all (`section`, `availability`).
    WrongType,
    Required,
    /// The `processing` consent or the `commitment` was not given. Both are
    /// always required (ADR-0025, ADR-0040), whatever the stored `is_required`
    /// says.
    ConsentRequired,
    InvalidEmail,
    InvalidPhone,
    InvalidDate,
    UnknownOption,
    TooLong,
    TooMany,
    /// Availability was sent to a version that does not ask for it.
    NotAsked,
    /// A window names an event outside the form's scope.
    UnknownEvent,
    /// A window bound that is not an RFC 3339 instant. Found by the API
    /// layer, which parses; named here so every code a submission can earn
    /// is in one vocabulary.
    InvalidInstant,
    /// A window that ends at or before it starts.
    Inverted,
    /// A window reaching outside its own event's `period`.
    OutsideEvent,
    /// Two windows of one event overlap — the state the exclusion constraint
    /// on `availability_windows` would refuse when the submission is applied.
    Overlap,
}

impl Code {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownQuestion => "unknown_question",
            Self::WrongType => "wrong_type",
            Self::Required => "required",
            Self::ConsentRequired => "consent_required",
            Self::InvalidEmail => "invalid_email",
            Self::InvalidPhone => "invalid_phone",
            Self::InvalidDate => "invalid_date",
            Self::UnknownOption => "unknown_option",
            Self::TooLong => "too_long",
            Self::TooMany => "too_many",
            Self::NotAsked => "not_asked",
            Self::UnknownEvent => "unknown_event",
            Self::InvalidInstant => "invalid_instant",
            Self::Inverted => "inverted",
            Self::OutsideEvent => "outside_event",
            Self::Overlap => "overlap",
        }
    }
}

/// One refusal: the field it concerns — `answers.<question id>`,
/// `availability`, or `availability[<index>]` — and why.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Refusal {
    pub field: String,
    pub code: Code,
}

fn answer_field(id: impl std::fmt::Display) -> String {
    format!("answers.{id}")
}

fn window_field(index: usize) -> String {
    format!("availability[{index}]")
}

/// Everything wrong with a submission, in no particular order; empty when it
/// may be stored.
#[must_use]
pub fn validate(
    questions: &[Asked<'_>],
    events: &[ScopeEvent],
    answers: &BTreeMap<String, Answer>,
    windows: &[Window],
) -> Vec<Refusal> {
    let mut refusals = Vec::new();

    let by_id: BTreeMap<Uuid, &QuestionDraft> = questions
        .iter()
        .map(|asked| (asked.id, asked.question))
        .collect();
    for key in answers.keys() {
        let known = key.parse::<Uuid>().is_ok_and(|id| by_id.contains_key(&id));
        if !known {
            refusals.push(Refusal {
                field: answer_field(key),
                code: Code::UnknownQuestion,
            });
        }
    }

    for asked in questions {
        let field = answer_field(asked.id);
        let answer = answers.get(&asked.id.to_string()).unwrap_or(&Answer::Null);
        if asked.question.kind == QuestionKind::Availability {
            if *answer != Answer::Null {
                refusals.push(Refusal {
                    field,
                    code: Code::WrongType,
                });
            } else if asked.question.is_required
                && !windows
                    .iter()
                    .any(|window| window.kind == WindowKind::Available)
            {
                refusals.push(Refusal {
                    field,
                    code: Code::Required,
                });
            }
            continue;
        }
        if let Some(code) = check_answer(asked.question, answer) {
            refusals.push(Refusal { field, code });
        }
    }

    let asks_availability = questions
        .iter()
        .any(|asked| asked.question.kind == QuestionKind::Availability);
    if !windows.is_empty() && !asks_availability {
        refusals.push(Refusal {
            field: "availability".to_owned(),
            code: Code::NotAsked,
        });
    } else if windows.len() > MAX_WINDOWS {
        refusals.push(Refusal {
            field: "availability".to_owned(),
            code: Code::TooMany,
        });
    } else {
        check_windows(events, windows, &mut refusals);
    }

    refusals
}

/// The one refusal an answer earns, if any. `None` is "may be stored".
fn check_answer(question: &QuestionDraft, answer: &Answer) -> Option<Code> {
    match question.kind {
        QuestionKind::Section | QuestionKind::Availability => {
            (*answer != Answer::Null).then_some(Code::WrongType)
        }
        QuestionKind::ShortText
        | QuestionKind::LongText
        | QuestionKind::Email
        | QuestionKind::Phone
        | QuestionKind::Date
        | QuestionKind::SingleChoice => match answer {
            Answer::Text(text) => check_text(question, text),
            Answer::Null => question.is_required.then_some(Code::Required),
            Answer::Flag(_) | Answer::List(_) | Answer::Other => Some(Code::WrongType),
        },
        QuestionKind::MultiChoice | QuestionKind::Missions => match answer {
            Answer::List(values) => check_choices(question, values),
            Answer::Null => question.is_required.then_some(Code::Required),
            Answer::Text(_) | Answer::Flag(_) | Answer::Other => Some(Code::WrongType),
        },
        QuestionKind::Boolean => match answer {
            Answer::Flag(_) => None,
            Answer::Null => question.is_required.then_some(Code::Required),
            Answer::Text(_) | Answer::List(_) | Answer::Other => Some(Code::WrongType),
        },
        QuestionKind::Consent => {
            let must_be_given = matches!(
                question.consent_purpose,
                Some(ConsentPurpose::Processing | ConsentPurpose::Commitment)
            ) || question.is_required;
            match answer {
                Answer::Flag(true) => None,
                Answer::Flag(false) | Answer::Null => {
                    must_be_given.then_some(Code::ConsentRequired)
                }
                Answer::Text(_) | Answer::List(_) | Answer::Other => Some(Code::WrongType),
            }
        }
    }
}

fn check_text(question: &QuestionDraft, text: &str) -> Option<Code> {
    let limit = if question.kind == QuestionKind::LongText {
        MAX_LONG_TEXT
    } else {
        MAX_SHORT_TEXT
    };
    if text.chars().count() > limit {
        return Some(Code::TooLong);
    }
    let text = text.trim();
    if text.is_empty() {
        // The bundle sends `""` for an optional field left blank: that is
        // "not answered", not a malformed answer.
        return question.is_required.then_some(Code::Required);
    }
    match question.kind {
        QuestionKind::Email => (!looks_like_email(text)).then_some(Code::InvalidEmail),
        QuestionKind::Phone => (!looks_like_phone(text)).then_some(Code::InvalidPhone),
        QuestionKind::Date => (!is_calendar_date(text)).then_some(Code::InvalidDate),
        QuestionKind::SingleChoice => (!offers(question, text)).then_some(Code::UnknownOption),
        QuestionKind::ShortText
        | QuestionKind::LongText
        | QuestionKind::MultiChoice
        | QuestionKind::Boolean
        | QuestionKind::Availability
        | QuestionKind::Missions
        | QuestionKind::Consent
        | QuestionKind::Section => None,
    }
}

fn check_choices(question: &QuestionDraft, values: &[String]) -> Option<Code> {
    if values.len() > MAX_CHOICES {
        return Some(Code::TooMany);
    }
    if values.is_empty() {
        return question.is_required.then_some(Code::Required);
    }
    (!values.iter().all(|value| offers(question, value))).then_some(Code::UnknownOption)
}

fn offers(question: &QuestionDraft, value: &str) -> bool {
    question
        .options
        .as_deref()
        .unwrap_or_default()
        .iter()
        .any(|option| option.value == value)
}

/// The bundle's `EMAIL` pattern, `^[^\s@]+@[^\s@]+\.[^\s@]+$`, restated.
///
/// Loose on purpose, and the same looseness on both sides: the server must
/// not refuse an address the bundle accepted. Whether the address is *real*
/// is answered by mail, not by a pattern.
#[must_use]
pub fn looks_like_email(text: &str) -> bool {
    if text.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    if local.is_empty() || domain.contains('@') {
        return false;
    }
    // A dot with at least one character either side of it.
    let mut inner = domain.chars();
    inner.next();
    inner.next_back();
    inner.as_str().contains('.')
}

/// The bundle's `looksLikePhone`: international formats, no false rejections
/// (docs/09 §1) — digits and the usual separators, six to seventeen digits.
#[must_use]
pub fn looks_like_phone(text: &str) -> bool {
    let allowed = text
        .chars()
        .all(|c| c.is_ascii_digit() || c.is_whitespace() || "+().-/".contains(c));
    let digits = text.chars().filter(char::is_ascii_digit).count();
    allowed && (6..=17).contains(&digits)
}

/// `YYYY-MM-DD`, and a day that exists: `2026-02-30` is refused.
fn is_calendar_date(text: &str) -> bool {
    let shaped = text.len() == 10
        && text.char_indices().all(|(index, c)| match index {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        });
    shaped && text.parse::<jiff::civil::Date>().is_ok()
}

fn check_windows(events: &[ScopeEvent], windows: &[Window], refusals: &mut Vec<Refusal>) {
    let periods: BTreeMap<Uuid, &ScopeEvent> =
        events.iter().map(|event| (event.id, event)).collect();

    // Per event, the windows that were individually sound, for the overlap
    // pass below: an inverted or out-of-scope window already has its refusal
    // and would only add noise to that one.
    let mut sound: BTreeMap<Uuid, Vec<(usize, &Window)>> = BTreeMap::new();
    for (index, window) in windows.iter().enumerate() {
        let code = match periods.get(&window.event_id) {
            None => Some(Code::UnknownEvent),
            Some(_) if window.end <= window.start => Some(Code::Inverted),
            Some(event) if window.start < event.start || window.end > event.end => {
                Some(Code::OutsideEvent)
            }
            Some(_) => None,
        };
        if let Some(code) = code {
            refusals.push(Refusal {
                field: window_field(index),
                code,
            });
        } else {
            sound
                .entry(window.event_id)
                .or_default()
                .push((index, window));
        }
    }

    // Half-open ranges: 08:00–12:00 and 12:00–18:00 touch and do not overlap,
    // which is also how the exclusion constraint reads `&&`.
    let mut overlapping = BTreeSet::new();
    for group in sound.values_mut() {
        group.sort_by_key(|(_, window)| (window.start, window.end));
        let mut reach: Option<Timestamp> = None;
        for (index, window) in group.iter() {
            if reach.is_some_and(|end| window.start < end) {
                overlapping.insert(*index);
            }
            reach = Some(reach.map_or(window.end, |end| end.max(window.end)));
        }
    }
    refusals.extend(overlapping.into_iter().map(|index| Refusal {
        field: window_field(index),
        code: Code::Overlap,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::form::{Localized, QuestionOption, TargetPath};

    fn question(kind: QuestionKind, required: bool) -> QuestionDraft {
        let options = kind.takes_options().then(|| {
            ["bar", "site"]
                .into_iter()
                .map(|value| QuestionOption {
                    value: value.to_owned(),
                    label: Localized::fr(value),
                    skill_id: None,
                    checked_by_default: false,
                    adults_only: false,
                })
                .collect()
        });
        QuestionDraft {
            kind,
            target_path: match kind {
                QuestionKind::Email => Some(TargetPath::Email),
                QuestionKind::Phone => Some(TargetPath::Phone),
                _ => None,
            },
            consent_purpose: (kind == QuestionKind::Consent).then_some(ConsentPurpose::Processing),
            label: Localized::fr("?"),
            help_text: None,
            options,
            is_required: required,
            is_sensitive: false,
        }
    }

    fn at(text: &str) -> Timestamp {
        text.parse().expect("a valid instant")
    }

    const EVENT: Uuid = Uuid::from_u128(1);
    const OTHER_EVENT: Uuid = Uuid::from_u128(2);

    fn events() -> Vec<ScopeEvent> {
        vec![
            ScopeEvent {
                id: EVENT,
                start: at("2026-07-04T06:00:00Z"),
                end: at("2026-07-07T06:00:00Z"),
            },
            ScopeEvent {
                id: OTHER_EVENT,
                start: at("2026-07-10T06:00:00Z"),
                end: at("2026-07-11T06:00:00Z"),
            },
        ]
    }

    fn window(event_id: Uuid, kind: WindowKind, start: &str, end: &str) -> Window {
        Window {
            event_id,
            kind,
            start: at(start),
            end: at(end),
        }
    }

    fn available(start: &str, end: &str) -> Window {
        window(EVENT, WindowKind::Available, start, end)
    }

    /// One question with id `0x100 | index`, and the answers keyed as the
    /// wire keys them.
    fn run(
        drafts: &[QuestionDraft],
        answers: &[(usize, Answer)],
        windows: &[Window],
    ) -> Vec<(String, Code)> {
        let asked: Vec<Asked<'_>> = drafts
            .iter()
            .enumerate()
            .map(|(index, question)| Asked {
                id: id_of(index),
                question,
            })
            .collect();
        let answers = answers
            .iter()
            .map(|(index, answer)| (id_of(*index).to_string(), answer.clone()))
            .collect();
        let mut out: Vec<(String, Code)> = validate(&asked, &events(), &answers, windows)
            .into_iter()
            .map(|refusal| (refusal.field, refusal.code))
            .collect();
        out.sort();
        out
    }

    fn id_of(index: usize) -> Uuid {
        Uuid::from_u128(0x100 | u128::try_from(index).expect("small"))
    }

    fn codes(
        drafts: &[QuestionDraft],
        answers: &[(usize, Answer)],
        windows: &[Window],
    ) -> Vec<Code> {
        run(drafts, answers, windows)
            .into_iter()
            .map(|(_, code)| code)
            .collect()
    }

    fn text(value: &str) -> Answer {
        Answer::Text(value.to_owned())
    }

    #[test]
    fn a_complete_submission_passes() {
        let drafts = [
            question(QuestionKind::Section, false),
            question(QuestionKind::ShortText, true),
            question(QuestionKind::Email, true),
            question(QuestionKind::Phone, false),
            question(QuestionKind::Availability, true),
            question(QuestionKind::Missions, false),
            question(QuestionKind::Consent, true),
        ];
        let answers = [
            (1, text("Ada")),
            (2, text("ada@example.org")),
            (3, text("")),
            (5, Answer::List(vec!["bar".to_owned()])),
            (6, Answer::Flag(true)),
        ];
        let windows = [available("2026-07-04T08:00:00Z", "2026-07-04T12:00:00Z")];
        assert_eq!(run(&drafts, &answers, &windows), vec![]);
    }

    #[test]
    fn a_missing_required_answer_is_named_by_its_question() {
        let drafts = [question(QuestionKind::ShortText, true)];
        assert_eq!(
            run(&drafts, &[], &[]),
            vec![(format!("answers.{}", id_of(0)), Code::Required)]
        );
        assert_eq!(
            codes(&drafts, &[(0, text("   "))], &[]),
            vec![Code::Required]
        );
        assert_eq!(
            codes(&drafts, &[(0, Answer::Null)], &[]),
            vec![Code::Required]
        );
    }

    #[test]
    fn an_optional_question_may_be_blank_or_absent() {
        for kind in [
            QuestionKind::ShortText,
            QuestionKind::Email,
            QuestionKind::Date,
            QuestionKind::SingleChoice,
        ] {
            let drafts = [question(kind, false)];
            assert_eq!(codes(&drafts, &[(0, text(""))], &[]), vec![], "{kind:?}");
            assert_eq!(codes(&drafts, &[], &[]), vec![], "{kind:?}");
        }
        let drafts = [question(QuestionKind::MultiChoice, false)];
        assert_eq!(codes(&drafts, &[(0, Answer::List(vec![]))], &[]), vec![]);
    }

    #[test]
    fn a_required_list_needs_one_entry_and_a_required_boolean_needs_an_answer() {
        let list = [question(QuestionKind::MultiChoice, true)];
        assert_eq!(
            codes(&list, &[(0, Answer::List(vec![]))], &[]),
            vec![Code::Required]
        );
        let flag = [question(QuestionKind::Boolean, true)];
        assert_eq!(
            codes(&flag, &[(0, Answer::Null)], &[]),
            vec![Code::Required]
        );
        assert_eq!(codes(&flag, &[(0, Answer::Flag(false))], &[]), vec![]);
    }

    #[test]
    fn the_processing_consent_and_commitment_must_be_given_even_if_stored_as_optional() {
        let mut consent = question(QuestionKind::Consent, false);
        assert_eq!(
            codes(
                std::slice::from_ref(&consent),
                &[(0, Answer::Flag(false))],
                &[]
            ),
            vec![Code::ConsentRequired]
        );
        assert_eq!(
            codes(std::slice::from_ref(&consent), &[], &[]),
            vec![Code::ConsentRequired]
        );
        assert_eq!(
            codes(
                std::slice::from_ref(&consent),
                &[(0, Answer::Flag(true))],
                &[]
            ),
            vec![]
        );

        // So is the volunteer commitment (ADR-0040).
        consent.consent_purpose = Some(ConsentPurpose::Commitment);
        assert_eq!(
            codes(
                std::slice::from_ref(&consent),
                &[(0, Answer::Flag(false))],
                &[]
            ),
            vec![Code::ConsentRequired]
        );
        assert_eq!(
            codes(std::slice::from_ref(&consent), &[], &[]),
            vec![Code::ConsentRequired]
        );

        // The pool consent is optional, and refusing it is an answer.
        consent.consent_purpose = Some(ConsentPurpose::PoolRetention);
        assert_eq!(
            codes(
                std::slice::from_ref(&consent),
                &[(0, Answer::Flag(false))],
                &[]
            ),
            vec![]
        );
    }

    #[test]
    fn a_value_of_the_wrong_type_is_refused_per_field() {
        let drafts = [
            question(QuestionKind::ShortText, false),
            question(QuestionKind::MultiChoice, false),
            question(QuestionKind::Boolean, false),
            question(QuestionKind::Consent, false),
            question(QuestionKind::Section, false),
            question(QuestionKind::Availability, false),
        ];
        let answers = [
            (0, Answer::Flag(true)),
            (1, text("bar")),
            (2, text("yes")),
            (3, Answer::Other),
            (4, text("hello")),
            (5, Answer::List(vec![])),
        ];
        assert_eq!(codes(&drafts, &answers, &[]), vec![Code::WrongType; 6]);
    }

    #[test]
    fn an_answer_to_no_question_of_this_version_is_refused() {
        let drafts = [question(QuestionKind::ShortText, false)];
        let asked = [Asked {
            id: id_of(0),
            question: &drafts[0],
        }];
        let answers = BTreeMap::from([
            (Uuid::from_u128(999).to_string(), text("x")),
            ("not-a-uuid".to_owned(), text("x")),
        ]);
        let refusals = validate(&asked, &events(), &answers, &[]);
        assert_eq!(refusals.len(), 2);
        assert!(
            refusals
                .iter()
                .all(|refusal| refusal.code == Code::UnknownQuestion)
        );
    }

    #[test]
    fn email_phone_and_date_are_checked_as_loosely_as_the_bundle_checks_them() {
        let email = [question(QuestionKind::Email, true)];
        for good in ["a@b.co", "prénom.nom+tag@example.fr"] {
            assert_eq!(codes(&email, &[(0, text(good))], &[]), vec![], "{good}");
        }
        for bad in ["a@b", "a@.b", "a@b.", "@b.co", "a b@c.de", "a@b@c.de"] {
            assert_eq!(
                codes(&email, &[(0, text(bad))], &[]),
                vec![Code::InvalidEmail],
                "{bad}"
            );
        }

        let phone = [question(QuestionKind::Phone, true)];
        for good in ["+33 6 12 34 56 78", "(06) 12-34-56", "061234"] {
            assert_eq!(codes(&phone, &[(0, text(good))], &[]), vec![], "{good}");
        }
        for bad in ["12345", "06 12 34 56 78 ext 2", "+123456789012345678"] {
            assert_eq!(
                codes(&phone, &[(0, text(bad))], &[]),
                vec![Code::InvalidPhone],
                "{bad}"
            );
        }

        let date = [question(QuestionKind::Date, true)];
        assert_eq!(codes(&date, &[(0, text("2026-02-28"))], &[]), vec![]);
        for bad in ["2026-02-30", "2026-2-28", "28/02/2026", "2026-02-28T00:00"] {
            assert_eq!(
                codes(&date, &[(0, text(bad))], &[]),
                vec![Code::InvalidDate],
                "{bad}"
            );
        }
    }

    #[test]
    fn a_choice_must_be_one_of_the_options() {
        let single = [question(QuestionKind::SingleChoice, true)];
        assert_eq!(codes(&single, &[(0, text("bar"))], &[]), vec![]);
        assert_eq!(
            codes(&single, &[(0, text("cuisine"))], &[]),
            vec![Code::UnknownOption]
        );
        let multi = [question(QuestionKind::Missions, false)];
        assert_eq!(
            codes(
                &multi,
                &[(0, Answer::List(vec!["bar".to_owned(), "nope".to_owned()]))],
                &[]
            ),
            vec![Code::UnknownOption]
        );
    }

    #[test]
    fn text_and_lists_are_bounded() {
        let short = [question(QuestionKind::ShortText, false)];
        assert_eq!(
            codes(&short, &[(0, text(&"é".repeat(MAX_SHORT_TEXT)))], &[]),
            vec![]
        );
        assert_eq!(
            codes(&short, &[(0, text(&"é".repeat(MAX_SHORT_TEXT + 1)))], &[]),
            vec![Code::TooLong]
        );
        let long = [question(QuestionKind::LongText, false)];
        assert_eq!(
            codes(&long, &[(0, text(&"x".repeat(MAX_SHORT_TEXT + 1)))], &[]),
            vec![]
        );
        assert_eq!(
            codes(&long, &[(0, text(&"x".repeat(MAX_LONG_TEXT + 1)))], &[]),
            vec![Code::TooLong]
        );
        let multi = [question(QuestionKind::MultiChoice, false)];
        assert_eq!(
            codes(
                &multi,
                &[(0, Answer::List(vec!["bar".to_owned(); MAX_CHOICES + 1]))],
                &[]
            ),
            vec![Code::TooMany]
        );
    }

    #[test]
    fn required_availability_needs_one_available_window() {
        let drafts = [question(QuestionKind::Availability, true)];
        assert_eq!(codes(&drafts, &[], &[]), vec![Code::Required]);
        let unavailable = [window(
            EVENT,
            WindowKind::Unavailable,
            "2026-07-04T06:00:00Z",
            "2026-07-05T06:00:00Z",
        )];
        assert_eq!(codes(&drafts, &[], &unavailable), vec![Code::Required]);
        let windows = [available("2026-07-04T06:00:00Z", "2026-07-05T06:00:00Z")];
        assert_eq!(codes(&drafts, &[], &windows), vec![]);
    }

    #[test]
    fn availability_sent_to_a_version_that_does_not_ask_is_refused() {
        let drafts = [question(QuestionKind::ShortText, false)];
        let windows = [available("2026-07-04T08:00:00Z", "2026-07-04T12:00:00Z")];
        assert_eq!(
            run(&drafts, &[], &windows),
            vec![("availability".to_owned(), Code::NotAsked)]
        );
    }

    #[test]
    fn a_window_must_be_forward_in_scope_and_inside_its_own_event() {
        let drafts = [question(QuestionKind::Availability, false)];
        let windows = [
            // exactly the period: fine, bounds are inclusive of the period's own
            available("2026-07-04T06:00:00Z", "2026-07-07T06:00:00Z"),
            available("2026-07-05T12:00:00Z", "2026-07-05T12:00:00Z"),
            available("2026-07-06T12:00:00Z", "2026-07-06T10:00:00Z"),
            available("2026-07-04T05:59:00Z", "2026-07-04T08:00:00Z"),
            available("2026-07-06T20:00:00Z", "2026-07-07T06:01:00Z"),
            // inside the *other* event's period is outside this one's
            available("2026-07-10T08:00:00Z", "2026-07-10T09:00:00Z"),
            window(
                Uuid::from_u128(3),
                WindowKind::Available,
                "2026-07-04T08:00:00Z",
                "2026-07-04T09:00:00Z",
            ),
        ];
        assert_eq!(
            run(&drafts, &[], &windows),
            vec![
                ("availability[1]".to_owned(), Code::Inverted),
                ("availability[2]".to_owned(), Code::Inverted),
                ("availability[3]".to_owned(), Code::OutsideEvent),
                ("availability[4]".to_owned(), Code::OutsideEvent),
                ("availability[5]".to_owned(), Code::OutsideEvent),
                ("availability[6]".to_owned(), Code::UnknownEvent),
            ]
        );
    }

    #[test]
    fn overlapping_windows_of_one_event_are_refused_and_touching_ones_are_not() {
        let drafts = [question(QuestionKind::Availability, false)];
        let touching = [
            available("2026-07-04T12:00:00Z", "2026-07-04T18:00:00Z"),
            available("2026-07-04T08:00:00Z", "2026-07-04T12:00:00Z"),
            window(
                EVENT,
                WindowKind::Unavailable,
                "2026-07-04T18:00:00Z",
                "2026-07-05T06:00:00Z",
            ),
            // the same hours at another event are that event's business
            window(
                OTHER_EVENT,
                WindowKind::Available,
                "2026-07-10T08:00:00Z",
                "2026-07-10T12:00:00Z",
            ),
        ];
        assert_eq!(codes(&drafts, &[], &touching), vec![]);

        let overlapping = [
            available("2026-07-04T08:00:00Z", "2026-07-04T20:00:00Z"),
            // an unavailable window inside an available one is a contradiction
            window(
                EVENT,
                WindowKind::Unavailable,
                "2026-07-04T10:00:00Z",
                "2026-07-04T11:00:00Z",
            ),
            // overlaps the first, not the second: `reach` is the furthest end
            available("2026-07-04T19:00:00Z", "2026-07-04T22:00:00Z"),
        ];
        assert_eq!(
            run(&drafts, &[], &overlapping),
            vec![
                ("availability[1]".to_owned(), Code::Overlap),
                ("availability[2]".to_owned(), Code::Overlap),
            ]
        );
    }

    #[test]
    fn too_many_windows_is_one_refusal_not_five_hundred() {
        let drafts = [question(QuestionKind::Availability, false)];
        let windows =
            vec![available("2026-07-04T08:00:00Z", "2026-07-04T09:00:00Z"); MAX_WINDOWS + 1];
        assert_eq!(
            run(&drafts, &[], &windows),
            vec![("availability".to_owned(), Code::TooMany)]
        );
    }
}
