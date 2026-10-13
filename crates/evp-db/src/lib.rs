// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! SQLx repositories, migrations and Row-Level Security session handling.
//!
//! The only crate that knows SQL exists. Repositories are traits in
//! `evp-domain`'s vocabulary; this crate implements them.

pub mod assignments;
pub mod auth;
pub mod availability;
pub mod catalog;
pub mod crypto;
pub mod forms;
pub mod intake;
pub mod locations;
pub mod participations;
pub mod patterns;
pub mod public_forms;
pub mod shifts;
pub mod sms_settings;
pub mod submissions;

use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Executor as _, PgPool};

/// Everything this crate can fail with. Deliberately not `anyhow`: the API
/// layer maps these onto `problem+json` in exactly one place (docs/11 §2).
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    /// The pool could not be built, or the first connection failed.
    #[error("could not connect to the database")]
    Connect(#[source] sqlx::Error),
    /// The pool exists but the database did not answer.
    #[error("the database did not answer")]
    NotReady(#[source] sqlx::Error),
    /// A statement failed, or a row would not decode.
    ///
    /// One variant for both, deliberately: the API layer maps this onto a 500
    /// with no detail, so splitting it would create a distinction no caller is
    /// ever shown. The `#[source]` chain is what an operator reads in the log,
    /// and that keeps the specifics (docs/11 §2).
    #[error("the database rejected a statement")]
    Query(#[source] sqlx::Error),
    /// Building the in-memory data for `POST …/festivals/example` /
    /// `…/events/example` failed before any statement was sent. Not really a
    /// *database* error, but this module is where `evp-api` already learns
    /// "the write failed" from, and the alternative — a second error type
    /// `evp-api` would have to fold in beside this one at every call site —
    /// is more surface for one failure that `evp-bin`'s startup check
    /// (`assert_tzdb_is_available`) makes unreachable in a deployment that
    /// booted at all.
    #[error("could not build the worked example")]
    Fixture(#[from] evp_domain::example::ExampleError),
    /// A value protected by `EVP_SECRET_KEY_FILE` failed to seal or open —
    /// see [`crypto`] (ADR-0034). Not a [`Self::Query`]: nothing was sent to
    /// PostgreSQL yet when encryption fails, and ciphertext that will not
    /// open (wrong key, truncated column, tampering) is not a SQL statement
    /// PostgreSQL rejected either.
    #[error("could not seal or open an encrypted value")]
    Crypto,
}

impl DbError {
    /// The PostgreSQL SQLSTATE this failure carries, when it is a database
    /// error at all.
    ///
    /// Exists so callers above this crate — `evp-api`'s handlers — can tell a
    /// constraint violation apart from a genuinely unexpected failure without
    /// matching on `sqlx::Error` themselves, which would put a `sqlx` import
    /// in a crate that is supposed to know only that *some* write failed.
    /// docs/13 §2 requires every hard constraint to have a test asserting its
    /// SQLSTATE; this is the one place that number is read back out.
    /// Returns an owned `String` rather than borrowing: `DatabaseError::code`
    /// hands back a `Cow` tied to the trait object inside the `sqlx::Error`,
    /// and this is an infrequent, error-path call — not worth the borrow-
    /// checker friction of threading that lifetime out through two enum
    /// layers.
    #[must_use]
    pub fn sqlstate(&self) -> Option<String> {
        match self {
            Self::Query(sqlx::Error::Database(database)) => {
                database.code().map(std::borrow::Cow::into_owned)
            }
            Self::Connect(_)
            | Self::NotReady(_)
            | Self::Query(_)
            | Self::Fixture(_)
            | Self::Crypto => None,
        }
    }

    /// The name of the constraint that was violated, when PostgreSQL supplied
    /// one. Distinguishes, for instance, two different unique indexes that
    /// both raise `23505`.
    #[must_use]
    pub fn constraint(&self) -> Option<String> {
        match self {
            Self::Query(sqlx::Error::Database(database)) => {
                database.constraint().map(ToOwned::to_owned)
            }
            Self::Connect(_)
            | Self::NotReady(_)
            | Self::Query(_)
            | Self::Fixture(_)
            | Self::Crypto => None,
        }
    }
}

/// Pool ceiling.
///
/// Not configurable, and that is the decision: the pool is the system's
/// concurrency limit (docs/12 §6), and the number that matters is PostgreSQL's
/// `max_connections` (100 by default) divided by the number of API replicas.
/// At a few dozen concurrent coordinators this is generous. It becomes an
/// environment variable the day there is a second replica, not before.
pub const MAX_CONNECTIONS: u32 = 16;

/// Build the connection pool for the **unprivileged** application role.
///
/// Every pooled connection is pinned to UTC in the after-connect hook. That
/// does not change what is stored — `timestamptz` is an instant either way —
/// it makes text rendering, `now()` and log lines independent of the
/// container's `/etc/localtime`
/// ([docs/16 §2](../../../docs/16-i18n-and-time.md), ADR-0019).
///
/// # Errors
///
/// Fails if the URL cannot be parsed, or if no connection can be established
/// within the acquire timeout. Both are startup failures: the process is
/// expected to exit rather than serve requests it cannot answer.
pub async fn connect(url: &str) -> Result<PgPool, DbError> {
    let options: PgConnectOptions = url.parse().map_err(DbError::Connect)?;

    PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .min_connections(2)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Some(Duration::from_mins(10)))
        .max_lifetime(Some(Duration::from_mins(30)))
        .after_connect(|connection, _meta| {
            Box::pin(async move {
                connection.execute("SET TIME ZONE 'UTC'").await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .map_err(DbError::Connect)
}

/// Does the database answer? Backs `GET /readyz`.
///
/// Written with `sqlx::query` rather than the `query!` macro on purpose: the
/// macro is checked against a live schema at compile time, and a readiness
/// probe must not acquire a dependency on the schema it is probing. It is also
/// the only query in the workspace that predates the first migration.
///
/// # Errors
///
/// Fails if no connection can be acquired, or if the round trip fails.
pub async fn ping(pool: &PgPool) -> Result<(), DbError> {
    sqlx::query("SELECT 1")
        .execute(pool)
        .await
        .map(drop)
        .map_err(DbError::NotReady)
}
