// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The public form's invisible captcha: a proof of work (ADR-0043).
//!
//! The server picks a secret number `n` at most `max_number`, and hands out
//! `challenge = sha256(salt ‖ n)` with the salt — never `n`. The browser
//! finds `n` by counting up from zero, in the background while the volunteer
//! types, and sends it back with the submission. A person never sees it; a
//! script posting a thousand submissions pays for a thousand searches.
//!
//! The challenge is signed (`HMAC-SHA256` under a key only the server holds),
//! so a client cannot mint an easy one of its own, and the salt carries its
//! own expiry, so an old solution cannot be kept and replayed for ever. Spent
//! solutions within that window are the caller's to remember.
//!
//! The wire shape is ALTCHA's (`algorithm`, `challenge`, `salt`, `maxnumber`,
//! `signature`), which is what the bundle's solver speaks — no library on
//! either side, the whole protocol is the two functions below.

use argon2::password_hash::rand_core::{OsRng, RngCore as _};
use hmac::{Hmac, KeyInit, Mac as _};
use sha2::{Digest as _, Sha256};

use crate::token::hex;

/// The only algorithm offered. Named on the wire so a client can refuse one
/// it does not know rather than search for ever.
pub const ALGORITHM: &str = "SHA-256";

/// What the form is served with.
#[derive(Debug, Clone, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "`challenge` is the protocol's own name for the field (ALTCHA)"
)]
pub struct Challenge {
    pub algorithm: &'static str,
    /// Lowercase hex of `sha256(salt ‖ n)`.
    pub challenge: String,
    /// `<random hex>?expires=<unix seconds>`: the expiry is inside what is
    /// hashed and signed, so it cannot be edited.
    pub salt: String,
    /// The search space: `n` is somewhere in `0..=max_number`.
    pub max_number: u64,
    /// Lowercase hex of `HMAC-SHA256(key, challenge)`.
    pub signature: String,
}

/// What a submission sends back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Solution {
    pub challenge: String,
    pub salt: String,
    pub number: u64,
    pub signature: String,
}

/// Why a solution was not accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// Not a challenge this server signed.
    #[error("the challenge was not issued by this server")]
    BadSignature,
    /// Signed, but `number` does not hash to it.
    #[error("the number does not solve the challenge")]
    WrongAnswer,
    /// Past the expiry written in its salt, or a salt with none.
    #[error("the challenge has expired")]
    Expired,
}

/// The signing key, derived from the deployment's secret so there is no
/// second secret to provision — and derived, not reused, so a captcha
/// signature is never a value the secret's other use (sealing webhook
/// secrets) could be confused with.
#[must_use]
pub fn derive_key(secret: &[u8]) -> Option<[u8; 32]> {
    let mut mac = mac(secret)?;
    mac.update(b"evp/form-captcha/v1");
    Some(mac.finalize().into_bytes().into())
}

/// A fresh challenge, valid until `expires_at` (unix seconds).
#[must_use]
pub fn issue(key: &[u8], expires_at: i64, max_number: u64) -> Challenge {
    let mut random = [0_u8; 12];
    OsRng.fill_bytes(&mut random);
    let number = if max_number == 0 {
        0
    } else {
        OsRng
            .next_u64()
            .checked_rem(max_number.saturating_add(1))
            .unwrap_or(0)
    };
    issue_with(key, expires_at, max_number, &random, number)
}

/// [`issue`], with the randomness supplied — for tests, which need to know
/// the answer.
#[must_use]
pub fn issue_with(
    key: &[u8],
    expires_at: i64,
    max_number: u64,
    random: &[u8],
    number: u64,
) -> Challenge {
    let salt = format!("{}?expires={expires_at}", hex(random));
    let challenge = digest(&salt, number);
    // An empty signature never verifies, which is the right failure for a
    // key HMAC refused — and HMAC refuses none.
    let signature = sign(key, &challenge)
        .map(|bytes| hex(&bytes))
        .unwrap_or_default();
    Challenge {
        algorithm: ALGORITHM,
        challenge,
        salt,
        max_number,
        signature,
    }
}

/// Is `solution` one this server issued, solved, and still in date at `now`
/// (unix seconds)?
///
/// # Errors
///
/// The first [`Refusal`] that applies, checked cheapest-to-forge first so a
/// forged challenge costs one HMAC and nothing more.
pub fn verify(key: &[u8], solution: &Solution, now: i64) -> Result<(), Refusal> {
    let signature = unhex(&solution.signature).ok_or(Refusal::BadSignature)?;
    let mut mac = mac(key).ok_or(Refusal::BadSignature)?;
    mac.update(solution.challenge.as_bytes());
    // Constant time: comparing a signature byte by byte would tell a patient
    // client how much of a forgery was right.
    mac.verify_slice(&signature)
        .map_err(|_| Refusal::BadSignature)?;

    let expires_at = solution
        .salt
        .rsplit_once("?expires=")
        .and_then(|(_, expires)| expires.parse::<i64>().ok())
        .ok_or(Refusal::Expired)?;
    if now > expires_at {
        return Err(Refusal::Expired);
    }
    if digest(&solution.salt, solution.number) != solution.challenge {
        return Err(Refusal::WrongAnswer);
    }
    Ok(())
}

