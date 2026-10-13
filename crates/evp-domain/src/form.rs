// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The first-party form's authoring rules (docs/03 §3.11, docs/04 §"The
//! volunteer form", docs/09).
//!
//! Two layers of validation, because the schema can say one of them and not
//! the other:
//!
//! * [`validate_draft`] is what `PUT …/versions/{v}` refuses. Every rule in it
//!   is something a `CHECK` or a partial unique index on `form_questions`
//!   would refuse anyway. It is stated here first so the refusal names the
//!   question (by position) instead of surfacing as a bare SQLSTATE, and so a
//!   client gets every problem at once rather than the first one PostgreSQL
//!   happened to hit.
//! * [`validate_publish`] adds the conditions on a *set* of rows that no
//!   constraint can express: exactly one required `processing` consent
//!   (ADR-0025), required `first_name` and `email` targets (ADR-0037), unique
//!   option values, missions options that still name a mission (ADR-0036),
//!   and every label present in the form's locales.
//!
//! Also here, because it is the other half of the `missions` question: the
//! fold that turns a scope's `locations` rows into mission options. It must
//! agree with `apps/admin/src/plan/missionCatalog.ts` byte for byte, or the
//! form would offer a mission the missions page shows under another name.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// `form_question_kind`: eleven answerable kinds plus `section` (docs/09 §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum QuestionKind {
    ShortText,
    LongText,
    Email,
    Phone,
    Date,
    SingleChoice,
    MultiChoice,
    Boolean,
    Availability,
    Missions,
    Consent,
    Section,
}

impl QuestionKind {
    pub const ALL: [Self; 12] = [
        Self::ShortText,
        Self::LongText,
        Self::Email,
        Self::Phone,
        Self::Date,
        Self::SingleChoice,
        Self::MultiChoice,
        Self::Boolean,
        Self::Availability,
        Self::Missions,
        Self::Consent,
        Self::Section,
    ];

    /// The enum label in PostgreSQL and on the wire.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ShortText => "short_text",
            Self::LongText => "long_text",
            Self::Email => "email",
            Self::Phone => "phone",
            Self::Date => "date",
            Self::SingleChoice => "single_choice",
            Self::MultiChoice => "multi_choice",
            Self::Boolean => "boolean",
            Self::Availability => "availability",
            Self::Missions => "missions",
            Self::Consent => "consent",
            Self::Section => "section",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// `form_question_options`: these kinds carry a list, every other kind
    /// carries none.
    #[must_use]
    pub fn takes_options(self) -> bool {
        matches!(
            self,
            Self::SingleChoice | Self::MultiChoice | Self::Missions
        )
    }

    /// Kinds whose answer has a destination of its own (a table, or the
    /// submission), so a `target_path` on them would be a second destination
    /// (`form_question_target`).
    #[must_use]
    pub fn has_own_destination(self) -> bool {
        matches!(
            self,
            Self::Section | Self::Availability | Self::Missions | Self::Consent
        )
    }
}

/// `consent_purpose` (ADR-0025, ADR-0040).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ConsentPurpose {
    Processing,
    PoolRetention,
    /// The volunteer confirms they take part unpaid, on the organisation's
    /// behalf. Required, exactly one per published version (ADR-0040).
    Commitment,
}

impl ConsentPurpose {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Processing => "processing",
            Self::PoolRetention => "pool_retention",
            Self::Commitment => "commitment",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Processing, Self::PoolRetention, Self::Commitment]
            .into_iter()
            .find(|purpose| purpose.as_str() == text)
    }
}

/// The volunteer columns a question may write (`form_question_target_known`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TargetPath {
    FirstName,
    LastName,
    Email,
    Phone,
    TshirtSize,
    Dietary,
    Notes,
}

impl TargetPath {
    pub const ALL: [Self; 7] = [
        Self::FirstName,
        Self::LastName,
        Self::Email,
        Self::Phone,
        Self::TshirtSize,
        Self::Dietary,
        Self::Notes,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstName => "volunteer.first_name",
            Self::LastName => "volunteer.last_name",
            Self::Email => "volunteer.email",
            Self::Phone => "volunteer.phone",
            Self::TshirtSize => "volunteer.tshirt_size",
            Self::Dietary => "volunteer.dietary",
            Self::Notes => "volunteer.notes",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|target| target.as_str() == text)
    }
}

/// What `volunteers.tshirt_size`'s `CHECK` accepts, in the same order. A
/// question targeting the column is free text or a choice the coordinator
/// wrote, so intake keeps only an answer that is one of these.
pub const TSHIRT_SIZES: [&str; 7] = ["XS", "S", "M", "L", "XL", "XXL", "3XL"];

/// The two locales a form can be written in (docs/09 §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Locale {
    Fr,
    En,
}

impl Locale {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fr => "fr",
            Self::En => "en",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Fr, Self::En]
            .into_iter()
            .find(|locale| locale.as_str() == text)
    }
}

/// `{"fr": "…", "en": "…"}`, as stored in `label`, `help_text` and each
/// option's `label`. French is structurally required: every form is written
/// in French first, and English is the optional second locale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Localized {
    pub fr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub en: Option<String>,
}

impl Localized {
    /// French only — what the seeded draft writes.
    #[must_use]
    pub fn fr(text: &str) -> Self {
        Self {
            fr: text.to_owned(),
            en: None,
        }
    }

    /// The text in `locale`, when it says something. A string of spaces is
    /// absent: rendering it would be a blank label on the volunteer's phone.
    #[must_use]
    pub fn get(&self, locale: Locale) -> Option<&str> {
        let text = match locale {
            Locale::Fr => Some(self.fr.as_str()),
            Locale::En => self.en.as_deref(),
        };
        text.filter(|text| !text.trim().is_empty())
    }
}

/// One entry of `options`. For a `missions` question, `value` is the folded
/// mission key ([`mission_key`]) and the list is frozen at publish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub value: String,
    pub label: Localized,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<Uuid>,
    /// `missions` only: the form offers this option already ticked. Taken
    /// from the zones by [`stamp_missions`], never from the client. Absent
    /// reads `false`, which is how every version frozen before the flag
    /// existed was offered.
    #[serde(default, skip_serializing_if = "is_false")]
    pub checked_by_default: bool,
    /// `missions` only: the mission is for volunteers aged 18 or over.
    /// Stamped like `checked_by_default`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub adults_only: bool,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's skip_serializing_if passes a reference"
)]
fn is_false(value: &bool) -> bool {
    !*value
}

/// A question as the coordinator writes it: everything but its id and
/// position, which are the version's (`QuestionInput` in docs/04).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionDraft {
    pub kind: QuestionKind,
    pub target_path: Option<TargetPath>,
    pub consent_purpose: Option<ConsentPurpose>,
    pub label: Localized,
    pub help_text: Option<Localized>,
    pub options: Option<Vec<QuestionOption>>,
    pub is_required: bool,
    pub is_sensitive: bool,
}

impl QuestionDraft {
    /// docs/09 §1 "Built-in and custom questions": built-in when the answer
    /// has a destination the planner understands. Derived, never stored, so
    /// it cannot disagree with the two columns it is derived from.
    #[must_use]
    pub fn is_builtin(&self) -> bool {
        self.target_path.is_some()
            || matches!(
                self.kind,
                QuestionKind::Availability | QuestionKind::Missions | QuestionKind::Consent
            )
    }
}

