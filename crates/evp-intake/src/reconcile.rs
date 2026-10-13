// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The identity ladder (docs/08 §6), from step 2 on: given who a submission
//! says it is and who in the pool it could be, decide whether it is one of
//! them, a new person, or a question for a coordinator.
//!
//! Every comparison is over values `evp_db::intake` has already normalised the
//! way `volunteers.display_name_norm` is — `lower(immutable_unaccent(…))` —
//! because PostgreSQL's unaccent dictionary is the one the trigram index was
//! built with, and a second, Rust-side folding would be a second opinion on
//! what "the same name" means.

use uuid::Uuid;

/// `match_kind`, for the cases this ladder can reach on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    /// Step 2: the address is one volunteer's (ADR-0028), and the name does
    /// not contradict it.
    ExactEmail,
    /// Step 3: one name above the threshold, with a last name or a phone
    /// number agreeing.
    FuzzyConfirmed,
    /// Step 5: nobody it could be — or a coordinator said so.
    New,
    /// A coordinator picked the volunteer from the review queue. [`decide`]
    /// never returns it: it is the one kind no rule produced.
    Manual,
}

impl MatchKind {
    /// The enum label in PostgreSQL.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExactEmail => "exact_email",
            Self::FuzzyConfirmed => "fuzzy_confirmed",
            Self::New => "new",
            Self::Manual => "manual",
        }
    }
}

/// The submission's side of the comparison, normalised.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Incoming<'a> {
    pub first_name: Option<&'a str>,
    pub last_name: Option<&'a str>,
    pub phone: Option<&'a str>,
}

/// A volunteer the submission could be, normalised like [`Incoming`], with
/// the trigram similarity of the two display names.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub volunteer_id: Uuid,
    pub score: f32,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
}

/// What a coordinator is told a review item is about, beyond "similar name".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    /// ADR-0028: the address already belongs to a volunteer, and the name does
    /// not say it is them.
    EmailInUse,
}

impl Conflict {
    /// The `code` stored in `submissions.errors`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EmailInUse => "email_in_use",
        }
    }
}

/// One candidate as the review queue will show it: ids and evidence, never a
/// copy of the volunteer's details — `submissions` outlives an anonymised
/// volunteer, and a name kept here would outlive the erasure.
#[derive(Debug, Clone, PartialEq)]
pub struct Ranked {
    pub volunteer_id: Uuid,
    pub score: f32,
    pub last_name_agrees: bool,
    pub phone_agrees: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Apply {
        volunteer_id: Uuid,
        kind: MatchKind,
    },
    Create,
    /// Step 4, or a step-2 conflict: best candidate first.
    Review {
        candidates: Vec<Ranked>,
        conflict: Option<Conflict>,
    },
}

/// The ladder.
///
/// `email_owner` is the volunteer the submitted address already belongs to,
/// if any; `by_name` are the volunteers whose display name is similar, in any
/// order; `threshold` is the source's `fuzzy_threshold`.
///
/// **Names never auto-match alone** (docs/08 §6): a name above the threshold
/// applies only with a second field agreeing, and two such candidates are as
/// ambiguous as none. An address match is stronger, but not blind: a
/// couple sharing one address, or someone who knows a volunteer's address,
/// must not be able to rewrite that volunteer — so the name has to agree
/// with it, by first name or by overall similarity. A shared last name is
/// deliberately not enough there, because that is exactly what a couple has.
#[must_use]
pub fn decide(
    incoming: &Incoming<'_>,
    email_owner: Option<&Candidate>,
    by_name: &[Candidate],
    threshold: f32,
) -> Decision {
    if let Some(owner) = email_owner {
        let same_person =
            agrees(incoming.first_name, owner.first_name.as_deref()) || owner.score >= threshold;
        return if same_person {
            Decision::Apply {
                volunteer_id: owner.volunteer_id,
                kind: MatchKind::ExactEmail,
            }
        } else {
            Decision::Review {
                candidates: vec![rank(incoming, owner)],
                conflict: Some(Conflict::EmailInUse),
            }
        };
    }

    let mut candidates: Vec<Ranked> = by_name
        .iter()
        .filter(|candidate| candidate.score >= threshold)
        .map(|candidate| rank(incoming, candidate))
        .collect();
    candidates.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.volunteer_id.cmp(&b.volunteer_id))
    });

    let corroborated: Vec<Uuid> = candidates
        .iter()
        .filter(|candidate| candidate.last_name_agrees || candidate.phone_agrees)
        .map(|candidate| candidate.volunteer_id)
        .collect();
    match corroborated.as_slice() {
        [only] => Decision::Apply {
            volunteer_id: *only,
            kind: MatchKind::FuzzyConfirmed,
        },
        _ if candidates.is_empty() => Decision::Create,
        _ => Decision::Review {
            candidates,
            conflict: None,
        },
    }
}

