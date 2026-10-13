// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Cutting a working window into slots: the walk behind
//! `POST …/shifts/generate` (docs/04 §"Generating shifts", ADR-0029).
//!
//! Pure: it takes a pattern, a local date, a wall-clock window and a time
//! zone, and returns the instants. It reads no clock, touches no database and
//! knows nothing about locations — which is what lets every DST case below be
//! a unit test rather than a fixture.
//!
//! # The walk runs in wall-clock time
//!
//! This is the whole design, and the naive implementation gets it backwards.
//! A coordinator says "09:00 to 14:00, in two-hour slots"; they mean local
//! clock readings, in the event's zone. So the cursor here is a
//! [`jiff::civil::DateTime`] — a date and a time with no offset and no instant
//! behind it — and it is only resolved against the zone at the very end
//! ([ADR-0019](../../../docs/adr/0019-time-discipline.md)).
//!
//! Three consequences, each of which is a bug in the obvious version:
//!
//! * **A window crossing spring-forward is genuinely shorter in real time.**
//!   01:00–05:00 on the day Europe/Paris skips 02:00–03:00 is three hours of
//!   elapsed time, not four, and the daily-hours rule must agree with that.
//!   Walking in instants would silently produce four.
//! * **A segment landing on a nonexistent local time is refused**, not
//!   shifted by an hour. `jiff`'s default disambiguation would helpfully move
//!   it forward; helpfully moving a coordinator's 02:00 shift to 03:00 without
//!   telling them is how a schedule becomes quietly wrong.
//! * **A repeated local time resolves to its first occurrence.** On the
//!   fall-back day, 02:30 happens twice; the earlier one is taken, so
//!   consecutive slots stay consecutive in real time rather than jumping
//!   backwards.

use jiff::civil::{Date, DateTime, Time};
use jiff::tz::{AmbiguousOffset, TimeZone};
use jiff::{SignedDuration, Timestamp};

/// How the segment list is laid across the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Repeat {
    /// Repeat the list until the window is used up.
    Tile,
    /// Lay the list down a single time.
    Once,
}

/// What a `tile` pattern does with time left at the end of the window. Never
/// rounded up — a slot the coordinator did not ask for is a slot nobody staffs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnRemainder {
    /// Leave it unstaffed. The default.
    Drop,
    /// Emit a shorter final shift covering it.
    Truncate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentKind {
    /// Produces a shift.
    Shift,
    /// Consumes window time and produces nothing. Visible in a dry run only as
    /// the space between two slots.
    Gap,
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub kind: SegmentKind,
    pub duration_minutes: i64,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Pattern {
    pub repeat: Repeat,
    pub on_remainder: OnRemainder,
    pub segments: Vec<Segment>,
}

/// The local wall-clock window a day is cut from.
///
/// `end <= start` means the window runs past midnight into the next local day
/// — an after-party from 23:00 to 04:00 is one window, not two — which is the
/// case a same-day comparison silently turns into an empty window.
#[derive(Debug, Clone, Copy)]
pub struct Window {
    pub start: Time,
    pub end: Time,
}

/// One generated slot, as instants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub start: Timestamp,
    pub end: Timestamp,
    /// Carried through from the segment that produced it, so `45/45/90/45/45`
    /// can name its long middle slot.
    pub label: Option<String>,
}

/// What one day of one location produced.
#[derive(Debug, Clone)]
pub struct DayPlan {
    pub slots: Vec<Slot>,
    /// Wall-clock minutes of the window the pattern did not cover. Reported
    /// whatever `on_remainder` then does with them, because "the division does
    /// not fit this window" is information a coordinator wants before they
    /// look for the missing hour on the board.
    pub remainder_minutes: i64,
}

