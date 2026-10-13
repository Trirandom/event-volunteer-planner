// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Opaque bearer tokens: session cookies today, capability URLs and magic
//! links when they land.
//!
//! A token is random bytes and nothing else. It carries no user id, no claims
//! and no signature, so there is nothing in it to verify and nothing in it to
//! leak — the server looks it up. That is what makes revocation a row update
//! rather than a key rotation that signs every user out at once (docs/12, T5).

use argon2::password_hash::rand_core::{OsRng, RngCore as _};
use secrecy::{ExposeSecret as _, SecretString};
use sha2::{Digest as _, Sha256};

/// Bytes of entropy behind every token.
///
/// 32 is the number that makes offline guessing irrelevant, and it is why the
/// stored hash is SHA-256 rather than Argon2: there is no dictionary to stretch
/// against, and the hash is computed on every authenticated request.
pub const TOKEN_BYTES: usize = 32;

/// The digest stored in `sessions.token_hash`.
pub type TokenHash = [u8; 32];

/// A bearer token in its secret form — the value that goes in the cookie and
/// is never stored.
///
/// `Debug` is derived from [`SecretString`], which redacts: a token logged by
/// accident is a session anybody can resume, so redaction is structural here
/// rather than a habit (docs/12 §5).
#[derive(Debug, Clone)]
pub struct Token(SecretString);

impl Token {
    /// Mint a new token from the OS CSPRNG.
    #[must_use]
    pub fn generate() -> Self {
        let mut bytes = [0_u8; TOKEN_BYTES];
        OsRng.fill_bytes(&mut bytes);
        Self(SecretString::from(hex(&bytes)))
    }

    /// Take a token as presented by a client. No validation: an attacker
    /// controls this string entirely, so the only thing that can be said about
    /// it is whether its hash is in the table.
    #[must_use]
    pub fn from_client(raw: &str) -> Self {
        Self(SecretString::from(raw.to_owned()))
    }

    /// What to store, and what to look up by.
    ///
    /// Hashing is what stops a database dump from being a set of live sessions
    /// (docs/12, T8). Lookup is by this value, so the comparison happens inside
    /// PostgreSQL's index on a value the attacker would have to preimage.
    #[must_use]
    pub fn hash(&self) -> TokenHash {
        Sha256::digest(self.0.expose_secret().as_bytes()).into()
    }

    /// The secret form, for the one place that needs it: writing the cookie.
    #[must_use]
    pub fn expose(&self) -> &str {
        self.0.expose_secret()
    }
}

/// Lowercase hex, written out rather than pulled in.
///
/// A dependency for sixteen characters of lookup table would be a dependency to
/// audit under AGPL and to keep current for the life of the project
/// (CONTRIBUTING.md). Hex rather than base64 for the same reason: no padding,
/// no URL-safe variant to get wrong, and every byte is a cookie-safe character.
pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        // `char::from_digit` rather than a lookup table, because the workspace
        // denies `indexing_slicing`: a table would be provably in range here
        // and still a `[]` for a reader to verify. Both nibbles are < 16, so
        // neither call can return `None`, and `extend` over the `Option`
        // expresses that without an `unwrap` the lints also deny.
        out.extend(char::from_digit(u32::from(byte >> 4), 16));
        out.extend(char::from_digit(u32::from(byte & 0x0f), 16));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{TOKEN_BYTES, Token, hex};

    #[test]
    fn a_token_is_hex_of_the_full_entropy() {
        let token = Token::generate();
        assert_eq!(token.expose().len(), TOKEN_BYTES * 2);
        assert!(token.expose().chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn two_tokens_are_not_the_same_token() {
        // A generator that repeats is a generator that hands one user another
        // user's session.
        let first = Token::generate();
        let second = Token::generate();
        assert_ne!(first.expose(), second.expose());
        assert_ne!(first.hash(), second.hash());
    }

    #[test]
    fn hashing_is_deterministic_so_a_returning_cookie_looks_itself_up() {
        let token = Token::generate();
        let presented = Token::from_client(token.expose());
        assert_eq!(token.hash(), presented.hash());
    }

    #[test]
    fn the_hash_is_not_the_token() {
        // Guards against the hash accidentally becoming the identity function,
        // which would make the stored value directly usable as a cookie.
        let token = Token::generate();
        assert_ne!(hex(&token.hash()), token.expose());
    }

    #[test]
    fn hex_encodes_both_nibbles_in_order() {
        assert_eq!(hex(&[0x00, 0x0f, 0xf0, 0xff]), "000ff0ff");
    }
}