/// What the browser does: count up until the hash matches. The bundle's
/// solver is this loop in TypeScript; this one is for tests and for anyone
/// reading what the protocol asks of a client.
#[must_use]
pub fn solve(salt: &str, challenge: &str, max_number: u64) -> Option<u64> {
    (0..=max_number).find(|number| digest(salt, *number) == challenge)
}

fn digest(salt: &str, number: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(number.to_string().as_bytes());
    hex(&hasher.finalize())
}

fn mac(key: &[u8]) -> Option<Hmac<Sha256>> {
    <Hmac<Sha256> as KeyInit>::new_from_slice(key).ok()
}

fn sign(key: &[u8], challenge: &str) -> Option<Vec<u8>> {
    let mut mac = mac(key)?;
    mac.update(challenge.as_bytes());
    Some(mac.finalize().into_bytes().to_vec())
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            let high = char::from(*pair.first()?).to_digit(16)?;
            let low = char::from(*pair.get(1)?).to_digit(16)?;
            u8::try_from(high.checked_mul(16)?.checked_add(low)?).ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"a key only the server holds, 32b";
    const NOW: i64 = 1_790_000_000;

    fn solved(number: u64) -> (Challenge, Solution) {
        let challenge = issue_with(KEY, NOW + 600, 1_000, &[7; 12], number);
        let solution = Solution {
            challenge: challenge.challenge.clone(),
            salt: challenge.salt.clone(),
            number,
            signature: challenge.signature.clone(),
        };
        (challenge, solution)
    }

    fn search(challenge: &Challenge) -> Option<u64> {
        solve(&challenge.salt, &challenge.challenge, challenge.max_number)
    }

    #[test]
    fn a_search_finds_the_number_and_it_verifies() {
        let challenge = issue(KEY, NOW + 600, 500);
        let number = search(&challenge).expect("the number is in range");
        let solution = Solution {
            challenge: challenge.challenge.clone(),
            salt: challenge.salt.clone(),
            number,
            signature: challenge.signature,
        };
        assert_eq!(verify(KEY, &solution, NOW), Ok(()));
        assert!(challenge.salt.ends_with(&format!("?expires={}", NOW + 600)));
        assert_eq!(challenge.algorithm, "SHA-256");
    }

    #[test]
    fn the_wrong_number_is_refused() {
        let (_, mut solution) = solved(42);
        solution.number = 41;
        assert_eq!(verify(KEY, &solution, NOW), Err(Refusal::WrongAnswer));
    }

    #[test]
    fn a_challenge_minted_by_the_client_is_refused() {
        let forged = issue_with(b"someone else's key", NOW + 600, 1, &[1; 12], 0);
        let solution = Solution {
            challenge: forged.challenge,
            salt: forged.salt,
            number: 0,
            signature: forged.signature,
        };
        assert_eq!(verify(KEY, &solution, NOW), Err(Refusal::BadSignature));
    }

    #[test]
    fn a_salt_edited_to_extend_its_expiry_no_longer_matches() {
        let (_, mut solution) = solved(42);
        solution.salt = solution
            .salt
            .replace(&(NOW + 600).to_string(), &(NOW + 9_999).to_string());
        assert_eq!(
            verify(KEY, &solution, NOW + 1_000),
            Err(Refusal::WrongAnswer),
            "the expiry is inside the hash, so moving it breaks the answer"
        );
    }

    #[test]
    fn expiry_is_inclusive_of_its_last_second() {
        let (_, solution) = solved(42);
        assert_eq!(verify(KEY, &solution, NOW + 600), Ok(()));
        assert_eq!(verify(KEY, &solution, NOW + 601), Err(Refusal::Expired));
    }

    #[test]
    fn garbage_is_refused_without_panicking() {
        for signature in ["", "z", "abc", "zz"] {
            let (_, mut solution) = solved(1);
            solution.signature = signature.to_owned();
            assert_eq!(verify(KEY, &solution, NOW), Err(Refusal::BadSignature));
        }
        let (_, mut solution) = solved(1);
        solution.salt = "no-expiry".to_owned();
        assert_eq!(verify(KEY, &solution, NOW), Err(Refusal::Expired));
    }

    #[test]
    fn a_zero_search_space_is_still_a_valid_challenge() {
        let challenge = issue(KEY, NOW + 600, 0);
        assert_eq!(search(&challenge), Some(0));
    }

    #[test]
    fn the_derived_key_is_stable_and_not_the_secret() {
        let key = derive_key(KEY).expect("a key");
        assert_eq!(derive_key(KEY), Some(key));
        assert_ne!(key.as_slice(), KEY);
        assert_ne!(derive_key(b"another secret"), Some(key));
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(unhex(&hex(&[0, 15, 16, 255])), Some(vec![0, 15, 16, 255]));
    }
}
