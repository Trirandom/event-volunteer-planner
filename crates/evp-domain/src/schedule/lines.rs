// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! A volunteer's schedule as a list of lines, and the three things publishing
//! does with one: merge it, fingerprint it, and compare it with the last one
//! the volunteer was sent (docs/03 §3.7).

use std::collections::{BTreeMap, BTreeSet};

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

/// One line of somebody's schedule: a post, at an event, for some hours.
///
/// Also the shape of `schedule_snapshots.payload`, which is the schedule *as
/// it was sent* — so the mission's name is the name the volunteer read, even
/// if the post has been renamed since. The time zone travels as its IANA name
/// and is resolved by whoever formats the line ([`super::locale::Zones`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleLine {
    pub event_id: Uuid,
    pub location_id: Uuid,
    pub mission: String,
    pub timezone: String,
    pub start: Timestamp,
    pub end: Timestamp,
}

/// What identifies a line for change detection: where and when, not what it
/// is called. Field order is the sort order, so sorting by key is
/// chronological.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LineKey {
    pub start: Timestamp,
    pub end: Timestamp,
    pub event_id: Uuid,
    pub location_id: Uuid,
}

impl ScheduleLine {
    #[must_use]
    pub fn key(&self) -> LineKey {
        LineKey {
            start: self.start,
            end: self.end,
            event_id: self.event_id,
            location_id: self.location_id,
        }
    }

    fn same_post(&self, other: &Self) -> bool {
        self.event_id == other.event_id && self.location_id == other.location_id
    }
}

/// Touching shifts at the same post become one line, chronologically.
///
/// docs/01 S10: "Sam. 5/9 10h–18h : Bar", not four half-day entries. Only an
/// exact touch merges — a break of any length between two shifts is a break
/// the volunteer is owed. Same rule as `mergeAdjacent` in the admin app, which
/// compares mission names; this compares the post's id, which a rename cannot
/// make ambiguous.
#[must_use]
pub fn merge_adjacent(lines: impl IntoIterator<Item = ScheduleLine>) -> Vec<ScheduleLine> {
    let mut sorted: Vec<ScheduleLine> = lines.into_iter().collect();
    sorted.sort_by_key(ScheduleLine::key);
    let mut merged: Vec<ScheduleLine> = Vec::with_capacity(sorted.len());
    for line in sorted {
        match merged
            .iter_mut()
            .rev()
            .find(|earlier| earlier.same_post(&line) && earlier.end == line.start)
        {
            Some(earlier) => earlier.end = line.end,
            None => merged.push(line),
        }
    }
    merged
}

/// SHA-256 over where and when, never names: renaming a post must not email
/// four hundred people to say nothing about their hours changed. Versioned
/// (`v1`) so that changing what counts as a change is a visible migration of
/// every stored digest rather than a silent mass resend.
///
/// Order-independent: the lines are sorted here, whatever the caller did.
#[must_use]
pub fn digest(lines: &[ScheduleLine]) -> [u8; 32] {
    let keys: BTreeSet<LineKey> = lines.iter().map(ScheduleLine::key).collect();
    let mut hasher = Sha256::new();
    hasher.update(b"v1\n");
    for key in keys {
        hasher.update(
            format!(
                "{}|{}|{}|{}\n",
                key.event_id, key.location_id, key.start, key.end
            )
            .as_bytes(),
        );
    }
    hasher.finalize().into()
}

/// The same post, at another time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub from: ScheduleLine,
    pub to: ScheduleLine,
}

/// What changed between the schedule a volunteer was last sent and this one.
/// Each list is chronological (a move by its new time).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Diff {
    pub added: Vec<ScheduleLine>,
    pub removed: Vec<ScheduleLine>,
    pub moved: Vec<Move>,
}

impl Diff {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.moved.is_empty()
    }
}

/// At one post: the lines that are gone, and the lines that are new.
type PostChanges<'a> = (Vec<&'a ScheduleLine>, Vec<&'a ScheduleLine>);