/// What a refusal is about. The string form is the `code` a client branches
/// on; the message beside it is prose and may be reworded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ProblemCode {
    // --- PUT: what a constraint would refuse anyway -----------------------
    LabelMissingFr,
    OptionsRequired,
    OptionsNotAllowed,
    TargetRequired,
    TargetNotAllowed,
    TargetKindMismatch,
    ConsentPurposeRequired,
    ConsentPurposeNotAllowed,
    PoolRetentionRequired,
    ScopeRequired,
    DuplicateTarget,
    DuplicateAvailability,
    DuplicateMissions,
    DuplicateConsentPurpose,
    // --- publish: conditions on the whole set ------------------------------
    ProcessingConsentMissing,
    ProcessingConsentOptional,
    CommitmentMissing,
    CommitmentOptional,
    FirstNameMissing,
    FirstNameOptional,
    EmailMissing,
    EmailOptional,
    OptionValueBlank,
    DuplicateOptionValue,
    MissionOptionUnresolved,
    LabelMissingLocale,
}

impl ProblemCode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LabelMissingFr => "label_missing_fr",
            Self::OptionsRequired => "options_required",
            Self::OptionsNotAllowed => "options_not_allowed",
            Self::TargetRequired => "target_required",
            Self::TargetNotAllowed => "target_not_allowed",
            Self::TargetKindMismatch => "target_kind_mismatch",
            Self::ConsentPurposeRequired => "consent_purpose_required",
            Self::ConsentPurposeNotAllowed => "consent_purpose_not_allowed",
            Self::PoolRetentionRequired => "pool_retention_required",
            Self::ScopeRequired => "scope_required",
            Self::DuplicateTarget => "duplicate_target",
            Self::DuplicateAvailability => "duplicate_availability",
            Self::DuplicateMissions => "duplicate_missions",
            Self::DuplicateConsentPurpose => "duplicate_consent_purpose",
            Self::ProcessingConsentMissing => "processing_consent_missing",
            Self::ProcessingConsentOptional => "processing_consent_optional",
            Self::CommitmentMissing => "commitment_missing",
            Self::CommitmentOptional => "commitment_optional",
            Self::FirstNameMissing => "first_name_missing",
            Self::FirstNameOptional => "first_name_optional",
            Self::EmailMissing => "email_missing",
            Self::EmailOptional => "email_optional",
            Self::OptionValueBlank => "option_value_blank",
            Self::DuplicateOptionValue => "duplicate_option_value",
            Self::MissionOptionUnresolved => "mission_option_unresolved",
            Self::LabelMissingLocale => "label_missing_locale",
        }
    }
}

/// One refusal. `position` is the question's index in the submitted list
/// (which is also its stored `position`), or `None` for an omission that no
/// single question is responsible for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub position: Option<usize>,
    pub code: ProblemCode,
    pub message: String,
}

fn at(position: usize, code: ProblemCode, message: impl Into<String>) -> Problem {
    Problem {
        position: Some(position),
        code,
        message: message.into(),
    }
}

/// The rules `PUT …/versions/{v}` enforces, in question order.
///
/// `scoped` is whether the form covers a festival or an event: an
/// `availability` or `missions` question on a pool-recruitment form has no
/// events to ask about (docs/03 §3.11).
#[must_use]
pub fn validate_draft(questions: &[QuestionDraft], scoped: bool) -> Vec<Problem> {
    let mut problems = Vec::new();
    let mut targets: BTreeMap<TargetPath, usize> = BTreeMap::new();
    let mut consents: BTreeMap<ConsentPurpose, usize> = BTreeMap::new();
    let mut availability: Option<usize> = None;
    let mut missions: Option<usize> = None;

    for (position, question) in questions.iter().enumerate() {
        check_labels_have_fr(position, question, &mut problems);
        check_shape(position, question, scoped, &mut problems);

        if let Some(target) = question.target_path
            && let Some(first) = targets.insert(target, position)
        {
            // Keep the first occurrence as the one "already there", so the
            // message points back at it.
            targets.insert(target, first);
            problems.push(at(
                position,
                ProblemCode::DuplicateTarget,
                format!(
                    "{} is already asked by the question at position {first}.",
                    target.as_str()
                ),
            ));
        }
        match question.kind {
            QuestionKind::Availability => {
                if let Some(first) = availability {
                    problems.push(at(
                        position,
                        ProblemCode::DuplicateAvailability,
                        format!(
                            "A form has one availability question; there is already one at \
                             position {first}."
                        ),
                    ));
                } else {
                    availability = Some(position);
                }
            }
            QuestionKind::Missions => {
                if let Some(first) = missions {
                    problems.push(at(
                        position,
                        ProblemCode::DuplicateMissions,
                        format!(
                            "A form has one missions question; there is already one at \
                             position {first}."
                        ),
                    ));
                } else {
                    missions = Some(position);
                }
            }
            QuestionKind::Consent => {
                if let Some(purpose) = question.consent_purpose {
                    if let Some(first) = consents.get(&purpose) {
                        problems.push(at(
                            position,
                            ProblemCode::DuplicateConsentPurpose,
                            format!(
                                "There is already a {} consent at position {first}.",
                                purpose.as_str()
                            ),
                        ));
                    } else {
                        consents.insert(purpose, position);
                    }
                }
            }
            QuestionKind::ShortText
            | QuestionKind::LongText
            | QuestionKind::Email
            | QuestionKind::Phone
            | QuestionKind::Date
            | QuestionKind::SingleChoice
            | QuestionKind::MultiChoice
            | QuestionKind::Boolean
            | QuestionKind::Section => {}
        }
    }
    problems
}

fn check_labels_have_fr(position: usize, question: &QuestionDraft, problems: &mut Vec<Problem>) {
    if question.label.get(Locale::Fr).is_none() {
        problems.push(at(
            position,
            ProblemCode::LabelMissingFr,
            "The question has no French label.",
        ));
    }
    if question
        .help_text
        .as_ref()
        .is_some_and(|help| help.get(Locale::Fr).is_none())
    {
        problems.push(at(
            position,
            ProblemCode::LabelMissingFr,
            "The help text has no French version; remove it or write one.",
        ));
    }
    if question.options.as_ref().is_some_and(|options| {
        options
            .iter()
            .any(|option| option.label.get(Locale::Fr).is_none())
    }) {
        problems.push(at(
            position,
            ProblemCode::LabelMissingFr,
            "An option has no French label.",
        ));
    }
}

/// The per-row `CHECK`s of `form_questions`, plus the ADR-0037 rule that an
/// `email` or `phone` question feeds exactly its own contact column.
fn check_shape(
    position: usize,
    question: &QuestionDraft,
    scoped: bool,
    problems: &mut Vec<Problem>,
) {
    let kind = question.kind;

    match (kind.takes_options(), question.options.is_some()) {
        (true, false) => problems.push(at(
            position,
            ProblemCode::OptionsRequired,
            format!("A {} question needs a list of options.", kind.as_str()),
        )),
        (false, true) => problems.push(at(
            position,
            ProblemCode::OptionsNotAllowed,
            format!("A {} question takes no options.", kind.as_str()),
        )),
        _ => {}
    }

    if kind.has_own_destination() && question.target_path.is_some() {
        problems.push(at(
            position,
            ProblemCode::TargetNotAllowed,
            format!(
                "A {} question has its own destination and takes no target_path.",
                kind.as_str()
            ),
        ));
    }

    // `email` and `phone` always feed the contact columns (ADR-0037): a
    // second phone number nobody can SMS is a trap, and so is a contact
    // column filled from a free-text box.
    for (contact_kind, contact_target) in [
        (QuestionKind::Email, TargetPath::Email),
        (QuestionKind::Phone, TargetPath::Phone),
    ] {
        let is_kind = kind == contact_kind;
        let is_target = question.target_path == Some(contact_target);
        if is_kind && question.target_path.is_none() {
            problems.push(at(
                position,
                ProblemCode::TargetRequired,
                format!(
                    "An {} question always targets {}.",
                    kind.as_str(),
                    contact_target.as_str()
                ),
            ));
        } else if is_kind != is_target {
            problems.push(at(
                position,
                ProblemCode::TargetKindMismatch,
                format!(
                    "{} is written only by a {} question.",
                    contact_target.as_str(),
                    contact_kind.as_str()
                ),
            ));
        }
    }

    match (kind == QuestionKind::Consent, question.consent_purpose) {
        (true, None) => problems.push(at(
            position,
            ProblemCode::ConsentPurposeRequired,
            "A consent question must say what it is consent for: processing, pool_retention or \
             commitment.",
        )),
        (false, Some(_)) => problems.push(at(
            position,
            ProblemCode::ConsentPurposeNotAllowed,
            "Only a consent question has a consent_purpose.",
        )),
        _ => {}
    }

    if question.consent_purpose == Some(ConsentPurpose::PoolRetention) && question.is_required {
        problems.push(at(
            position,
            ProblemCode::PoolRetentionRequired,
            "The pool-retention consent cannot be required: refusing it must not prevent \
             volunteering (ADR-0025).",
        ));
    }

    if !scoped && matches!(kind, QuestionKind::Availability | QuestionKind::Missions) {
        problems.push(at(
            position,
            ProblemCode::ScopeRequired,
            format!(
                "A {} question needs a form scoped to a festival or an event; this form has \
                 no events to ask about.",
                kind.as_str()
            ),
        ));
    }
}

