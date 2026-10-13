// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! A first-party form submission, read back from its stored payload and
//! mapped onto the volunteer it describes (docs/08 §9).
//!
//! The payload is the object `evp_api::public_form` stored —
//! `{form_version_id, locale, answers: {question id: value}, availability:
//! [{event_id, kind, start, end}], elapsed_ms}` — and the questions are those
//! of the version it pinned. It was validated against exactly those questions
//! before it was stored, so a payload that will not parse here is a broken
//! invariant, not a volunteer's mistake: [`MapError`] says so rather than
//! guessing.

use std::collections::BTreeMap;

use evp_domain::form::{ConsentPurpose, TSHIRT_SIZES, TargetPath};
use evp_domain::submission::{Answer, Asked, Window, WindowKind};
use uuid::Uuid;

/// Why a stored payload could not be mapped.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MapError {
    /// The payload is not the object the public route stores.
    #[error("the stored payload is not a form submission: {0}")]
    Malformed(&'static str),
    /// Nothing answered the `first_name` question, which publish requires
    /// (ADR-0037) — so no name to give the volunteer.
    #[error("the submission has no first name")]
    NoFirstName,
}

/// The parts of a stored payload that reconciliation reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPayload {
    /// Question id → the answer, as it arrived.
    pub answers: BTreeMap<String, Answer>,
    pub windows: Vec<Window>,
}

/// Reads the object [`StoredPayload`] describes.
///
/// # Errors
///
/// [`MapError::Malformed`] for anything else.
pub fn parse_payload(raw: &serde_json::Value) -> Result<StoredPayload, MapError> {
    let object = raw
        .as_object()
        .ok_or(MapError::Malformed("not an object"))?;
    let answers = match object.get("answers") {
        None | Some(serde_json::Value::Null) => BTreeMap::new(),
        Some(serde_json::Value::Object(answers)) => answers
            .iter()
            .map(|(key, value)| (key.clone(), Answer::from_json(value)))
            .collect(),
        Some(_) => return Err(MapError::Malformed("answers is not an object")),
    };
    let windows = match object.get("availability") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(windows)) => {
            windows.iter().map(parse_window).collect::<Result<_, _>>()?
        }
        Some(_) => return Err(MapError::Malformed("availability is not a list")),
    };
    Ok(StoredPayload { answers, windows })
}

fn parse_window(raw: &serde_json::Value) -> Result<Window, MapError> {
    let text = |field: &str| raw.get(field).and_then(serde_json::Value::as_str);
    let event_id = text("event_id")
        .and_then(|id| id.parse::<Uuid>().ok())
        .ok_or(MapError::Malformed("a window has no event id"))?;
    let kind = match text("kind") {
        Some("available") => WindowKind::Available,
        Some("unavailable") => WindowKind::Unavailable,
        _ => return Err(MapError::Malformed("a window has no kind")),
    };
    let start = text("start")
        .and_then(|start| start.parse().ok())
        .ok_or(MapError::Malformed("a window has no start"))?;
    let end = text("end")
        .and_then(|end| end.parse().ok())
        .ok_or(MapError::Malformed("a window has no end"))?;
    Ok(Window {
        event_id,
        kind,
        start,
        end,
    })
}

/// The volunteer columns a submission speaks for. `None` is "the form did not
/// say": not asked, or left blank — never "clear what is there".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VolunteerFields {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    /// Trimmed and lowercased ([`normalise_email`]).
    pub email: Option<String>,
    pub phone: Option<String>,
    /// One of [`TSHIRT_SIZES`], spelled as the `CHECK` spells it.
    pub tshirt_size: Option<String>,
    pub dietary: Option<String>,
    pub notes: Option<String>,
}

/// Everything a submission would write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Derived {
    pub volunteer: VolunteerFields,
    /// For a volunteer created from this submission; a matched volunteer keeps
    /// the roster label they have (ADR-0012: it is the coordinator's to edit).
    pub display_name: String,
    /// The `pool_retention` consent was given (ADR-0025). `false` is "not
    /// given this time", which never withdraws one given before.
    pub pool_consent: bool,
    pub windows: Vec<Window>,
}