/// Compares two merged schedules.
///
/// A line that disappeared and one that appeared *at the same post* are
/// reported as a move — "your bar shift moved from 14:00 to 16:00" is what a
/// volunteer needs to read, not a removal and an unrelated addition. When a
/// post gained or lost lines, they are paired in time order and the rest stay
/// added or removed.
#[must_use]
pub fn diff(previous: &[ScheduleLine], current: &[ScheduleLine]) -> Diff {
    let before: BTreeSet<LineKey> = previous.iter().map(ScheduleLine::key).collect();
    let after: BTreeSet<LineKey> = current.iter().map(ScheduleLine::key).collect();

    let mut posts: BTreeMap<(Uuid, Uuid), PostChanges<'_>> = BTreeMap::new();
    for line in previous.iter().filter(|line| !after.contains(&line.key())) {
        posts
            .entry((line.event_id, line.location_id))
            .or_default()
            .0
            .push(line);
    }
    for line in current.iter().filter(|line| !before.contains(&line.key())) {
        posts
            .entry((line.event_id, line.location_id))
            .or_default()
            .1
            .push(line);
    }

    let mut out = Diff::default();
    for (mut gone, mut new) in posts.into_values() {
        gone.sort_by_key(|line| line.key());
        new.sort_by_key(|line| line.key());
        let mut gone = gone.into_iter();
        let mut new = new.into_iter();
        loop {
            match (gone.next(), new.next()) {
                (Some(from), Some(to)) => out.moved.push(Move {
                    from: from.clone(),
                    to: to.clone(),
                }),
                (Some(from), None) => out.removed.push(from.clone()),
                (None, Some(to)) => out.added.push(to.clone()),
                (None, None) => break,
            }
        }
    }
    out.added.sort_by_key(ScheduleLine::key);
    out.removed.sort_by_key(ScheduleLine::key);
    out.moved.sort_by_key(|change| change.to.key());
    out
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use jiff::Timestamp;
    use proptest::prelude::*;
    use uuid::Uuid;

    use super::{Move, ScheduleLine, diff, digest, merge_adjacent};

    const EVENT: Uuid = Uuid::from_u128(0xE);
    const OTHER_DAY: Uuid = Uuid::from_u128(0xE2);
    const BAR: Uuid = Uuid::from_u128(0xBA);
    const GATE: Uuid = Uuid::from_u128(0x6A);

    /// Hours past 2026-09-05T00:00Z.
    fn at(hour: i64) -> Timestamp {
        Timestamp::from_second(hour.saturating_mul(3600).saturating_add(1_788_566_400))
            .expect("in range")
    }

    fn line(post: Uuid, from: i64, to: i64) -> ScheduleLine {
        ScheduleLine {
            event_id: EVENT,
            location_id: post,
            mission: if post == BAR { "Bar" } else { "Gate" }.to_owned(),
            timezone: "Europe/Paris".to_owned(),
            start: at(from),
            end: at(to),
        }
    }

    #[test]
    fn touching_shifts_at_one_post_merge_whatever_the_input_order() {
        let merged = merge_adjacent([line(BAR, 14, 18), line(BAR, 10, 14)]);
        assert_eq!(merged, vec![line(BAR, 10, 18)]);
    }

    #[test]
    fn a_chain_of_three_merges_into_one() {
        let merged = merge_adjacent([line(BAR, 10, 12), line(BAR, 12, 14), line(BAR, 14, 16)]);
        assert_eq!(merged, vec![line(BAR, 10, 16)]);
    }

    #[test]
    fn a_gap_of_any_length_is_kept() {
        let mut later = line(BAR, 14, 18);
        later.start =
            Timestamp::from_second(at(14).as_second().saturating_add(60)).expect("in range");
        let merged = merge_adjacent([line(BAR, 10, 14), later.clone()]);
        assert_eq!(merged, vec![line(BAR, 10, 14), later]);
    }

    #[test]
    fn touching_shifts_at_different_posts_or_events_stay_apart() {
        let other_event = ScheduleLine {
            event_id: OTHER_DAY,
            ..line(BAR, 14, 18)
        };
        let merged = merge_adjacent([line(BAR, 10, 14), line(GATE, 14, 18), other_event.clone()]);
        assert_eq!(
            merged,
            vec![line(BAR, 10, 14), line(GATE, 14, 18), other_event]
        );
    }

    #[test]
    fn a_shift_elsewhere_in_between_does_not_stop_a_merge() {
        // Gate 12–13 sorts between the two bar shifts; the bar ones still
        // touch each other.
        let merged = merge_adjacent([line(BAR, 10, 14), line(GATE, 12, 13), line(BAR, 14, 16)]);
        assert_eq!(merged, vec![line(BAR, 10, 16), line(GATE, 12, 13)]);
    }

    #[test]
    fn the_digest_ignores_names_but_not_hours_posts_or_events() {
        let base = digest(&[line(BAR, 10, 14)]);
        let renamed = ScheduleLine {
            mission: "Buvette".to_owned(),
            timezone: "UTC".to_owned(),
            ..line(BAR, 10, 14)
        };
        assert_eq!(digest(&[renamed]), base);
        assert_ne!(digest(&[line(BAR, 10, 15)]), base);
        assert_ne!(digest(&[line(BAR, 11, 14)]), base);
        assert_ne!(digest(&[line(GATE, 10, 14)]), base);
        assert_ne!(
            digest(&[ScheduleLine {
                event_id: OTHER_DAY,
                ..line(BAR, 10, 14)
            }]),
            base
        );
        assert_ne!(digest(&[]), base);
    }

    #[test]
    fn the_empty_digest_is_stable() {
        // Pinned: every stored `is_empty` snapshot carries this value, so a
        // change to the encoding has to be a deliberate `v2`.
        let hex = digest(&[]).iter().fold(String::new(), |mut hex, byte| {
            write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
            hex
        });
        assert_eq!(
            hex,
            "2d27fbdf4e8ca207afbfa388ca9172fbcc6c70e534af2476b3b704f87debadcf"
        );
    }

    fn schedules() -> impl Strategy<Value = (Vec<ScheduleLine>, Vec<ScheduleLine>)> {
        prop::collection::vec((0_i64..48, 1_i64..6, any::<bool>()), 0..8)
            .prop_map(|hours| {
                hours
                    .into_iter()
                    .map(|(from, len, bar)| {
                        line(if bar { BAR } else { GATE }, from, from.saturating_add(len))
                    })
                    .collect::<Vec<_>>()
            })
            .prop_flat_map(|lines| (Just(lines.clone()), Just(lines).prop_shuffle()))
    }

    proptest! {
        #[test]
        fn neither_the_digest_nor_the_merge_depends_on_order((lines, shuffled) in schedules()) {
            prop_assert_eq!(digest(&lines), digest(&shuffled));
            prop_assert_eq!(merge_adjacent(lines), merge_adjacent(shuffled));
        }
    }

    #[test]
    fn identical_schedules_have_no_diff() {
        let lines = [line(BAR, 10, 14), line(GATE, 16, 18)];
        assert!(diff(&lines, &lines).is_empty());
    }

    #[test]
    fn a_rename_alone_is_not_a_change() {
        let renamed = ScheduleLine {
            mission: "Buvette".to_owned(),
            ..line(BAR, 10, 14)
        };
        assert!(diff(&[line(BAR, 10, 14)], &[renamed]).is_empty());
    }

    #[test]
    fn a_new_time_at_the_same_post_is_a_move() {
        let changes = diff(&[line(BAR, 10, 14)], &[line(BAR, 16, 20)]);
        assert_eq!(
            changes.moved,
            vec![Move {
                from: line(BAR, 10, 14),
                to: line(BAR, 16, 20),
            }]
        );
        assert!(changes.added.is_empty() && changes.removed.is_empty());
    }

    #[test]
    fn a_new_post_is_a_removal_and_an_addition() {
        let changes = diff(&[line(BAR, 10, 14)], &[line(GATE, 10, 14)]);
        assert_eq!(changes.removed, vec![line(BAR, 10, 14)]);
        assert_eq!(changes.added, vec![line(GATE, 10, 14)]);
        assert!(changes.moved.is_empty());
    }

    #[test]
    fn unequal_counts_pair_in_time_order_and_leave_the_rest() {
        let changes = diff(
            &[line(BAR, 10, 12), line(BAR, 20, 22)],
            &[line(BAR, 11, 13), line(BAR, 21, 23), line(BAR, 30, 32)],
        );
        assert_eq!(
            changes.moved,
            vec![
                Move {
                    from: line(BAR, 10, 12),
                    to: line(BAR, 11, 13),
                },
                Move {
                    from: line(BAR, 20, 22),
                    to: line(BAR, 21, 23),
                },
            ]
        );
        assert_eq!(changes.added, vec![line(BAR, 30, 32)]);
        assert!(changes.removed.is_empty());

        let shrunk = diff(
            &[line(BAR, 10, 12), line(BAR, 20, 22)],
            &[line(BAR, 11, 13)],
        );
        assert_eq!(shrunk.moved.len(), 1);
        assert_eq!(shrunk.removed, vec![line(BAR, 20, 22)]);
    }

    #[test]
    fn everything_removed_is_reported_chronologically() {
        let changes = diff(&[line(GATE, 16, 18), line(BAR, 10, 14)], &[]);
        assert_eq!(changes.removed, vec![line(BAR, 10, 14), line(GATE, 16, 18)]);
    }

    #[test]
    fn lines_round_trip_through_the_snapshot_payload() {
        let lines = vec![line(BAR, 10, 14)];
        let json = serde_json::to_value(&lines).expect("serialises");
        assert_eq!(json[0]["mission"], "Bar");
        assert_eq!(json[0]["start"], "2026-09-05T10:00:00Z");
        let back: Vec<ScheduleLine> = serde_json::from_value(json).expect("deserialises");
        assert_eq!(back, lines);
    }
}