/// What publishing needs to know beyond the questions themselves.
#[derive(Debug, Clone, Copy)]
pub struct PublishContext<'a> {
    /// The form covers a festival or an event.
    pub scoped: bool,
    /// The form's `default_locale`. French is always required; this adds a
    /// second locale every label must be written in.
    pub default_locale: Locale,
    /// The mission keys the scope has *now* ([`fold_missions`]). A `missions`
    /// option naming anything else would be an answer no location matches.
    pub mission_keys: &'a BTreeSet<String>,
}

/// Everything [`validate_draft`] refuses, plus the whole-set invariants
/// publish adds (docs/04 §"The volunteer form").
#[must_use]
pub fn validate_publish(questions: &[QuestionDraft], context: PublishContext<'_>) -> Vec<Problem> {
    let mut problems = validate_draft(questions, context.scoped);

    for (purpose, missing, optional, missing_message, optional_message) in [
        (
            ConsentPurpose::Processing,
            ProblemCode::ProcessingConsentMissing,
            ProblemCode::ProcessingConsentOptional,
            "A published form needs a processing consent question (ADR-0025).",
            "The processing consent must be required: without it the answers cannot be used \
             at all.",
        ),
        (
            ConsentPurpose::Commitment,
            ProblemCode::CommitmentMissing,
            ProblemCode::CommitmentOptional,
            "A published form needs a volunteer-commitment question (ADR-0040).",
            "The volunteer commitment must be required: it is what makes the volunteer's \
             help unpaid and on the organisation's behalf.",
        ),
    ] {
        let asked: Vec<(usize, &QuestionDraft)> = questions
            .iter()
            .enumerate()
            .filter(|(_, question)| {
                question.kind == QuestionKind::Consent && question.consent_purpose == Some(purpose)
            })
            .collect();
        if asked.is_empty() {
            problems.push(Problem {
                position: None,
                code: missing,
                message: missing_message.to_owned(),
            });
        }
        for (position, question) in asked {
            if !question.is_required {
                problems.push(at(position, optional, optional_message));
            }
        }
    }

    for (target, missing, optional, why) in [
        (
            TargetPath::FirstName,
            ProblemCode::FirstNameMissing,
            ProblemCode::FirstNameOptional,
            "greeting a volunteer needs a name",
        ),
        (
            TargetPath::Email,
            ProblemCode::EmailMissing,
            ProblemCode::EmailOptional,
            "the public form reconciles volunteers on their address",
        ),
    ] {
        let asked: Vec<(usize, &QuestionDraft)> = questions
            .iter()
            .enumerate()
            .filter(|(_, question)| question.target_path == Some(target))
            .collect();
        if asked.is_empty() {
            problems.push(Problem {
                position: None,
                code: missing,
                message: format!(
                    "A published form must ask {}: {why} (ADR-0037).",
                    target.as_str()
                ),
            });
        }
        for (position, question) in asked {
            if !question.is_required {
                problems.push(at(
                    position,
                    optional,
                    format!("{} must be required: {why}.", target.as_str()),
                ));
            }
        }
    }

    for (position, question) in questions.iter().enumerate() {
        check_options_for_publish(position, question, context, &mut problems);
        check_labels_in(position, question, context.default_locale, &mut problems);
    }

    problems
}

fn check_options_for_publish(
    position: usize,
    question: &QuestionDraft,
    context: PublishContext<'_>,
    problems: &mut Vec<Problem>,
) {
    let Some(options) = &question.options else {
        return;
    };
    let mut seen = BTreeSet::new();
    for option in options {
        if option.value.trim().is_empty() {
            problems.push(at(
                position,
                ProblemCode::OptionValueBlank,
                "An option has an empty value.",
            ));
            continue;
        }
        if !seen.insert(option.value.as_str()) {
            problems.push(at(
                position,
                ProblemCode::DuplicateOptionValue,
                format!(
                    "The value {:?} is used by two options of this question.",
                    option.value
                ),
            ));
        }
        if question.kind == QuestionKind::Missions && !context.mission_keys.contains(&option.value)
        {
            problems.push(at(
                position,
                ProblemCode::MissionOptionUnresolved,
                format!(
                    "The mission {:?} no longer matches any mission of this form's events.",
                    option.label.fr
                ),
            ));
        }
    }
}

/// French is checked by [`validate_draft`]; this adds the form's other
/// locale when it has one.
fn check_labels_in(
    position: usize,
    question: &QuestionDraft,
    locale: Locale,
    problems: &mut Vec<Problem>,
) {
    if locale == Locale::Fr {
        return;
    }
    let mut texts = vec![&question.label];
    texts.extend(question.help_text.as_ref());
    if let Some(options) = &question.options {
        texts.extend(options.iter().map(|option| &option.label));
    }
    if texts.iter().any(|text| text.get(locale).is_none()) {
        problems.push(at(
            position,
            ProblemCode::LabelMissingLocale,
            format!(
                "The form's default locale is {}, and this question has text with no {} \
                 version.",
                locale.as_str(),
                locale.as_str()
            ),
        ));
    }
}

// ---------------------------------------------------------------------------
// Missions (ADR-0036)
// ---------------------------------------------------------------------------

/// JavaScript's `String.prototype.trim` set: Unicode `White_Space` minus
/// U+0085, plus U+FEFF. `str::trim` differs on exactly those two, and the fold
/// has to agree with the admin app's to the character.
fn is_js_whitespace(character: char) -> bool {
    (character.is_whitespace() && character != '\u{0085}') || character == '\u{FEFF}'
}

/// The fold key: `name.trim().toLowerCase()`, as `missionKey` in
/// `apps/admin/src/plan/missionCatalog.ts`. Inner whitespace is kept as is —
/// "Bar 1" and "Bar  1" are two missions there, so they are two here.
#[must_use]
pub fn mission_key(name: &str) -> String {
    name.trim_matches(is_js_whitespace).to_lowercase()
}

/// One `locations` row in scope, as the fold needs it. The two flags are the
/// row's zone's: a post has none of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionRow {
    pub event_id: Uuid,
    pub name: String,
    pub checked_by_default: bool,
    pub adults_only: bool,
}