/// Maps `payload` through the `target_path` and `consent_purpose` of the
/// questions it answered.
///
/// # Errors
///
/// [`MapError::NoFirstName`] when the first-name question was not answered.
pub fn derive(questions: &[Asked<'_>], payload: &StoredPayload) -> Result<Derived, MapError> {
    let mut volunteer = VolunteerFields::default();
    let mut pool_consent = false;
    for asked in questions {
        let Some(answer) = payload.answers.get(&asked.id.to_string()) else {
            continue;
        };
        if asked.question.consent_purpose == Some(ConsentPurpose::PoolRetention) {
            pool_consent = *answer == Answer::Flag(true);
        }
        let Some(target) = asked.question.target_path else {
            continue;
        };
        let Some(text) = text_of(answer) else {
            continue;
        };
        let slot = match target {
            TargetPath::FirstName => &mut volunteer.first_name,
            TargetPath::LastName => &mut volunteer.last_name,
            TargetPath::Email => &mut volunteer.email,
            TargetPath::Phone => &mut volunteer.phone,
            TargetPath::TshirtSize => &mut volunteer.tshirt_size,
            TargetPath::Dietary => &mut volunteer.dietary,
            TargetPath::Notes => &mut volunteer.notes,
        };
        *slot = match target {
            TargetPath::Email => normalise_email(text),
            TargetPath::TshirtSize => tshirt_size(text),
            TargetPath::FirstName
            | TargetPath::LastName
            | TargetPath::Phone
            | TargetPath::Dietary
            | TargetPath::Notes => Some(text.to_owned()),
        };
    }
    let first_name = volunteer
        .first_name
        .as_deref()
        .ok_or(MapError::NoFirstName)?;
    let display_name = display_name(first_name, volunteer.last_name.as_deref());
    Ok(Derived {
        volunteer,
        display_name,
        pool_consent,
        windows: payload.windows.clone(),
    })
}

/// The answer as one trimmed line of text, when it says something.
fn text_of(answer: &Answer) -> Option<&str> {
    match answer {
        Answer::Text(text) => Some(text.trim()).filter(|text| !text.is_empty()),
        Answer::Flag(_) | Answer::List(_) | Answer::Null | Answer::Other => None,
    }
}

/// docs/08 §6: trim and lowercase, and nothing more. Gmail's dot and plus
/// equivalence is a guess about one provider, not a property of addresses.
#[must_use]
pub fn normalise_email(text: &str) -> Option<String> {
    Some(text.trim().to_lowercase()).filter(|email| !email.is_empty())
}

/// ADR-0012: `first_name || ' ' || last_name` when the form supplied both,
/// the first name alone for a mononym.
#[must_use]
pub fn display_name(first_name: &str, last_name: Option<&str>) -> String {
    let first_name = first_name.trim();
    match last_name.map(str::trim).filter(|last| !last.is_empty()) {
        Some(last_name) => format!("{first_name} {last_name}"),
        None => first_name.to_owned(),
    }
}

/// A size the column accepts, whatever its case; anything else is dropped
/// rather than refused, because the rest of the submission is still good.
fn tshirt_size(text: &str) -> Option<String> {
    TSHIRT_SIZES
        .iter()
        .find(|size| size.eq_ignore_ascii_case(text))
        .map(|size| (*size).to_owned())
}

#[cfg(test)]
mod tests {
    use evp_domain::form::{Localized, QuestionDraft, QuestionKind};
    use rstest::rstest;
    use serde_json::json;

    use super::*;

    fn question(kind: QuestionKind, target: Option<TargetPath>) -> QuestionDraft {
        QuestionDraft {
            kind,
            target_path: target,
            consent_purpose: None,
            label: Localized::fr("Question"),
            help_text: None,
            options: None,
            is_required: false,
            is_sensitive: false,
        }
    }

    fn consent(purpose: ConsentPurpose) -> QuestionDraft {
        QuestionDraft {
            consent_purpose: Some(purpose),
            ..question(QuestionKind::Consent, None)
        }
    }

    /// The seeded identity questions plus a size and a pool consent, each
    /// with a fixed id, and a payload answering them from `answers`.
    struct Form {
        drafts: Vec<(Uuid, QuestionDraft)>,
    }

    impl Form {
        fn new() -> Self {
            let drafts = (1_u128..)
                .zip([
                    question(QuestionKind::ShortText, Some(TargetPath::FirstName)),
                    question(QuestionKind::ShortText, Some(TargetPath::LastName)),
                    question(QuestionKind::Email, Some(TargetPath::Email)),
                    question(QuestionKind::Phone, Some(TargetPath::Phone)),
                    question(QuestionKind::ShortText, Some(TargetPath::TshirtSize)),
                    question(QuestionKind::LongText, Some(TargetPath::Dietary)),
                    question(QuestionKind::LongText, Some(TargetPath::Notes)),
                    consent(ConsentPurpose::Processing),
                    consent(ConsentPurpose::PoolRetention),
                    question(QuestionKind::ShortText, None),
                ])
                .map(|(index, draft)| (Uuid::from_u128(index), draft))
                .collect();
            Self { drafts }
        }

        fn asked(&self) -> Vec<Asked<'_>> {
            self.drafts
                .iter()
                .map(|(id, question)| Asked { id: *id, question })
                .collect()
        }

        /// The id of question `index` (1-based, in [`Self::new`]'s order).
        fn id(index: u128) -> String {
            Uuid::from_u128(index).to_string()
        }

        fn derive(&self, answers: &serde_json::Value) -> Result<Derived, MapError> {
            let payload = parse_payload(&json!({ "answers": answers, "availability": [] }))?;
            derive(&self.asked(), &payload)
        }
    }

    #[test]
    fn every_target_lands_in_its_column() {
        let derived = Form::new()
            .derive(&json!({
                Form::id(1): "  Ada ",
                Form::id(2): "Lovelace",
                Form::id(3): " Ada@Example.ORG ",
                Form::id(4): "06 12 34 56 78",
                Form::id(5): "m",
                Form::id(6): "Végétarienne",
                Form::id(7): "Arrive vendredi",
                Form::id(8): true,
                Form::id(9): true,
                Form::id(10): "not a volunteer column",
            }))
            .unwrap();
        assert_eq!(
            derived.volunteer,
            VolunteerFields {
                first_name: Some("Ada".to_owned()),
                last_name: Some("Lovelace".to_owned()),
                email: Some("ada@example.org".to_owned()),
                phone: Some("06 12 34 56 78".to_owned()),
                tshirt_size: Some("M".to_owned()),
                dietary: Some("Végétarienne".to_owned()),
                notes: Some("Arrive vendredi".to_owned()),
            }
        );
        assert_eq!(derived.display_name, "Ada Lovelace");
        assert!(derived.pool_consent);
    }

    #[test]
    fn a_mononym_is_its_own_display_name_and_blanks_are_absent() {
        let derived = Form::new()
            .derive(&json!({
                Form::id(1): "Gibson",
                Form::id(2): "   ",
                Form::id(3): "gibson@example.org",
                Form::id(4): "",
                Form::id(5): null,
            }))
            .unwrap();
        assert_eq!(derived.display_name, "Gibson");
        assert_eq!(derived.volunteer.last_name, None);
        assert_eq!(derived.volunteer.phone, None);
        assert_eq!(derived.volunteer.tshirt_size, None);
    }

    #[rstest]
    #[case::refused_pool_consent(json!(false), false)]
    #[case::unanswered_pool_consent(json!(null), false)]
    #[case::given_pool_consent(json!(true), true)]
    fn pool_consent_is_only_a_tick(#[case] answer: serde_json::Value, #[case] expected: bool) {
        let derived = Form::new()
            .derive(&json!({ Form::id(1): "Ada", Form::id(9): answer }))
            .unwrap();
        assert_eq!(derived.pool_consent, expected);
    }

    #[rstest]
    #[case::lower("xl", Some("XL"))]
    #[case::digit_size("3xl", Some("3XL"))]
    #[case::exact("XS", Some("XS"))]
    #[case::not_a_size("Large", None)]
    #[case::nearly("XXXL", None)]
    fn a_tshirt_size_is_kept_only_when_the_column_accepts_it(
        #[case] answer: &str,
        #[case] expected: Option<&str>,
    ) {
        let derived = Form::new()
            .derive(&json!({ Form::id(1): "Ada", Form::id(5): answer }))
            .unwrap();
        assert_eq!(derived.volunteer.tshirt_size.as_deref(), expected);
    }

    #[test]
    fn no_first_name_is_refused_rather_than_invented() {
        assert_eq!(
            Form::new().derive(&json!({ Form::id(1): "  " })),
            Err(MapError::NoFirstName)
        );
    }

    #[rstest]
    #[case::trims_and_lowers(" J.Dupont+Fest@Gmail.COM ", Some("j.dupont+fest@gmail.com"))]
    #[case::blank("   ", None)]
    fn an_email_is_trimmed_and_lowercased_only(#[case] text: &str, #[case] expected: Option<&str>) {
        assert_eq!(normalise_email(text).as_deref(), expected);
    }

    #[test]
    fn the_stored_payload_reads_back_answers_and_windows() {
        let event = Uuid::from_u128(7);
        let payload = parse_payload(&json!({
            "form_version_id": Uuid::from_u128(1),
            "locale": "fr",
            "answers": { "a": "Ada", "b": true, "c": ["x", "y"], "d": null },
            "availability": [
                { "event_id": event, "kind": "available",
                  "start": "2026-07-04T08:00:00Z", "end": "2026-07-04T14:00:00Z" },
                { "event_id": event, "kind": "unavailable",
                  "start": "2026-07-05T08:00:00Z", "end": "2026-07-05T10:00:00Z" }
            ],
            "elapsed_ms": 45_000
        }))
        .unwrap();
        assert_eq!(payload.answers["a"], Answer::Text("Ada".to_owned()));
        assert_eq!(payload.answers["b"], Answer::Flag(true));
        assert_eq!(
            payload.answers["c"],
            Answer::List(vec!["x".to_owned(), "y".to_owned()])
        );
        assert_eq!(payload.answers["d"], Answer::Null);
        assert_eq!(
            payload.windows,
            vec![
                Window {
                    event_id: event,
                    kind: WindowKind::Available,
                    start: "2026-07-04T08:00:00Z".parse().unwrap(),
                    end: "2026-07-04T14:00:00Z".parse().unwrap(),
                },
                Window {
                    event_id: event,
                    kind: WindowKind::Unavailable,
                    start: "2026-07-05T08:00:00Z".parse().unwrap(),
                    end: "2026-07-05T10:00:00Z".parse().unwrap(),
                },
            ]
        );
    }

    #[rstest]
    #[case::array_payload(json!([{ "question": "Nom", "value": "Ada" }]))]
    #[case::answers_not_an_object(json!({ "answers": ["Ada"] }))]
    #[case::availability_not_a_list(json!({ "availability": {} }))]
    #[case::window_without_event(json!({ "availability": [
        { "kind": "available", "start": "2026-07-04T08:00:00Z", "end": "2026-07-04T14:00:00Z" }
    ] }))]
    #[case::window_with_unknown_kind(json!({ "availability": [
        { "event_id": Uuid::from_u128(1), "kind": "maybe",
          "start": "2026-07-04T08:00:00Z", "end": "2026-07-04T14:00:00Z" }
    ] }))]
    #[case::window_with_bad_instant(json!({ "availability": [
        { "event_id": Uuid::from_u128(1), "kind": "available",
          "start": "tomorrow", "end": "2026-07-04T14:00:00Z" }
    ] }))]
    #[case::window_without_end(json!({ "availability": [
        { "event_id": Uuid::from_u128(1), "kind": "available", "start": "2026-07-04T08:00:00Z" }
    ] }))]
    fn anything_but_the_stored_object_is_malformed(#[case] raw: serde_json::Value) {
        assert!(matches!(parse_payload(&raw), Err(MapError::Malformed(_))));
    }

    #[test]
    fn a_payload_without_answers_or_availability_is_empty_not_malformed() {
        assert_eq!(
            parse_payload(&json!({ "answers": null })).unwrap(),
            StoredPayload {
                answers: BTreeMap::new(),
                windows: Vec::new(),
            }
        );
    }
}
