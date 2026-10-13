// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Password hashing, for the one credential this system stores.
//!
//! Lives in the pure crate because it is computation over values and touches
//! no database, which is what makes the properties below testable without one.
//!
//! Argon2id, not SHA-256, and the reason is the *input*: a password is chosen
//! by a human and is therefore in a dictionary somebody already owns. Session
//! and capability tokens are >=32 CSPRNG bytes and get SHA-256, because there
//! is nothing to stretch against and that hash is on the path of every request
//! (see the dependency register in Cargo.toml, docs/17).

use argon2::password_hash::{PasswordHash, PasswordHasher as _, PasswordVerifier as _, SaltString};
use argon2::{Argon2, password_hash};
use secrecy::{ExposeSecret as _, SecretString};

/// Below this, a password is not worth hashing well.
///
/// Deliberately a floor on length alone and not a composition rule: forcing a
/// digit and a symbol produces `Password1!` across an entire deployment, which
/// is weaker than the same budget spent on length. NIST SP 800-63B says the
/// same, and this is the bootstrap owner's credential — the account with the
/// most authority on the deployment.
pub const MIN_PASSWORD_LENGTH: usize = 12;

/// What can go wrong with a password, as distinct from what can go wrong with
/// a login. Kept separate from any HTTP concern: the API layer decides which
/// of these a caller is allowed to be told apart, and the answer for
/// [`PasswordError::Mismatch`] is "never" (docs/12).
#[derive(Debug, thiserror::Error)]
pub enum PasswordError {
    /// Shorter than [`MIN_PASSWORD_LENGTH`].
    #[error("a password must be at least {MIN_PASSWORD_LENGTH} characters")]
    TooShort,
    /// The stored hash could not be parsed. A corrupted or truncated PHC
    /// string, which is an operational fault rather than a wrong password, and
    /// must not be reported to the caller as either.
    #[error("the stored password hash is not a valid PHC string")]
    MalformedHash,
    /// The password does not match the hash.
    #[error("password mismatch")]
    Mismatch,
    /// The hasher itself failed — effectively only out-of-memory, since Argon2
    /// is memory-hard by design.
    #[error("the password hasher failed")]
    Backend,
}

/// Hash a password for storage, returning a PHC string.
///
/// The returned string carries the algorithm, its parameters and the salt, so
/// raising the cost later does not invalidate what is already stored: an old
/// hash is verified at the parameters it was written with. The salt is fresh
/// per call, from the OS CSPRNG.
///
/// # Errors
///
/// [`PasswordError::TooShort`] below [`MIN_PASSWORD_LENGTH`], or
/// [`PasswordError::Backend`] if the hasher fails.
pub fn hash(password: &SecretString) -> Result<String, PasswordError> {
    // Characters, not bytes: a 12-character passphrase with accented letters is
    // not short, and `len()` on a UTF-8 string would call it 15 and quietly
    // apply a different rule to French than to English.
    if password.expose_secret().chars().count() < MIN_PASSWORD_LENGTH {
        return Err(PasswordError::TooShort);
    }

    let salt = SaltString::generate(&mut password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(password.expose_secret().as_bytes(), &salt)
        .map(|hashed| hashed.to_string())
        .map_err(|_| PasswordError::Backend)
}

/// Verify a password against a stored PHC string.
///
/// # Errors
///
/// [`PasswordError::MalformedHash`] if the stored value will not parse, and
/// [`PasswordError::Mismatch`] if it parses and does not match. The caller must
/// collapse both into one answer for the user: telling an unauthenticated
/// caller which of the two happened distinguishes a known account from an
/// unknown one.
pub fn verify(password: &SecretString, stored: &str) -> Result<(), PasswordError> {
    // No length check here. The floor is a rule about passwords we accept, not
    // about passwords we verify: applying it on this path would reject an
    // already-stored short password with a *different* error from a wrong one,
    // which is an oracle.
    let parsed = PasswordHash::new(stored).map_err(|_| PasswordError::MalformedHash)?;

    Argon2::default()
        .verify_password(password.expose_secret().as_bytes(), &parsed)
        .map_err(|_| PasswordError::Mismatch)
}

#[cfg(test)]
mod tests {
    use super::{MIN_PASSWORD_LENGTH, PasswordError, hash, verify};
    use secrecy::SecretString;

    fn secret(raw: &str) -> SecretString {
        SecretString::from(raw.to_owned())
    }

    #[test]
    fn a_hashed_password_verifies_against_its_own_hash() {
        let password = secret("correct horse battery staple");
        let stored = hash(&password).expect("a long password hashes");
        assert!(verify(&password, &stored).is_ok());
    }

    #[test]
    fn a_wrong_password_does_not_verify() {
        let stored = hash(&secret("correct horse battery staple")).expect("hashes");
        assert!(matches!(
            verify(&secret("correct horse battery stapler"), &stored),
            Err(PasswordError::Mismatch)
        ));
    }

    #[test]
    fn the_same_password_hashes_differently_every_time() {
        // If this fails the salt is not being applied, and the stored hashes
        // become a rainbow table of each other.
        let password = secret("correct horse battery staple");
        let first = hash(&password).expect("hashes");
        let second = hash(&password).expect("hashes");
        assert_ne!(first, second);
        assert!(verify(&password, &first).is_ok());
        assert!(verify(&password, &second).is_ok());
    }

    #[test]
    fn a_short_password_is_refused_rather_than_hashed() {
        let short = "a".repeat(MIN_PASSWORD_LENGTH.saturating_sub(1));
        assert!(matches!(
            hash(&secret(&short)),
            Err(PasswordError::TooShort)
        ));
    }

    #[test]
    fn length_is_counted_in_characters_not_bytes() {
        // Twelve characters, more than twelve bytes in UTF-8. Counting bytes
        // would accept this while rejecting twelve ASCII characters, which is
        // the same rule applied differently to two languages.
        let accented = "ééééééééééé";
        assert_eq!(
            accented.chars().count(),
            MIN_PASSWORD_LENGTH.saturating_sub(1)
        );
        assert!(matches!(
            hash(&secret(accented)),
            Err(PasswordError::TooShort)
        ));
    }

    #[test]
    fn a_corrupted_stored_hash_is_not_reported_as_a_mismatch() {
        // The two must stay distinguishable *internally*: one is an operations
        // problem and the other is a user typing the wrong thing.
        assert!(matches!(
            verify(&secret("correct horse battery staple"), "not-a-phc-string"),
            Err(PasswordError::MalformedHash)
        ));
    }
}
