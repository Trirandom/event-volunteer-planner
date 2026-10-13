// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The public form's proof of work, as the API holds it (ADR-0043): the
//! signing key, the difficulty, and the solutions already spent.
//!
//! The protocol itself is `evp_domain::captcha`. What lives here is state:
//! a solution is good for one submission, so a script cannot solve once and
//! post a thousand times. The spent set is in memory — this API runs as one
//! replica (docs/02), the set only has to outlive a challenge's lifetime, and
//! a restart forgetting it costs a bot one extra submission per challenge it
//! had already solved, inside a rate limit. A second replica moves it to a
//! table.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use evp_domain::captcha::{self, Challenge, Refusal, Solution};

/// The default search space: about a second of hashing on a phone, spent
/// while the volunteer is still reading the first question.
pub const DEFAULT_MAX_NUMBER: u64 = 100_000;

/// How long a challenge stays valid. Long, because a volunteer may leave the
/// form open over lunch; the bundle fetches a new one if it has lapsed.
const LIFETIME_SECONDS: i64 = 6 * 60 * 60;

#[derive(Clone)]
pub struct CaptchaPolicy {
    key: Arc<[u8; 32]>,
    max_number: u64,
    /// Challenge → the expiry after which it could not be replayed anyway.
    spent: Arc<Mutex<HashMap<String, i64>>>,
}

impl std::fmt::Debug for CaptchaPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaptchaPolicy")
            .field("key", &"[redacted]")
            .field("max_number", &self.max_number)
            .finish_non_exhaustive()
    }
}

impl CaptchaPolicy {
    /// Signing with a key derived from `secret` (`EVP_SECRET_KEY_FILE`).
    #[must_use]
    pub fn from_secret(secret: &[u8], max_number: u64) -> Option<Self> {
        Some(Self {
            key: Arc::new(captcha::derive_key(secret)?),
            max_number,
            spent: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(crate) fn issue(&self, now: i64) -> Challenge {
        captcha::issue(
            self.key.as_slice(),
            now.saturating_add(LIFETIME_SECONDS),
            self.max_number,
        )
    }

    pub(crate) fn verify(&self, solution: &Solution, now: i64) -> Result<(), Refusal> {
        captcha::verify(self.key.as_slice(), solution, now)?;
        let spent = self.spent.lock().unwrap_or_else(PoisonError::into_inner);
        if spent.contains_key(&solution.challenge) {
            return Err(Refusal::WrongAnswer);
        }
        Ok(())
    }

    /// Marks a verified solution used. `false` if another request spent it
    /// first — two submissions racing on one solution get one success.
    pub(crate) fn spend(&self, solution: &Solution, now: i64) -> bool {
        let mut spent = self.spent.lock().unwrap_or_else(PoisonError::into_inner);
        // Swept here rather than on a timer: the set only grows when a
        // submission is accepted, which the rate limit already bounds.
        spent.retain(|_, expires_at| *expires_at >= now);
        let expires_at = now.saturating_add(LIFETIME_SECONDS);
        spent
            .insert(solution.challenge.clone(), expires_at)
            .is_none()
    }
}
