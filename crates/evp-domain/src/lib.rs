// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Pure domain: entities, value objects and the constraint engine.
//!
//! This crate depends on no other `evp-*` crate and does no I/O
//! ([docs/02 §3](../../../docs/02-architecture.md)). That is what makes the
//! constraint engine unit-testable without a database, and what keeps
//! `cargo-mutants` over it fast enough to demand zero survivors (docs/13 §9).

pub mod captcha;
pub mod example;
pub mod form;
pub mod generate;
pub mod password;
pub mod schedule;
pub mod submission;
pub mod token;

use jiff::Timestamp;

/// The only source of "now" in the system.
///
/// Business logic never reads the wall clock and never asks PostgreSQL for
/// `now()`. A test that depends on real time is a flaky test waiting for a DST
/// boundary ([ADR-0019](../../../docs/adr/0019-time-discipline.md),
/// docs/13 §8).
pub trait Clock: std::fmt::Debug + Send + Sync {
    /// The current instant.
    fn now(&self) -> Timestamp;
}

/// Reads the host clock. Constructed exactly once, in the composition root.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    #[expect(
        clippy::disallowed_methods,
        reason = "the single place the wall clock is read; every other caller takes a Clock"
    )]
    fn now(&self) -> Timestamp {
        Timestamp::now()
    }
}

#[cfg(test)]
mod tests {
    use super::{Clock as _, SystemClock};

    #[test]
    fn system_clock_is_monotonic_across_two_reads() {
        let clock = SystemClock;
        let first = clock.now();
        let second = clock.now();
        assert!(
            second >= first,
            "the host clock went backwards between two reads: {first} then {second}"
        );
    }
}
