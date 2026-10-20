// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The backoffice key: what `EVP_BACKOFFICE_KEY` becomes once loaded, and the
//! one question ever asked of it (ADR-0045).

use secrecy::{ExposeSecret as _, SecretString};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;

/// The configured key, kept only as its SHA-256.
///
/// Hashing at load time does two jobs. The plain key is dropped with the
/// configuration rather than living for the life of the process in state that
/// is cloned per request. And every comparison is between two 32-byte digests,
/// so neither the comparison's duration nor an early exit on length can tell a
/// caller how long the real key is or how much of a guess was right.
#[derive(Clone)]
pub struct BackofficeKey([u8; 32]);

impl BackofficeKey {
    #[must_use]
    pub fn new(key: &SecretString) -> Self {
        Self(digest(key.expose_secret()))
    }

    /// Whether `presented` is the key.
    ///
    /// Constant-time over the digests (`subtle`): `==` on arrays may stop at
    /// the first differing byte, and that is a timing oracle for a value which
    /// is compared on every backoffice request.
    #[must_use]
    pub fn matches(&self, presented: &str) -> bool {
        digest(presented).ct_eq(&self.0).into()
    }
}

/// Redacted: the digest of a high-entropy key is not much use to anyone, but a
/// `Debug` that prints nothing is one fewer thing to reason about in a log.
impl std::fmt::Debug for BackofficeKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("BackofficeKey(..)")
    }
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;

    use super::BackofficeKey;

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn key() -> BackofficeKey {
        BackofficeKey::new(&SecretString::from(KEY))
    }

    #[test]
    fn the_configured_key_matches() {
        assert!(key().matches(KEY));
    }

    #[test]
    fn a_key_differing_in_its_last_character_does_not() {
        assert!(!key().matches("0123456789abcdef0123456789abcdee"));
    }

    #[test]
    fn a_prefix_of_the_key_does_not() {
        // A comparison that stopped at the shorter input would accept this.
        assert!(!key().matches("0123456789abcdef"));
    }

    #[test]
    fn the_key_with_trailing_whitespace_does_not() {
        // The header is matched exactly; trimming is the configuration
        // loader's job and is done once there.
        assert!(!key().matches(&format!("{KEY} ")));
    }

    #[test]
    fn the_empty_string_does_not() {
        assert!(!key().matches(""));
    }

    #[test]
    fn debug_does_not_print_the_digest() {
        assert_eq!(format!("{:?}", key()), "BackofficeKey(..)");
    }
}