/// A mission the form can offer: the key, the first day's spelling, the
/// events it runs at, and how the form should offer it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissionOption {
    pub value: String,
    pub label: String,
    pub event_ids: Vec<Uuid>,
    /// Every row asks for it and none is adults-only. One technical "Son"
    /// among four days is enough to make the folded option opt-in. A box
    /// ticked for the easy days would also sign the volunteer up for the hard
    /// one.
    pub checked_by_default: bool,
    /// Any row says so, for the same reason.
    pub adults_only: bool,
}

/// Folds the scope's locations into missions, as `buildMissionCatalog` does.
///
/// `rows` must arrive in the order that function walks them: events
/// chronologically, and within an event each zone followed by its posts, in
/// the tree's own order. Every row counts — a zone that holds posts is a
/// mission in its own right. The label is the first row's spelling; the
/// result is sorted by key in UTF-16 code-unit order, which is what `<`
/// compares in JavaScript.
#[must_use]
pub fn fold_missions(rows: &[MissionRow]) -> Vec<MissionOption> {
    let mut folded: BTreeMap<String, MissionOption> = BTreeMap::new();
    for row in rows {
        let key = mission_key(&row.name);
        let option = folded.entry(key.clone()).or_insert_with(|| MissionOption {
            value: key,
            label: row.name.clone(),
            event_ids: Vec::new(),
            checked_by_default: true,
            adults_only: false,
        });
        if !option.event_ids.contains(&row.event_id) {
            option.event_ids.push(row.event_id);
        }
        option.adults_only |= row.adults_only;
        option.checked_by_default &= row.checked_by_default && !option.adults_only;
    }
    let mut missions: Vec<MissionOption> = folded.into_values().collect();
    missions.sort_by(|a, b| a.value.encode_utf16().cmp(b.value.encode_utf16()));
    missions
}

/// Sets every `missions` option's flags from the scope's missions as they
/// stand now, whatever the client sent. The zones are the only place the
/// coordinator decides these, so a draft cannot disagree with them. Called on
/// every draft write and again at publish, which is what freezes them.
///
/// An option that names no mission any more gets neither flag. Publishing
/// refuses it anyway (`mission_option_unresolved`).
pub fn stamp_missions(questions: &mut [QuestionDraft], missions: &[MissionOption]) {
    let options = questions
        .iter_mut()
        .filter(|question| question.kind == QuestionKind::Missions)
        .filter_map(|question| question.options.as_mut());
    for options in options {
        stamp_mission_options(options, missions);
    }
}

/// [`stamp_missions`] for one `missions` question's options, for a caller
/// that holds the stored options rather than a whole draft.
pub fn stamp_mission_options(options: &mut [QuestionOption], missions: &[MissionOption]) {
    for option in options {
        let mission = missions
            .iter()
            .find(|mission| mission.value == option.value);
        option.checked_by_default = mission.is_some_and(|mission| mission.checked_by_default);
        option.adults_only = mission.is_some_and(|mission| mission.adults_only);
    }
}

// ---------------------------------------------------------------------------
// The seeded draft
// ---------------------------------------------------------------------------

/// The volunteer-commitment question (ADR-0040), naming the organisation the
/// volunteer commits to. The name is written into the wording once, when the
/// question is created, and is the coordinator's to edit from then on like
/// any other label: a later rename of the organisation does not rewrite a
/// question volunteers have already answered.
#[must_use]
pub fn commitment_question(organization_name: &str) -> QuestionDraft {
    let name = organization_name.trim();
    QuestionDraft {
        kind: QuestionKind::Consent,
        target_path: None,
        consent_purpose: Some(ConsentPurpose::Commitment),
        label: Localized {
            fr: format!("Je confirme mon engagement bénévole auprès de {name} pour cet événement."),
            en: Some(format!(
                "I confirm my volunteer commitment to {name} for this event."
            )),
        },
        help_text: Some(Localized {
            fr: format!(
                "Je confirme participer bénévolement à l'organisation de cet événement pour le \
                 compte de l'association {name}, dans le cadre des missions qui me sont confiées."
            ),
            en: Some(format!(
                "I confirm that I am taking part, unpaid, in organising this event on behalf of \
                 the association {name}, within the missions entrusted to me."
            )),
        }),
        options: None,
        is_required: true,
        is_sensitive: false,
    }
}