/// Why a day could not be laid out.
///
/// Each variant carries the *local* time it concerns, not an instant: the
/// coordinator typed local times, and an error quoting `2026-03-29T01:00:00Z`
/// at someone who asked for 02:00 is an error they have to decode.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GenerateError {
    /// A segment boundary fell in a spring-forward gap. Refused rather than
    /// nudged (see the module documentation).
    #[error("{local} does not exist in this time zone")]
    NonexistentLocalTime { local: DateTime },
    /// A `once` pattern is longer than the window it was asked to fill. The
    /// coordinator's window and their pattern disagree, and picking one of
    /// them silently is how a schedule becomes wrong.
    #[error("the pattern would have ended at {local}, past the window")]
    OnceOverrunsWindow { local: DateTime },
    /// A pattern whose segments total nothing would tile forever.
    ///
    /// Unreachable through the API — the schema's `CHECK (duration_minutes
    /// BETWEEN 5 AND 1440)` and the well-formedness trigger both refuse it —
    /// and kept as a real error anyway, because a pure function must not
    /// depend on its caller having checked.
    #[error("the pattern has no duration and would repeat forever")]
    EmptyPattern,
    /// Date arithmetic left the range `jiff` represents.
    #[error("a generated boundary is not a representable date")]
    OutOfRange,
}

impl Window {
    /// The window as two local datetimes on (or after) `day`.
    fn bounds(self, day: Date) -> Result<(DateTime, DateTime), GenerateError> {
        let start = day.at(
            self.start.hour(),
            self.start.minute(),
            self.start.second(),
            0,
        );
        let mut end = day.at(self.end.hour(), self.end.minute(), self.end.second(), 0);
        if end <= start {
            // Past midnight. One window, not two — see the type's docs.
            end = end
                .checked_add(SignedDuration::from_hours(24))
                .map_err(|_| GenerateError::OutOfRange)?;
        }
        Ok((start, end))
    }
}

/// Wall-clock minutes between two local datetimes.
///
/// Wall-clock, not elapsed: `jiff` subtracts civil datetimes without consulting
/// any zone, which is exactly what is wanted here — the remainder a coordinator
/// sees is "an hour of my window is unused", measured on the clock on the wall.
fn wall_minutes(from: DateTime, to: DateTime) -> i64 {
    to.duration_since(from).as_mins()
}

/// Resolves one local datetime to an instant, refusing a nonexistent one.
///
/// `jiff`'s `AmbiguousZoned` is the right primitive precisely because it makes
/// the three cases explicit. `Unambiguous` is the ordinary day. `Later` is a
/// spring-forward gap — the offset that *would* apply after the jump, which is
/// `jiff` telling us this local time does not exist — and is refused.
/// `Earlier` is a fall-back repeat, where the first occurrence is taken so
/// consecutive slots do not run backwards.
fn resolve(zone: &TimeZone, local: DateTime) -> Result<Timestamp, GenerateError> {
    let ambiguous = zone.to_ambiguous_timestamp(local);
    match ambiguous.offset() {
        AmbiguousOffset::Unambiguous { offset } | AmbiguousOffset::Fold { before: offset, .. } => {
            offset
                .to_timestamp(local)
                .map_err(|_| GenerateError::OutOfRange)
        }
        AmbiguousOffset::Gap { .. } => Err(GenerateError::NonexistentLocalTime { local }),
    }
}

