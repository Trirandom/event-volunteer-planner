// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! AEAD sealing for values that must be *recoverable*, not hashed —
//! `intake_sources.webhook_secret_encrypted` reserves the column, ADR-0034
//! is what actually pins the algorithm and the first real caller
//! (`org_sms_settings.application_secret_encrypted` /
//! `.consumer_key_encrypted`).
//!
//! Keyed by `EVP_SECRET_KEY_FILE` — 32 bytes, deployment-wide, never in the
//! database (docs/06 §2). This module never reads that file itself; it is
//! handed the key material by the caller (`evp-api`/`evp-bin`), which is why
//! it takes `&EncryptionKey` rather than an environment variable name.

use chacha20poly1305::aead::{Aead as _, KeyInit as _};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use secrecy::{ExposeSecret as _, SecretString};

use crate::DbError;

/// 96 bits, the size ChaCha20-Poly1305 requires.
const NONCE_LEN: usize = 12;

/// `EVP_SECRET_KEY_FILE`'s 32 bytes, wrapped so the rest of this crate never
/// handles a bare `[u8; 32]` — [`secrecy::SecretString`] redacts in `Debug`
/// and zeroises on drop, the same guarantee every other secret in this
/// system gets (docs/17 §"Secrets and cryptography").
///
/// `Clone` is implemented by hand rather than derived, because
/// `SecretString` itself deliberately does not implement it: every copy
/// rebuilds a fresh `SecretString` from the exposed bytes. `ApiState` — and
/// therefore this — is cloned once per request by axum's `State` extractor
/// (`docs/02 §3`), which is an unavoidable, ordinary copy, not the kind of
/// silent proliferation `secrecy` is guarding against by leaving `Clone` off
/// its own type.
#[derive(Debug)]
pub struct EncryptionKey(SecretString);

impl Clone for EncryptionKey {
    fn clone(&self) -> Self {
        Self(SecretString::from(self.0.expose_secret().to_owned()))
    }
}

impl EncryptionKey {
    /// `raw` must be exactly 32 bytes — `evp-bin`'s config layer checks that
    /// length once at startup (`check_key_length`), so this constructor
    /// trusts its caller rather than re-validating on every request.
    #[must_use]
    pub fn new(raw: SecretString) -> Self {
        Self(raw)
    }

    fn cipher(&self) -> Result<ChaCha20Poly1305, DbError> {
        let key =
            Key::try_from(self.0.expose_secret().as_bytes()).map_err(|_error| DbError::Crypto)?;
        Ok(ChaCha20Poly1305::new(&key))
    }
}

/// Seals `plaintext` under a fresh random nonce, returning `nonce ||
/// ciphertext` — the nonce travels with the value because it is not secret,
/// only ever reused-must-not-be, and storing it alongside is simpler than a
/// second column per encrypted field.
///
/// # Errors
///
/// [`DbError::Crypto`] if the OS CSPRNG is unavailable or the cipher itself
/// refuses (it does not, for a well-formed 32-byte key — this is defensive).
pub fn encrypt(key: &EncryptionKey, plaintext: &str) -> Result<Vec<u8>, DbError> {
    let mut nonce_bytes = [0_u8; NONCE_LEN];
    getrandom::fill(&mut nonce_bytes).map_err(|_error| DbError::Crypto)?;
    let nonce = Nonce::try_from(&nonce_bytes[..]).map_err(|_error| DbError::Crypto)?;

    let ciphertext = key
        .cipher()?
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_error| DbError::Crypto)?;

    let mut sealed = Vec::with_capacity(NONCE_LEN.saturating_add(ciphertext.len()));
    sealed.extend_from_slice(&nonce_bytes);
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// The inverse of [`encrypt`]. Fails closed: a `sealed` value shorter than
/// the nonce, sealed under a different key (a rotation half-applied), or
/// tampered with all come back as the same [`DbError::Crypto`] — there is
/// nothing a caller can safely do differently for any of the three.
///
/// # Errors
///
/// [`DbError::Crypto`] if `sealed` is too short to contain a nonce, or if
/// authentication fails.
pub fn decrypt(key: &EncryptionKey, sealed: &[u8]) -> Result<String, DbError> {
    if sealed.len() <= NONCE_LEN {
        return Err(DbError::Crypto);
    }
    let (nonce_bytes, ciphertext) = sealed.split_at(NONCE_LEN);
    let nonce = Nonce::try_from(nonce_bytes).map_err(|_error| DbError::Crypto)?;

    let plaintext = key
        .cipher()?
        .decrypt(&nonce, ciphertext)
        .map_err(|_error| DbError::Crypto)?;

    String::from_utf8(plaintext).map_err(|_error| DbError::Crypto)
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;

    use super::*;

    fn key() -> EncryptionKey {
        EncryptionKey::new(SecretString::from("0".repeat(32)))
    }

    #[test]
    fn round_trips() {
        let sealed = encrypt(&key(), "top secret consumer key").expect("encrypt");
        let opened = decrypt(&key(), &sealed).expect("decrypt");
        assert_eq!(opened, "top secret consumer key");
    }

    #[test]
    fn two_encryptions_of_the_same_plaintext_differ() {
        // Proves the nonce is not fixed: a fixed or reused nonce under CTR-mode
        // Poly1305 is a full key-recovery break, not a theoretical concern.
        let sealed_a = encrypt(&key(), "same value").expect("encrypt a");
        let sealed_b = encrypt(&key(), "same value").expect("encrypt b");
        assert_ne!(sealed_a, sealed_b);
    }

    #[test]
    fn wrong_key_fails_closed() {
        let sealed = encrypt(&key(), "secret").expect("encrypt");
        let other = EncryptionKey::new(SecretString::from("1".repeat(32)));
        assert!(decrypt(&other, &sealed).is_err());
    }

    #[test]
    fn truncated_ciphertext_fails_closed() {
        let mut sealed = encrypt(&key(), "secret").expect("encrypt");
        sealed.truncate(NONCE_LEN);
        assert!(decrypt(&key(), &sealed).is_err());
    }
}
