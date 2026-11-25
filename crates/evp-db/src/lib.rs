// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! SQLx repositories, migrations and Row-Level Security session handling.
//!
//! The only crate that knows SQL exists. Repositories are traits in
//! `evp-domain`'s vocabulary; this crate implements them.

pub mod assignments;
pub mod auth;
pub mod availability;
pub mod backoffice;
pub mod catalog;
pub mod crypto;
pub mod forms;
pub mod intake;
pub mod locations;
pub mod participations;
pub mod patterns;
pub mod public_forms;
pub mod schedule;
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

/// Opens a transaction on `pool`, on a task of its own so that cancelling the
/// caller cannot cancel the `BEGIN` halfway.
///
/// sqlx 0.9's `Pool::begin` is not cancel-safe at the top level, whatever its
/// guard suggests: the guard calls `start_rollback` before the depth it checks
/// has been raised, and at depth 0 that queues nothing. A future dropped while
/// its `BEGIN` waits for a reply — a client disconnecting, tower-http's
/// request timeout — therefore hands the pool a connection that is inside a
/// transaction sqlx believes is closed. Every autocommit statement the next
/// borrower sends then joins it: `auth::authenticate`'s `UPDATE sessions`
/// keeps that session's row locked until the connection happens to be begun
/// and committed again, and a `SET LOCAL app.current_org_id` stays set across
/// requests — the leak docs/02 §3 says `SET LOCAL` exists to prevent.
///
/// Spawned, the `BEGIN` always runs to its reply. If the caller is gone by
/// then, the task drops the transaction it was about to hand over, at depth
/// 1, which is the ordinary path: a `ROLLBACK` is queued and the pool's
/// on-release ping sends it. The task costs a spawn per transaction, which is
/// nothing beside the round trip it wraps.
///
/// Rejected: closing the connection from `after_release` when the server
/// reports it in a transaction — sqlx tracks that status but does not expose
/// it (`Connection::is_in_transaction` reads the same depth that went wrong),
/// and asking the server costs a round trip on every release. Rejected too:
/// waiting for an upstream fix, which would leave the hole open until then.
///
/// `clippy.toml` disallows `Pool::begin` and its variants, so this is the only
/// way to open a top-level transaction in the workspace. Savepoints
/// (`Connection::begin` inside a transaction) are not affected: there the
/// depth is already 1 or more and the guard does queue its rollback.
///
/// # Errors
///
/// [`DbError::Query`] if the pool cannot hand out a connection or the `BEGIN`
/// fails, or carrying [`sqlx::Error::WorkerCrashed`] if the task did not run
/// to the end (a panic, or a runtime shutting down).
pub async fn begin(pool: &PgPool) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, DbError> {
    let pool = pool.clone();
    let begun = tokio::spawn(async move { pool.begin().await });
    match begun.await {
        Ok(begun) => begun.map_err(DbError::Query),
        Err(error) => {
            tracing::error!(%error, "the task opening a transaction did not finish");
            Err(DbError::Query(sqlx::Error::WorkerCrashed))
        }
    }
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