/// Version 1 of a new form (docs/04 §"The seeded draft"): welcome copy, the
/// four identity questions, availability and missions when there are events
/// to ask about, the volunteer commitment and the processing consent.
///
/// Passes [`validate_publish`] as seeded, so a coordinator who changes
/// nothing can still publish.
#[must_use]
pub fn seed_draft(
    scoped: bool,
    missions: &[MissionOption],
    organization_name: &str,
) -> Vec<QuestionDraft> {
    let plain = |kind, label: &str| QuestionDraft {
        kind,
        target_path: None,
        consent_purpose: None,
        label: Localized::fr(label),
        help_text: None,
        options: None,
        is_required: false,
        is_sensitive: false,
    };

    let welcome = if scoped {
        "Merci de proposer ton aide ! Ce formulaire prend quelques minutes : dis-nous qui tu \
         es, quand tu es disponible et quelles missions tu pourrais faire."
    } else {
        "Merci de proposer ton aide ! Laisse-nous tes coordonnées et nous te contacterons pour \
         les prochains événements."
    };

    let mut questions = vec![
        QuestionDraft {
            help_text: Some(Localized::fr(welcome)),
            ..plain(QuestionKind::Section, "Bienvenue !")
        },
        QuestionDraft {
            target_path: Some(TargetPath::FirstName),
            help_text: Some(Localized::fr(
                "Ton prénom, ou le nom sous lequel on te connaît.",
            )),
            is_required: true,
            ..plain(QuestionKind::ShortText, "Comment veux-tu qu'on t'appelle ?")
        },
        QuestionDraft {
            target_path: Some(TargetPath::LastName),
            help_text: Some(Localized::fr(
                "Facultatif. Il nous aide à distinguer deux personnes qui portent le même prénom.",
            )),
            ..plain(QuestionKind::ShortText, "Nom de famille")
        },
        QuestionDraft {
            target_path: Some(TargetPath::Email),
            is_required: true,
            ..plain(QuestionKind::Email, "Adresse e-mail")
        },
        QuestionDraft {
            target_path: Some(TargetPath::Phone),
            ..plain(QuestionKind::Phone, "Numéro de téléphone")
        },
    ];

    if scoped {
        questions.push(QuestionDraft {
            is_required: true,
            ..plain(QuestionKind::Availability, "Quand es-tu disponible ?")
        });
        questions.push(QuestionDraft {
            help_text: Some(Localized::fr(
                "Coche toutes les missions que tu serais prêt·e à faire.",
            )),
            options: Some(
                missions
                    .iter()
                    .map(|mission| QuestionOption {
                        value: mission.value.clone(),
                        label: Localized::fr(&mission.label),
                        skill_id: None,
                        checked_by_default: mission.checked_by_default,
                        adults_only: mission.adults_only,
                    })
                    .collect(),
            ),
            ..plain(
                QuestionKind::Missions,
                "Quelles missions pourrais-tu faire ?",
            )
        });
    }

    questions.push(commitment_question(organization_name));
    questions.push(QuestionDraft {
        consent_purpose: Some(ConsentPurpose::Processing),
        is_required: true,
        ..plain(
            QuestionKind::Consent,
            "J'accepte que mes réponses servent à organiser les bénévoles de cet événement, et \
             que l'équipe me contacte à ce sujet par e-mail et par SMS.",
        )
    });

    questions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(kind: QuestionKind) -> QuestionDraft {
        QuestionDraft {
            kind,
            target_path: None,
            consent_purpose: None,
            label: Localized::fr("Question"),
            help_text: None,
            options: kind.takes_options().then(|| vec![option("a", "A")]),
            is_required: false,
            is_sensitive: false,
        }
    }

    fn option(value: &str, label: &str) -> QuestionOption {
        QuestionOption {
            value: value.to_owned(),
            label: Localized::fr(label),
            skill_id: None,
            checked_by_default: false,
            adults_only: false,
        }
    }

    fn targeted(kind: QuestionKind, target: TargetPath, required: bool) -> QuestionDraft {
        QuestionDraft {
            target_path: Some(target),
            is_required: required,
            ..question(kind)
        }
    }

    fn consent(purpose: ConsentPurpose, required: bool) -> QuestionDraft {
        QuestionDraft {
            consent_purpose: Some(purpose),
            is_required: required,
            ..question(QuestionKind::Consent)
        }
    }

    /// The smallest publishable form.
    fn minimal() -> Vec<QuestionDraft> {
        vec![
            targeted(QuestionKind::ShortText, TargetPath::FirstName, true),
            targeted(QuestionKind::Email, TargetPath::Email, true),
            consent(ConsentPurpose::Processing, true),
            consent(ConsentPurpose::Commitment, true),
        ]
    }

    /// [`minimal`] without the consent of `purpose`.
    fn minimal_without(purpose: ConsentPurpose) -> Vec<QuestionDraft> {
        minimal()
            .into_iter()
            .filter(|question| question.consent_purpose != Some(purpose))
            .collect()
    }

    fn codes(problems: &[Problem]) -> Vec<(Option<usize>, &'static str)> {
        problems
            .iter()
            .map(|problem| (problem.position, problem.code.as_str()))
            .collect()
    }

    fn no_missions() -> BTreeSet<String> {
        BTreeSet::new()
    }

    fn publish(questions: &[QuestionDraft], scoped: bool, keys: &BTreeSet<String>) -> Vec<Problem> {
        validate_publish(
            questions,
            PublishContext {
                scoped,
                default_locale: Locale::Fr,
                mission_keys: keys,
            },
        )
    }

    // --- round trips -------------------------------------------------------

    #[test]
    fn every_enum_round_trips_through_its_database_label() {
        for kind in QuestionKind::ALL {
            assert_eq!(QuestionKind::parse(kind.as_str()), Some(kind));
        }
        for target in TargetPath::ALL {
            assert_eq!(TargetPath::parse(target.as_str()), Some(target));
        }
        for purpose in [
            ConsentPurpose::Processing,
            ConsentPurpose::PoolRetention,
            ConsentPurpose::Commitment,
        ] {
            assert_eq!(ConsentPurpose::parse(purpose.as_str()), Some(purpose));
        }
        for locale in [Locale::Fr, Locale::En] {
            assert_eq!(Locale::parse(locale.as_str()), Some(locale));
        }
        assert_eq!(QuestionKind::parse("file_upload"), None);
        assert_eq!(TargetPath::parse("volunteer.birthdate"), None);
    }

    #[test]
    fn localized_omits_a_missing_english_on_the_wire() {
        let json = serde_json::to_value(Localized::fr("Bar")).unwrap();
        assert_eq!(json, serde_json::json!({ "fr": "Bar" }));
    }

    #[test]
    fn builtin_is_a_target_or_a_kind_with_its_own_table() {
        assert!(targeted(QuestionKind::ShortText, TargetPath::LastName, false).is_builtin());
        assert!(question(QuestionKind::Availability).is_builtin());
        assert!(question(QuestionKind::Missions).is_builtin());
        assert!(consent(ConsentPurpose::PoolRetention, false).is_builtin());
        assert!(!question(QuestionKind::ShortText).is_builtin());
        assert!(!question(QuestionKind::Section).is_builtin());
    }

    // --- PUT: passing -------------------------------------------------------

    #[test]
    fn a_minimal_form_passes_the_draft_rules() {
        assert!(validate_draft(&minimal(), false).is_empty());
    }

    #[test]
    fn a_draft_need_not_be_publishable() {
        // No consent, no email: fine to save, refused only at publish.
        assert!(validate_draft(&[question(QuestionKind::ShortText)], false).is_empty());
        assert!(validate_draft(&[], false).is_empty());
    }

    #[test]
    fn custom_questions_of_every_untargeted_kind_pass() {
        let questions: Vec<QuestionDraft> = [
            QuestionKind::ShortText,
            QuestionKind::LongText,
            QuestionKind::SingleChoice,
            QuestionKind::MultiChoice,
            QuestionKind::Boolean,
            QuestionKind::Date,
            QuestionKind::Section,
        ]
        .into_iter()
        .map(question)
        .collect();
        assert!(validate_draft(&questions, false).is_empty());
    }

    // --- PUT: failing, one per rule -----------------------------------------

    #[test]
    fn a_duplicate_target_names_the_second_position() {
        let questions = vec![
            targeted(QuestionKind::ShortText, TargetPath::FirstName, true),
            question(QuestionKind::Boolean),
            targeted(QuestionKind::ShortText, TargetPath::FirstName, false),
        ];
        assert_eq!(
            codes(&validate_draft(&questions, false)),
            vec![(Some(2), "duplicate_target")]
        );
    }

    #[test]
    fn a_third_question_on_one_target_is_also_named_against_the_first() {
        let questions = vec![
            targeted(QuestionKind::ShortText, TargetPath::Notes, false),
            targeted(QuestionKind::LongText, TargetPath::Notes, false),
            targeted(QuestionKind::LongText, TargetPath::Notes, false),
        ];
        let problems = validate_draft(&questions, false);
        assert_eq!(
            codes(&problems),
            vec![(Some(1), "duplicate_target"), (Some(2), "duplicate_target")]
        );
        assert!(
            problems
                .iter()
                .all(|problem| problem.message.contains("position 0"))
        );
    }

    #[test]
    fn a_second_availability_is_refused() {
        let questions = vec![
            question(QuestionKind::Availability),
            question(QuestionKind::Availability),
        ];
        assert_eq!(
            codes(&validate_draft(&questions, true)),
            vec![(Some(1), "duplicate_availability")]
        );
    }

    #[test]
    fn a_second_missions_is_refused() {
        let questions = vec![
            question(QuestionKind::Missions),
            question(QuestionKind::Missions),
        ];
        assert_eq!(
            codes(&validate_draft(&questions, true)),
            vec![(Some(1), "duplicate_missions")]
        );
    }

    #[test]
    fn a_second_consent_of_one_purpose_is_refused_but_one_of_each_is_fine() {
        let one_each = vec![
            consent(ConsentPurpose::Processing, true),
            consent(ConsentPurpose::PoolRetention, false),
        ];
        assert!(validate_draft(&one_each, false).is_empty());

        let two = vec![
            consent(ConsentPurpose::Processing, true),
            consent(ConsentPurpose::Processing, true),
        ];
        assert_eq!(
            codes(&validate_draft(&two, false)),
            vec![(Some(1), "duplicate_consent_purpose")]
        );
    }

    #[test]
    fn a_required_pool_retention_consent_is_refused_and_an_optional_one_is_not() {
        assert_eq!(
            codes(&validate_draft(
                &[consent(ConsentPurpose::PoolRetention, true)],
                false
            )),
            vec![(Some(0), "pool_retention_required")]
        );
        assert!(validate_draft(&[consent(ConsentPurpose::PoolRetention, false)], false).is_empty());
    }

    #[test]
    fn options_on_a_kind_that_takes_none_are_refused() {
        let with_options = QuestionDraft {
            options: Some(vec![option("a", "A")]),
            ..question(QuestionKind::ShortText)
        };
        assert_eq!(
            codes(&validate_draft(&[with_options], false)),
            vec![(Some(0), "options_not_allowed")]
        );
    }

    #[test]
    fn no_options_on_a_kind_that_needs_them_is_refused_but_an_empty_list_is_a_list() {
        for kind in [
            QuestionKind::SingleChoice,
            QuestionKind::MultiChoice,
            QuestionKind::Missions,
        ] {
            let bare = QuestionDraft {
                options: None,
                ..question(kind)
            };
            assert_eq!(
                codes(&validate_draft(&[bare], true)),
                vec![(Some(0), "options_required")],
                "{kind:?}"
            );
            let empty = QuestionDraft {
                options: Some(Vec::new()),
                ..question(kind)
            };
            assert!(validate_draft(&[empty], true).is_empty(), "{kind:?}");
        }
    }

    #[test]
    fn email_and_phone_with_no_target_are_refused() {
        assert_eq!(
            codes(&validate_draft(
                &[question(QuestionKind::Email), question(QuestionKind::Phone)],
                false
            )),
            vec![(Some(0), "target_required"), (Some(1), "target_required")]
        );
    }

    #[test]
    fn email_and_phone_feed_only_their_own_column() {
        assert_eq!(
            codes(&validate_draft(
                &[targeted(QuestionKind::Email, TargetPath::Phone, false)],
                false
            )),
            vec![
                (Some(0), "target_kind_mismatch"),
                (Some(0), "target_kind_mismatch")
            ]
        );
        assert_eq!(
            codes(&validate_draft(
                &[targeted(QuestionKind::ShortText, TargetPath::Email, true)],
                false
            )),
            vec![(Some(0), "target_kind_mismatch")]
        );
        assert!(
            validate_draft(
                &[targeted(QuestionKind::Phone, TargetPath::Phone, false)],
                false
            )
            .is_empty()
        );
    }

    #[test]
    fn a_target_on_a_kind_with_its_own_destination_is_refused() {
        for kind in [
            QuestionKind::Section,
            QuestionKind::Availability,
            QuestionKind::Missions,
        ] {
            assert_eq!(
                codes(&validate_draft(
                    &[targeted(kind, TargetPath::Notes, false)],
                    true
                )),
                vec![(Some(0), "target_not_allowed")],
                "{kind:?}"
            );
        }
        let targeted_consent = QuestionDraft {
            target_path: Some(TargetPath::Notes),
            ..consent(ConsentPurpose::Processing, true)
        };
        assert_eq!(
            codes(&validate_draft(&[targeted_consent], false)),
            vec![(Some(0), "target_not_allowed")]
        );
    }

    #[test]
    fn a_consent_must_declare_its_purpose_and_nothing_else_may() {
        assert_eq!(
            codes(&validate_draft(&[question(QuestionKind::Consent)], false)),
            vec![(Some(0), "consent_purpose_required")]
        );
        let boolean_with_purpose = QuestionDraft {
            consent_purpose: Some(ConsentPurpose::Processing),
            ..question(QuestionKind::Boolean)
        };
        assert_eq!(
            codes(&validate_draft(&[boolean_with_purpose], false)),
            vec![(Some(0), "consent_purpose_not_allowed")]
        );
    }

    #[test]
    fn a_label_with_no_french_is_refused_including_a_blank_one() {
        let blank = QuestionDraft {
            label: Localized {
                fr: "   ".to_owned(),
                en: Some("Name".to_owned()),
            },
            ..question(QuestionKind::ShortText)
        };
        assert_eq!(
            codes(&validate_draft(&[blank], false)),
            vec![(Some(0), "label_missing_fr")]
        );
    }

    #[test]
    fn help_text_and_option_labels_need_french_too() {
        let help = QuestionDraft {
            help_text: Some(Localized::fr("")),
            ..question(QuestionKind::ShortText)
        };
        let options = QuestionDraft {
            options: Some(vec![option("a", "")]),
            ..question(QuestionKind::SingleChoice)
        };
        assert_eq!(
            codes(&validate_draft(&[help, options], false)),
            vec![(Some(0), "label_missing_fr"), (Some(1), "label_missing_fr")]
        );
    }

    #[test]
    fn availability_and_missions_need_a_scope() {
        let questions = vec![
            question(QuestionKind::Availability),
            question(QuestionKind::Missions),
        ];
        assert_eq!(
            codes(&validate_draft(&questions, false)),
            vec![(Some(0), "scope_required"), (Some(1), "scope_required")]
        );
        assert!(validate_draft(&questions, true).is_empty());
    }

    #[test]
    fn every_problem_is_reported_not_only_the_first() {
        let questions = vec![
            question(QuestionKind::Email),
            question(QuestionKind::Consent),
            question(QuestionKind::Availability),
        ];
        assert_eq!(
            codes(&validate_draft(&questions, false)),
            vec![
                (Some(0), "target_required"),
                (Some(1), "consent_purpose_required"),
                (Some(2), "scope_required"),
            ]
        );
    }

    // --- publish: passing ---------------------------------------------------

    #[test]
    fn the_minimal_form_publishes() {
        assert!(publish(&minimal(), false, &no_missions()).is_empty());
    }

    #[test]
    fn a_form_without_pool_retention_publishes() {
        // Silence is never consent, and it is not a defect either (ADR-0025).
        let questions = minimal();
        assert!(
            !questions
                .iter()
                .any(|question| question.consent_purpose == Some(ConsentPurpose::PoolRetention))
        );
        assert!(publish(&questions, false, &no_missions()).is_empty());
    }

    // --- publish: failing, one per rule -------------------------------------

    #[test]
    fn publish_repeats_the_draft_rules() {
        let mut questions = minimal();
        questions.push(consent(ConsentPurpose::PoolRetention, true));
        assert_eq!(
            codes(&publish(&questions, false, &no_missions())),
            vec![(Some(4), "pool_retention_required")]
        );
    }

    #[test]
    fn publish_refuses_a_form_with_no_processing_consent() {
        let questions = minimal_without(ConsentPurpose::Processing);
        assert_eq!(
            codes(&publish(&questions, false, &no_missions())),
            vec![(None, "processing_consent_missing")]
        );
    }

    #[test]
    fn a_pool_retention_consent_does_not_stand_in_for_processing() {
        let mut questions = minimal_without(ConsentPurpose::Processing);
        questions.push(consent(ConsentPurpose::PoolRetention, false));
        assert_eq!(
            codes(&publish(&questions, false, &no_missions())),
            vec![(None, "processing_consent_missing")]
        );
    }

    #[test]
    fn publish_refuses_a_form_with_no_commitment() {
        assert_eq!(
            codes(&publish(
                &minimal_without(ConsentPurpose::Commitment),
                false,
                &no_missions()
            )),
            vec![(None, "commitment_missing")]
        );
    }

    #[test]
    fn the_processing_consent_does_not_stand_in_for_the_commitment() {
        // Agreeing to how the answers are used is not agreeing to volunteer.
        let mut questions = minimal_without(ConsentPurpose::Commitment);
        questions.push(consent(ConsentPurpose::PoolRetention, false));
        assert_eq!(
            codes(&publish(&questions, false, &no_missions())),
            vec![(None, "commitment_missing")]
        );
    }

    #[test]
    fn publish_refuses_an_optional_commitment() {
        let mut questions = minimal_without(ConsentPurpose::Commitment);
        questions.push(consent(ConsentPurpose::Commitment, false));
        assert_eq!(
            codes(&publish(&questions, false, &no_missions())),
            vec![(Some(3), "commitment_optional")]
        );
    }

    #[test]
    fn a_second_commitment_is_refused() {
        let mut questions = minimal();
        questions.push(consent(ConsentPurpose::Commitment, true));
        assert_eq!(
            codes(&validate_draft(&questions, false)),
            vec![(Some(4), "duplicate_consent_purpose")]
        );
    }

    #[test]
    fn the_commitment_names_the_organisation_in_both_languages() {
        let question = commitment_question("  Z·est Radio ");
        assert!(question.is_builtin());
        assert!(question.is_required);
        assert_eq!(
            question.label,
            Localized {
                fr: "Je confirme mon engagement bénévole auprès de Z·est Radio pour cet \
                     événement."
                    .to_owned(),
                en: Some(
                    "I confirm my volunteer commitment to Z·est Radio for this event.".to_owned()
                ),
            }
        );
        let help = question
            .help_text
            .expect("the declaration is the help text");
        assert!(
            help.fr
                .contains("pour le compte de l'association Z·est Radio")
        );
        assert!(
            help.en
                .is_some_and(|en| en.contains("on behalf of the association Z·est Radio"))
        );
    }

    #[test]
    fn publish_refuses_an_optional_processing_consent() {
        let mut questions = minimal();
        questions[2].is_required = false;
        assert_eq!(
            codes(&publish(&questions, false, &no_missions())),
            vec![(Some(2), "processing_consent_optional")]
        );
    }

    #[test]
    fn publish_refuses_a_missing_or_optional_first_name() {
        let without: Vec<QuestionDraft> = minimal().into_iter().skip(1).collect();
        assert_eq!(
            codes(&publish(&without, false, &no_missions())),
            vec![(None, "first_name_missing")]
        );

        let mut optional = minimal();
        optional[0].is_required = false;
        assert_eq!(
            codes(&publish(&optional, false, &no_missions())),
            vec![(Some(0), "first_name_optional")]
        );
    }

    #[test]
    fn publish_refuses_a_missing_or_optional_email() {
        let without: Vec<QuestionDraft> = minimal()
            .into_iter()
            .filter(|question| question.target_path != Some(TargetPath::Email))
            .collect();
        assert_eq!(
            codes(&publish(&without, false, &no_missions())),
            vec![(None, "email_missing")]
        );

        let mut optional = minimal();
        optional[1].is_required = false;
        assert_eq!(
            codes(&publish(&optional, false, &no_missions())),
            vec![(Some(1), "email_optional")]
        );
    }

    #[test]
    fn last_name_may_be_required_or_not() {
        for required in [false, true] {
            let mut questions = minimal();
            questions.push(targeted(
                QuestionKind::ShortText,
                TargetPath::LastName,
                required,
            ));
            assert!(publish(&questions, false, &no_missions()).is_empty());
        }
    }

    #[test]
    fn publish_refuses_duplicate_and_blank_option_values() {
        let mut questions = minimal();
        questions.push(QuestionDraft {
            options: Some(vec![
                option("s", "S"),
                option("m", "M"),
                option("s", "S bis"),
            ]),
            ..question(QuestionKind::SingleChoice)
        });
        questions.push(QuestionDraft {
            options: Some(vec![option(" ", "Vide")]),
            ..question(QuestionKind::MultiChoice)
        });
        assert_eq!(
            codes(&publish(&questions, false, &no_missions())),
            vec![
                (Some(4), "duplicate_option_value"),
                (Some(5), "option_value_blank")
            ]
        );
    }

    #[test]
    fn a_missions_option_must_still_name_a_mission() {
        let keys: BTreeSet<String> = ["bar".to_owned(), "accueil".to_owned()].into();
        let mut questions = minimal();
        questions.push(QuestionDraft {
            options: Some(vec![option("bar", "Bar"), option("vestiaire", "Vestiaire")]),
            ..question(QuestionKind::Missions)
        });
        let problems = publish(&questions, true, &keys);
        assert_eq!(
            codes(&problems),
            vec![(Some(4), "mission_option_unresolved")]
        );
        assert!(problems[0].message.contains("Vestiaire"));

        // The boundary: every option resolving is enough, and a mission not
        // offered is fine — unticking a mission is the coordinator's call.
        questions[4].options = Some(vec![option("bar", "Bar")]);
        assert!(publish(&questions, true, &keys).is_empty());
    }

    #[test]
    fn mission_resolution_applies_only_to_the_missions_question() {
        let mut questions = minimal();
        questions.push(QuestionDraft {
            options: Some(vec![option("vestiaire", "Vestiaire")]),
            ..question(QuestionKind::MultiChoice)
        });
        assert!(publish(&questions, false, &no_missions()).is_empty());
    }

    #[test]
    fn an_english_form_needs_english_everywhere_and_a_french_one_does_not() {
        let mut questions = minimal();
        for question in &mut questions {
            question.label.en = Some("Label".to_owned());
        }
        questions.push(QuestionDraft {
            label: Localized {
                fr: "Taille".to_owned(),
                en: Some("Size".to_owned()),
            },
            help_text: Some(Localized::fr("Pour le t-shirt")),
            options: Some(vec![option("m", "M")]),
            ..targeted(QuestionKind::SingleChoice, TargetPath::TshirtSize, false)
        });
        let english = |questions: &[QuestionDraft]| {
            validate_publish(
                questions,
                PublishContext {
                    scoped: false,
                    default_locale: Locale::En,
                    mission_keys: &BTreeSet::new(),
                },
            )
        };

        assert_eq!(
            codes(&english(&questions)),
            vec![(Some(4), "label_missing_locale")],
            "help text and option labels need English too"
        );
        assert!(publish(&questions, false, &no_missions()).is_empty());

        questions[4].help_text = Some(Localized {
            fr: "Pour le t-shirt".to_owned(),
            en: Some("For the T-shirt".to_owned()),
        });
        questions[4].options = Some(vec![QuestionOption {
            value: "m".to_owned(),
            label: Localized {
                fr: "M".to_owned(),
                en: Some("M".to_owned()),
            },
            skill_id: None,
            checked_by_default: false,
            adults_only: false,
        }]);
        assert!(english(&questions).is_empty());
    }

    // --- missions fold: mirrors missionCatalog.test.ts ----------------------

    fn row(event_id: Uuid, name: &str) -> MissionRow {
        MissionRow {
            event_id,
            name: name.to_owned(),
            checked_by_default: true,
            adults_only: false,
        }
    }

    fn flagged(
        event_id: Uuid,
        name: &str,
        checked_by_default: bool,
        adults_only: bool,
    ) -> MissionRow {
        MissionRow {
            checked_by_default,
            adults_only,
            ..row(event_id, name)
        }
    }

    #[test]
    fn mission_key_folds_case_and_surrounding_whitespace() {
        assert_eq!(mission_key("  Bar  "), "bar");
        assert_eq!(mission_key("BAR"), mission_key("bar"));
    }

    #[test]
    fn mission_key_keeps_inner_whitespace_as_the_admin_app_does() {
        assert_eq!(mission_key("Bar  1"), "bar  1");
        assert_ne!(mission_key("Bar  1"), mission_key("Bar 1"));
    }

    #[test]
    fn mission_key_trims_what_javascript_trims() {
        // U+FEFF is trimmed by JavaScript and not by `str::trim`; U+0085 the
        // other way round.
        assert_eq!(mission_key("\u{FEFF}Bar\u{00A0}"), "bar");
        assert_eq!(mission_key("\u{0085}Bar"), "\u{0085}bar");
        assert_eq!(mission_key("Éclairage"), "éclairage");
    }

    #[test]
    fn the_same_post_on_two_days_is_one_mission() {
        let (open_air, club) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let missions = fold_missions(&[
            row(open_air, "Site"),
            row(open_air, "Bar"),
            row(club, "Site"),
            row(club, "Bar"),
        ]);
        let bar = missions
            .iter()
            .find(|mission| mission.value == "bar")
            .unwrap();
        assert_eq!(bar.event_ids, vec![open_air, club]);
    }

    #[test]
    fn a_zone_that_holds_posts_is_still_a_mission() {
        let day = Uuid::from_u128(1);
        let keys: Vec<String> = fold_missions(&[row(day, "Site"), row(day, "Bar")])
            .into_iter()
            .map(|mission| mission.value)
            .collect();
        assert_eq!(keys, vec!["bar", "site"]);
    }

    #[test]
    fn missions_sort_on_the_normalised_key() {
        let day = Uuid::from_u128(1);
        let keys: Vec<String> =
            fold_missions(&[row(day, "Site"), row(day, "accueil"), row(day, "Bar")])
                .into_iter()
                .map(|mission| mission.value)
                .collect();
        assert_eq!(keys, vec!["accueil", "bar", "site"]);
    }

    #[test]
    fn the_first_day_s_spelling_is_the_label() {
        let (open_air, club) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let missions = fold_missions(&[row(open_air, "Bar"), row(club, "BAR")]);
        assert_eq!(missions.len(), 1);
        assert_eq!(missions[0].label, "Bar");
        assert_eq!(missions[0].value, "bar");
    }

    #[test]
    fn two_rows_of_one_event_list_the_event_once() {
        // A zone and a post sharing a name fold together, and the event is
        // still one event.
        let day = Uuid::from_u128(1);
        let missions = fold_missions(&[row(day, "Bar"), row(day, "bar")]);
        assert_eq!(missions[0].event_ids, vec![day]);
    }

    #[test]
    fn no_rows_fold_to_no_missions() {
        assert!(fold_missions(&[]).is_empty());
    }

    // --- missions fold: the form flags --------------------------------------

    fn flags(missions: &[MissionOption]) -> Vec<(bool, bool)> {
        missions
            .iter()
            .map(|mission| (mission.checked_by_default, mission.adults_only))
            .collect()
    }

    #[test]
    fn an_unflagged_mission_is_ticked_and_open_to_minors() {
        let day = Uuid::from_u128(1);
        assert_eq!(
            flags(&fold_missions(&[row(day, "Bar")])),
            vec![(true, false)]
        );
    }

    #[test]
    fn one_opt_in_day_makes_the_whole_mission_opt_in() {
        let (open_air, club) = (Uuid::from_u128(1), Uuid::from_u128(2));
        for rows in [
            [flagged(open_air, "Son", false, false), row(club, "Son")],
            [row(open_air, "Son"), flagged(club, "Son", false, false)],
        ] {
            assert_eq!(flags(&fold_missions(&rows)), vec![(false, false)]);
        }
    }

    #[test]
    fn one_adults_only_day_makes_the_whole_mission_adults_only_and_unticked() {
        let (open_air, club) = (Uuid::from_u128(1), Uuid::from_u128(2));
        for rows in [
            [flagged(open_air, "Bar", true, true), row(club, "Bar")],
            [row(open_air, "Bar"), flagged(club, "Bar", true, true)],
        ] {
            assert_eq!(flags(&fold_missions(&rows)), vec![(false, true)]);
        }
    }

    #[test]
    fn stamping_takes_the_flags_from_the_zones_not_from_the_client() {
        let day = Uuid::from_u128(1);
        let missions = fold_missions(&[
            row(day, "Accueil"),
            flagged(day, "Son", false, false),
            flagged(day, "Bar", true, true),
        ]);
        let mut questions = vec![QuestionDraft {
            options: Some(vec![
                QuestionOption {
                    checked_by_default: false,
                    adults_only: true,
                    ..option("accueil", "Accueil")
                },
                QuestionOption {
                    checked_by_default: true,
                    ..option("son", "Son")
                },
                option("bar", "Bar"),
                QuestionOption {
                    checked_by_default: true,
                    adults_only: true,
                    ..option("gone", "Supprimée")
                },
            ]),
            ..question(QuestionKind::Missions)
        }];
        stamp_missions(&mut questions, &missions);
        let stamped: Vec<(bool, bool)> = questions[0]
            .options
            .iter()
            .flatten()
            .map(|option| (option.checked_by_default, option.adults_only))
            .collect();
        assert_eq!(
            stamped,
            vec![(true, false), (false, false), (false, true), (false, false)]
        );
    }

    #[test]
    fn stamping_leaves_other_choice_questions_alone() {
        let day = Uuid::from_u128(1);
        let missions = fold_missions(&[row(day, "Bar")]);
        let mut questions = vec![QuestionDraft {
            options: Some(vec![option("bar", "Bar")]),
            ..question(QuestionKind::MultiChoice)
        }];
        stamp_missions(&mut questions, &missions);
        assert_eq!(questions[0].options, Some(vec![option("bar", "Bar")]));
    }

    #[test]
    fn an_option_frozen_before_the_flags_existed_reads_unticked() {
        let option: QuestionOption =
            serde_json::from_str(r#"{"value":"bar","label":{"fr":"Bar"}}"#).unwrap();
        assert!(!option.checked_by_default && !option.adults_only);
        assert_eq!(
            serde_json::to_string(&option).unwrap(),
            r#"{"value":"bar","label":{"fr":"Bar"}}"#,
            "unset flags are not written"
        );
    }

    // --- the seeded draft ----------------------------------------------------

    #[test]
    fn a_scoped_seed_has_the_documented_questions_in_order_and_publishes() {
        let missions = fold_missions(&[row(Uuid::from_u128(1), "Bar")]);
        let seed = seed_draft(true, &missions, "Z·est Radio");
        let shape: Vec<(QuestionKind, Option<TargetPath>, bool)> = seed
            .iter()
            .map(|question| (question.kind, question.target_path, question.is_required))
            .collect();
        assert_eq!(
            shape,
            vec![
                (QuestionKind::Section, None, false),
                (QuestionKind::ShortText, Some(TargetPath::FirstName), true),
                (QuestionKind::ShortText, Some(TargetPath::LastName), false),
                (QuestionKind::Email, Some(TargetPath::Email), true),
                (QuestionKind::Phone, Some(TargetPath::Phone), false),
                (QuestionKind::Availability, None, true),
                (QuestionKind::Missions, None, false),
                (QuestionKind::Consent, None, true),
                (QuestionKind::Consent, None, true),
            ]
        );
        assert_eq!(seed[1].label.fr, "Comment veux-tu qu'on t'appelle ?");
        assert_eq!(seed[7], commitment_question("Z·est Radio"));
        assert_eq!(seed[8].consent_purpose, Some(ConsentPurpose::Processing));
        assert!(seed[8].label.fr.contains("e-mail") && seed[8].label.fr.contains("SMS"));
        assert_eq!(
            seed[6].options,
            Some(vec![QuestionOption {
                value: "bar".to_owned(),
                label: Localized::fr("Bar"),
                skill_id: None,
                checked_by_default: true,
                adults_only: false,
            }])
        );

        let keys: BTreeSet<String> = missions.into_iter().map(|mission| mission.value).collect();
        assert!(publish(&seed, true, &keys).is_empty());
    }

    #[test]
    fn an_unscoped_seed_asks_no_availability_or_missions_and_publishes() {
        let seed = seed_draft(false, &[], "Z·est Radio");
        assert!(!seed.iter().any(|question| matches!(
            question.kind,
            QuestionKind::Availability | QuestionKind::Missions
        )));
        assert_eq!(seed.len(), 7);
        assert!(publish(&seed, false, &no_missions()).is_empty());
    }
}