/// Cuts one day's window into slots.
///
/// # Errors
///
/// [`GenerateError::NonexistentLocalTime`] if any boundary falls in a
/// spring-forward gap, [`GenerateError::OnceOverrunsWindow`] if a `once`
/// pattern is longer than the window, [`GenerateError::EmptyPattern`] for a
/// pattern of zero total duration, and [`GenerateError::OutOfRange`] for a
/// boundary `jiff` cannot represent.
pub fn plan_day(
    zone: &TimeZone,
    day: Date,
    window: Window,
    pattern: &Pattern,
) -> Result<DayPlan, GenerateError> {
    let (window_start, window_end) = window.bounds(day)?;

    let cycle_minutes: i64 = pattern
        .segments
        .iter()
        .try_fold(0_i64, |total, segment| {
            total.checked_add(segment.duration_minutes)
        })
        .ok_or(GenerateError::OutOfRange)?;
    if cycle_minutes <= 0 {
        return Err(GenerateError::EmptyPattern);
    }

    // `once` is decided up front rather than discovered mid-walk, because the
    // error has to name where the pattern *would* have ended — which is only
    // knowable from the whole list, not from the segment that first overran.
    if pattern.repeat == Repeat::Once {
        let pattern_end = window_start
            .checked_add(SignedDuration::from_mins(cycle_minutes))
            .map_err(|_| GenerateError::OutOfRange)?;
        if pattern_end > window_end {
            return Err(GenerateError::OnceOverrunsWindow { local: pattern_end });
        }
    }

    let mut slots = Vec::new();
    let mut cursor = window_start;

    loop {
        for segment in &pattern.segments {
            if cursor >= window_end {
                break;
            }
            let segment_end = cursor
                .checked_add(SignedDuration::from_mins(segment.duration_minutes))
                .map_err(|_| GenerateError::OutOfRange)?;

            if segment_end > window_end {
                // The pattern ran off the end of the window. `once` was
                // already refused above, so this is a tiling remainder.
                let remainder = wall_minutes(cursor, window_end);
                if pattern.on_remainder == OnRemainder::Truncate
                    && segment.kind == SegmentKind::Shift
                    && remainder > 0
                {
                    slots.push(Slot {
                        start: resolve(zone, cursor)?,
                        end: resolve(zone, window_end)?,
                        label: segment.label.clone(),
                    });
                }
                return Ok(DayPlan {
                    slots,
                    remainder_minutes: remainder,
                });
            }

            if segment.kind == SegmentKind::Shift {
                slots.push(Slot {
                    start: resolve(zone, cursor)?,
                    end: resolve(zone, segment_end)?,
                    label: segment.label.clone(),
                });
            }
            cursor = segment_end;
        }

        if pattern.repeat == Repeat::Once || cursor >= window_end {
            return Ok(DayPlan {
                slots,
                remainder_minutes: wall_minutes(cursor, window_end).max(0),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DayPlan, GenerateError, OnRemainder, Pattern, Repeat, Segment, SegmentKind, Window,
        plan_day,
    };
    use jiff::civil::{date, time};
    use jiff::tz::TimeZone;

    fn paris() -> TimeZone {
        TimeZone::get("Europe/Paris").expect("Europe/Paris is in the tzdb")
    }

    fn shift(duration_minutes: i64) -> Segment {
        Segment {
            kind: SegmentKind::Shift,
            duration_minutes,
            label: None,
        }
    }

    fn gap(duration_minutes: i64) -> Segment {
        Segment {
            kind: SegmentKind::Gap,
            duration_minutes,
            label: None,
        }
    }

    fn tiling(segments: Vec<Segment>) -> Pattern {
        Pattern {
            repeat: Repeat::Tile,
            on_remainder: OnRemainder::Drop,
            segments,
        }
    }

    fn window(start: (i8, i8), end: (i8, i8)) -> Window {
        Window {
            start: time(start.0, start.1, 0, 0),
            end: time(end.0, end.1, 0, 0),
        }
    }

    /// Elapsed real minutes a plan covers, gaps excluded. The number the
    /// daily-hours rule will later read, and the one that must disagree with
    /// wall-clock arithmetic across a DST boundary.
    fn real_minutes(plan: &DayPlan) -> i64 {
        plan.slots
            .iter()
            .map(|slot| slot.end.duration_since(slot.start).as_mins())
            .sum()
    }

    #[test]
    fn a_pattern_that_divides_the_window_leaves_no_remainder() {
        let plan = plan_day(
            &paris(),
            date(2026, 7, 4),
            window((9, 0), (15, 0)),
            &tiling(vec![shift(120)]),
        )
        .expect("an ordinary day divides cleanly");

        assert_eq!(plan.slots.len(), 3);
        assert_eq!(plan.remainder_minutes, 0);
        assert_eq!(real_minutes(&plan), 360);
    }

    #[test]
    fn gaps_consume_window_time_and_produce_nothing() {
        let plan = plan_day(
            &paris(),
            date(2026, 7, 4),
            window((9, 0), (15, 0)),
            &tiling(vec![shift(60), gap(60)]),
        )
        .expect("plan");

        assert_eq!(plan.slots.len(), 3, "three shifts, three gaps between them");
        assert_eq!(real_minutes(&plan), 180);
        // A gap is visible only as the space between two slots (docs/04).
        let first_end = plan.slots.first().map(|slot| slot.end);
        let second_start = plan.slots.get(1).map(|slot| slot.start);
        assert_ne!(first_end, second_start);
    }

    /// `45 / 45 / 90 / 45 / 45` — the *artiste* post from ADR-0029, and the
    /// reason patterns exist. Deliberately uneven: a generator that averaged,
    /// sorted or rounded would still produce five plausible-looking slots.
    #[test]
    fn the_artiste_pattern_keeps_its_uneven_slots_in_order() {
        let segments = vec![
            shift(45),
            shift(45),
            Segment {
                kind: SegmentKind::Shift,
                duration_minutes: 90,
                label: Some("Set".to_owned()),
            },
            shift(45),
            shift(45),
        ];
        let plan = plan_day(
            &paris(),
            date(2026, 7, 4),
            // 45+45+90+45+45 = 270 minutes, so 18:00–22:30 is exactly one
            // cycle. A window that fits one and a bit would be a remainder
            // test, which is the next one down.
            window((18, 0), (22, 30)),
            &tiling(segments),
        )
        .expect("plan");

        let lengths: Vec<i64> = plan
            .slots
            .iter()
            .map(|slot| slot.end.duration_since(slot.start).as_mins())
            .collect();
        assert_eq!(lengths, vec![45, 45, 90, 45, 45]);
        assert_eq!(plan.remainder_minutes, 0);
        assert_eq!(
            plan.slots.get(2).and_then(|slot| slot.label.as_deref()),
            Some("Set"),
            "a segment's label travels with the slot it produced"
        );
    }

    #[test]
    fn a_tiling_remainder_is_dropped_by_default_and_reported_either_way() {
        let dropped = plan_day(
            &paris(),
            date(2026, 7, 4),
            window((9, 0), (14, 0)),
            &tiling(vec![shift(120)]),
        )
        .expect("plan");

        assert_eq!(dropped.slots.len(), 2, "09–11 and 11–13; 13–14 is left");
        assert_eq!(dropped.remainder_minutes, 60);
        assert_eq!(real_minutes(&dropped), 240, "never rounded up");
    }

    #[test]
    fn truncate_emits_a_shorter_final_shift_for_the_remainder() {
        let pattern = Pattern {
            repeat: Repeat::Tile,
            on_remainder: OnRemainder::Truncate,
            segments: vec![shift(120)],
        };
        let plan = plan_day(
            &paris(),
            date(2026, 7, 4),
            window((9, 0), (14, 0)),
            &pattern,
        )
        .expect("plan");

        assert_eq!(plan.slots.len(), 3);
        assert_eq!(plan.remainder_minutes, 60);
        assert_eq!(
            plan.slots
                .last()
                .map(|slot| slot.end.duration_since(slot.start).as_mins()),
            Some(60),
            "the final shift is the remainder, not a full-length one"
        );
    }

    /// A remainder landing on a `gap` segment is not a shift, whatever
    /// `on_remainder` says: truncating a gap would invent a slot out of time
    /// the pattern deliberately left empty.
    #[test]
    fn truncate_does_not_turn_a_trailing_gap_into_a_shift() {
        let pattern = Pattern {
            repeat: Repeat::Tile,
            on_remainder: OnRemainder::Truncate,
            segments: vec![shift(60), gap(60)],
        };
        let plan = plan_day(
            &paris(),
            date(2026, 7, 4),
            window((9, 0), (10, 30)),
            &pattern,
        )
        .expect("plan");

        assert_eq!(plan.slots.len(), 1, "09–10; the 10–10:30 leftover is a gap");
        assert_eq!(plan.remainder_minutes, 30);
    }

    #[test]
    fn a_once_pattern_longer_than_its_window_is_refused_naming_where_it_would_end() {
        let pattern = Pattern {
            repeat: Repeat::Once,
            on_remainder: OnRemainder::Drop,
            segments: vec![shift(120), shift(120)],
        };
        let error = plan_day(
            &paris(),
            date(2026, 7, 4),
            window((9, 0), (12, 0)),
            &pattern,
        )
        .expect_err("a four-hour pattern does not fit a three-hour window");

        assert_eq!(
            error,
            GenerateError::OnceOverrunsWindow {
                local: date(2026, 7, 4).at(13, 0, 0, 0)
            },
            "the error names the local time the pattern would have ended at"
        );
    }

    #[test]
    fn a_once_pattern_shorter_than_its_window_reports_the_rest_as_remainder() {
        let pattern = Pattern {
            repeat: Repeat::Once,
            on_remainder: OnRemainder::Drop,
            segments: vec![shift(120)],
        };
        let plan = plan_day(
            &paris(),
            date(2026, 7, 4),
            window((9, 0), (14, 0)),
            &pattern,
        )
        .expect("plan");

        assert_eq!(plan.slots.len(), 1, "once means once");
        assert_eq!(plan.remainder_minutes, 180);
    }

    // -----------------------------------------------------------------------
    // Time zones. Europe/Paris springs forward 2026-03-29 (02:00 → 03:00) and
    // falls back 2026-10-25 (03:00 → 02:00).
    // -----------------------------------------------------------------------

    #[test]
    fn a_segment_landing_in_a_spring_forward_gap_is_refused_not_nudged() {
        let error = plan_day(
            &paris(),
            date(2026, 3, 29),
            window((1, 0), (5, 0)),
            &tiling(vec![shift(60)]),
        )
        .expect_err("02:00 does not exist on this day");

        assert_eq!(
            error,
            GenerateError::NonexistentLocalTime {
                local: date(2026, 3, 29).at(2, 0, 0, 0)
            },
            "the refusal names the local time that does not exist"
        );
    }

    /// The consequence docs/04 §"Generating shifts" calls out by name: a
    /// window crossing spring-forward yields a shift genuinely shorter in real
    /// time, and the daily-hours rule must agree with it.
    #[test]
    fn a_window_crossing_spring_forward_is_an_hour_shorter_in_real_time() {
        let pattern = Pattern {
            repeat: Repeat::Once,
            on_remainder: OnRemainder::Drop,
            segments: vec![shift(240)],
        };
        let plan = plan_day(
            &paris(),
            date(2026, 3, 29),
            window((1, 0), (5, 0)),
            &pattern,
        )
        .expect("neither 01:00 nor 05:00 is in the gap");

        assert_eq!(plan.slots.len(), 1);
        assert_eq!(
            real_minutes(&plan),
            180,
            "four hours on the wall is three hours of elapsed time that day"
        );
    }

    #[test]
    fn a_window_crossing_fall_back_is_an_hour_longer_in_real_time() {
        let pattern = Pattern {
            repeat: Repeat::Once,
            on_remainder: OnRemainder::Drop,
            segments: vec![shift(240)],
        };
        let plan = plan_day(
            &paris(),
            date(2026, 10, 25),
            window((1, 0), (5, 0)),
            &pattern,
        )
        .expect("plan");

        assert_eq!(real_minutes(&plan), 300);
    }

    /// On the fall-back day 02:30 happens twice. Taking the second would make
    /// the slot that starts at 02:00 end *before* the one that starts at 02:30
    /// in real time.
    #[test]
    fn consecutive_slots_stay_consecutive_across_fall_back() {
        let plan = plan_day(
            &paris(),
            date(2026, 10, 25),
            window((1, 0), (5, 0)),
            &tiling(vec![shift(60)]),
        )
        .expect("plan");

        let mut previous_end = None;
        for slot in &plan.slots {
            assert!(slot.end > slot.start, "a slot runs forwards: {slot:?}");
            if let Some(previous_end) = previous_end {
                assert_eq!(
                    slot.start, previous_end,
                    "slots must abut in real time, not jump backwards"
                );
            }
            previous_end = Some(slot.end);
        }
        assert_eq!(
            real_minutes(&plan),
            300,
            "the repeated hour is staffed once, and the day is five real hours"
        );
    }

    #[test]
    fn a_window_running_past_midnight_is_one_window_not_an_empty_one() {
        let plan = plan_day(
            &paris(),
            date(2026, 7, 4),
            window((23, 0), (4, 0)),
            &tiling(vec![shift(60)]),
        )
        .expect("plan");

        assert_eq!(plan.slots.len(), 5, "23–00, 00–01, 01–02, 02–03, 03–04");
        assert_eq!(real_minutes(&plan), 300);
    }

    #[test]
    fn a_pattern_of_no_duration_does_not_tile_forever() {
        let error = plan_day(
            &paris(),
            date(2026, 7, 4),
            window((9, 0), (15, 0)),
            &tiling(Vec::new()),
        )
        .expect_err("an empty pattern would repeat forever");

        assert_eq!(error, GenerateError::EmptyPattern);
    }
}