fn rank(incoming: &Incoming<'_>, candidate: &Candidate) -> Ranked {
    Ranked {
        volunteer_id: candidate.volunteer_id,
        score: candidate.score,
        last_name_agrees: agrees(incoming.last_name, candidate.last_name.as_deref()),
        phone_agrees: match (incoming.phone, candidate.phone.as_deref()) {
            (Some(a), Some(b)) => phones_agree(a, b),
            _ => false,
        },
    }
}

/// Both sides said something, and it is the same thing. Absent on either side
/// is not agreement: a legacy row with no last name corroborates nothing.
fn agrees(a: Option<&str>, b: Option<&str>) -> bool {
    match (a.map(str::trim), b.map(str::trim)) {
        (Some(a), Some(b)) => !a.is_empty() && a == b,
        _ => false,
    }
}

/// Phone numbers are typed every way there is — `06 12 34 56 78`,
/// `+33 6 12 34 56 78`, `0612345678` — so they are compared on digits, and on
/// the last nine of them when both have that many: the national number
/// without the trunk `0` or the country code in front of it.
#[must_use]
pub fn phones_agree(a: &str, b: &str) -> bool {
    const SIGNIFICANT: usize = 9;
    let digits = |text: &str| -> Vec<char> { text.chars().filter(char::is_ascii_digit).collect() };
    let (a, b) = (digits(a), digits(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    match (
        a.len().checked_sub(SIGNIFICANT),
        b.len().checked_sub(SIGNIFICANT),
    ) {
        (Some(skip_a), Some(skip_b)) => a.iter().skip(skip_a).eq(b.iter().skip(skip_b)),
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use rstest::rstest;

    use super::*;

    const THRESHOLD: f32 = 0.85;

    fn ada() -> Incoming<'static> {
        Incoming {
            first_name: Some("ada"),
            last_name: Some("lovelace"),
            phone: Some("06 12 34 56 78"),
        }
    }

    fn candidate(id: u128, score: f32) -> Candidate {
        Candidate {
            volunteer_id: Uuid::from_u128(id),
            score,
            first_name: None,
            last_name: None,
            phone: None,
        }
    }

    fn named(id: u128, score: f32, first: &str, last: &str) -> Candidate {
        Candidate {
            first_name: Some(first.to_owned()),
            last_name: Some(last.to_owned()),
            ..candidate(id, score)
        }
    }

    // -- Step 2: the address -------------------------------------------------

    #[rstest]
    #[case::same_first_name(named(1, 0.2, "ada", "byron"))]
    #[case::similar_display_name(named(1, THRESHOLD, "augusta", "lovelace"))]
    #[case::legacy_row_with_no_parts(candidate(1, 1.0))]
    fn an_address_the_name_agrees_with_is_that_volunteer(#[case] owner: Candidate) {
        assert_eq!(
            decide(&ada(), Some(&owner), &[], THRESHOLD),
            Decision::Apply {
                volunteer_id: Uuid::from_u128(1),
                kind: MatchKind::ExactEmail,
            }
        );
    }

    #[rstest]
    #[case::a_partner_sharing_the_surname(named(1, 0.4, "charles", "lovelace"))]
    #[case::someone_else_entirely(named(1, 0.0, "grace", "hopper"))]
    #[case::legacy_row_unlike_the_name(candidate(1, 0.3))]
    fn an_address_claimed_by_another_name_is_a_conflict(#[case] owner: Candidate) {
        let Decision::Review {
            candidates,
            conflict,
        } = decide(
            &ada(),
            Some(&owner),
            &[named(2, 1.0, "ada", "lovelace")],
            THRESHOLD,
        )
        else {
            panic!("expected a review item");
        };
        assert_eq!(conflict, Some(Conflict::EmailInUse));
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.volunteer_id)
                .collect::<Vec<_>>(),
            vec![Uuid::from_u128(1)],
            "the conflict is about the address's owner, not about name lookalikes"
        );
    }

    // -- Steps 3 to 5: the name ------------------------------------------------

    #[test]
    fn nobody_similar_is_a_new_volunteer() {
        assert_eq!(decide(&ada(), None, &[], THRESHOLD), Decision::Create);
        assert_eq!(
            decide(
                &ada(),
                None,
                &[named(1, 0.849, "ada", "lovelace")],
                THRESHOLD
            ),
            Decision::Create,
            "just under the threshold is not similar, even with a matching last name"
        );
    }

    #[rstest]
    #[case::by_last_name(named(1, THRESHOLD, "adah", "lovelace"))]
    #[case::by_phone(Candidate {
        phone: Some("+33 6 12 34 56 78".to_owned()),
        ..candidate(1, 0.9)
    })]
    fn one_similar_name_with_a_second_field_agreeing_is_that_volunteer(#[case] similar: Candidate) {
        assert_eq!(
            decide(&ada(), None, &[similar, candidate(2, 0.95)], THRESHOLD),
            Decision::Apply {
                volunteer_id: Uuid::from_u128(1),
                kind: MatchKind::FuzzyConfirmed,
            }
        );
    }

    #[test]
    fn a_similar_name_alone_is_a_question_ranked_best_first() {
        let decision = decide(
            &ada(),
            None,
            &[
                named(3, 0.9, "ada", "byron"),
                candidate(2, 0.95),
                candidate(1, 0.9),
            ],
            THRESHOLD,
        );
        assert_eq!(
            decision,
            Decision::Review {
                candidates: vec![
                    Ranked {
                        volunteer_id: Uuid::from_u128(2),
                        score: 0.95,
                        last_name_agrees: false,
                        phone_agrees: false,
                    },
                    Ranked {
                        volunteer_id: Uuid::from_u128(1),
                        score: 0.9,
                        last_name_agrees: false,
                        phone_agrees: false,
                    },
                    Ranked {
                        volunteer_id: Uuid::from_u128(3),
                        score: 0.9,
                        last_name_agrees: false,
                        phone_agrees: false,
                    },
                ],
                conflict: None,
            }
        );
    }

    #[test]
    fn two_corroborated_namesakes_are_a_question_not_a_coin_toss() {
        let Decision::Review {
            candidates,
            conflict,
        } = decide(
            &ada(),
            None,
            &[
                named(1, 0.9, "ada", "lovelace"),
                named(2, 0.9, "ada", "lovelace"),
            ],
            THRESHOLD,
        )
        else {
            panic!("expected a review item");
        };
        assert_eq!(conflict, None);
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.last_name_agrees)
        );
    }

    #[test]
    fn a_missing_last_name_on_either_side_corroborates_nothing() {
        let incoming = Incoming {
            last_name: None,
            phone: None,
            ..ada()
        };
        assert!(matches!(
            decide(
                &incoming,
                None,
                &[named(1, 0.9, "ada", "lovelace")],
                THRESHOLD
            ),
            Decision::Review { .. }
        ));
        assert!(matches!(
            decide(&ada(), None, &[candidate(1, 0.9)], THRESHOLD),
            Decision::Review { .. }
        ));
    }

    // -- Phones -------------------------------------------------------------

    #[rstest]
    #[case::formatting("06 12 34 56 78", "0612345678", true)]
    #[case::country_code("+33 6 12 34 56 78", "06.12.34.56.78", true)]
    #[case::short_numbers_compare_whole("1234", "12-34", true)]
    #[case::different_number("06 12 34 56 78", "06 12 34 56 79", false)]
    #[case::short_against_long("345678", "0612345678", false)]
    #[case::no_digits("n/a", "n/a", false)]
    fn phones_agree_on_their_digits(#[case] a: &str, #[case] b: &str, #[case] expected: bool) {
        assert_eq!(phones_agree(a, b), expected);
        assert_eq!(phones_agree(b, a), expected, "symmetric");
    }

    #[test]
    fn labels_are_the_postgresql_enum_values() {
        assert_eq!(MatchKind::ExactEmail.as_str(), "exact_email");
        assert_eq!(MatchKind::FuzzyConfirmed.as_str(), "fuzzy_confirmed");
        assert_eq!(MatchKind::New.as_str(), "new");
        assert_eq!(MatchKind::Manual.as_str(), "manual");
        assert_eq!(Conflict::EmailInUse.as_str(), "email_in_use");
    }

    proptest! {
        /// The pool is read in whatever order the index returns it; the
        /// decision must not depend on that.
        #[test]
        fn the_decision_does_not_depend_on_candidate_order(
            scores in proptest::collection::vec(
                (prop::sample::select(vec![0.5_f32, THRESHOLD, 0.9, 1.0]), any::<bool>()),
                0..6,
            ),
            rotation in 0_usize..6,
        ) {
            let mut pool: Vec<Candidate> = (1_u128..)
                .zip(&scores)
                .map(|(id, (score, same_surname))| Candidate {
                    last_name: same_surname.then(|| "lovelace".to_owned()),
                    ..candidate(id, *score)
                })
                .collect();
            let forwards = decide(&ada(), None, &pool, THRESHOLD);
            let by = rotation.min(pool.len());
            pool.rotate_left(by);
            pool.reverse();
            prop_assert_eq!(decide(&ada(), None, &pool, THRESHOLD), forwards);
        }
    }
}
