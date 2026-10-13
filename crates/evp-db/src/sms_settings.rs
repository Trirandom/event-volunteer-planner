// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `org_sms_settings` — one organisation's OVH SMS credentials, encrypted at
//! rest (ADR-0034, migration `20260918150000_add_org_sms_settings`).
//!
//! The secret and consumer key never leave this module in plaintext except
//! through [`decrypted`], which the outbox consumer (future work — see the
//! ADR) calls to build an OVH `SmsSender`. Everything `evp-api` renders comes
//! from [`SmsSettings`], which carries only `has_application_secret` /
//! `has_consumer_key` booleans — the same "returned once, never again" shape
//! docs/04 already uses for a webhook's signing secret.

use sqlx::{PgConnection, Row as _};
use uuid::Uuid;

use crate::DbError;
use crate::crypto::EncryptionKey;

/// What a coordinator sees: never the secret or consumer key values
/// themselves.
#[derive(Debug, Clone)]
pub struct SmsSettings {
    pub provider: String,
    pub service_name: String,
    pub sender: String,
    pub application_key: String,
    pub has_application_secret: bool,
    pub has_consumer_key: bool,
    pub updated_at: jiff::Timestamp,
}

/// What a `PUT` supplies. `application_secret` / `consumer_key` are `None`
/// when the caller means "keep whatever is stored" — the API layer already
/// distinguishes "sent an empty string" from "sent nothing" before this
/// point (docs/04: omitted, not null, means unchanged).
#[derive(Debug, Clone)]
pub struct SmsSettingsInput {
    pub provider: String,
    pub service_name: String,
    pub sender: String,
    pub application_key: String,
    pub application_secret: Option<String>,
    pub consumer_key: Option<String>,
}

fn decode(row: &sqlx::postgres::PgRow) -> Result<SmsSettings, DbError> {
    let application_secret_encrypted: Vec<u8> = row
        .try_get("application_secret_encrypted")
        .map_err(DbError::Query)?;
    let consumer_key_encrypted: Vec<u8> = row
        .try_get("consumer_key_encrypted")
        .map_err(DbError::Query)?;

    Ok(SmsSettings {
        provider: row.try_get("provider").map_err(DbError::Query)?,
        service_name: row.try_get("service_name").map_err(DbError::Query)?,
        sender: row.try_get("sender").map_err(DbError::Query)?,
        application_key: row.try_get("application_key").map_err(DbError::Query)?,
        has_application_secret: !application_secret_encrypted.is_empty(),
        has_consumer_key: !consumer_key_encrypted.is_empty(),
        updated_at: row
            .try_get::<jiff_sqlx::Timestamp, _>("updated_at")
            .map_err(DbError::Query)?
            .to_jiff(),
    })
}

// The column list below is repeated verbatim in `get` and in `upsert`'s
// `RETURNING` clause rather than built from a shared constant: this crate's
// SQL is bound-parameter literals only, never assembled at runtime
// (`format!`/`push_str` building a query is what CI greps for and refuses),
// so there is nothing to share the string through without doing exactly that.

/// # Errors
///
/// [`DbError::Query`] if the statement fails.
pub async fn get(conn: &mut PgConnection, org_id: Uuid) -> Result<Option<SmsSettings>, DbError> {
    let row = sqlx::query(
        "SELECT provider, service_name, sender, application_key, \
                application_secret_encrypted, consumer_key_encrypted, updated_at \
           FROM org_sms_settings WHERE org_id = $1",
    )
    .bind(org_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    row.as_ref().map(decode).transpose()
}

/// Decrypts and returns the plaintext credentials, for the (not yet built)
/// outbox consumer that actually signs and sends an SMS. Not used by
/// `evp-api` — a handler that called this would be the bug this module's
/// docs above warn about.
///
/// # Errors
///
/// [`DbError::Query`] if the row does not exist or the statement fails,
/// [`DbError::Crypto`] if either value fails to decrypt (wrong or rotated
/// `EVP_SECRET_KEY_FILE`).
pub async fn decrypted(
    conn: &mut PgConnection,
    org_id: Uuid,
    key: &EncryptionKey,
) -> Result<Option<OvhCredentials>, DbError> {
    let row = sqlx::query(
        "SELECT application_key, application_secret_encrypted, consumer_key_encrypted, \
                service_name, sender \
           FROM org_sms_settings WHERE org_id = $1",
    )
    .bind(org_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let Some(row) = row else { return Ok(None) };

    let application_secret_encrypted: Vec<u8> = row
        .try_get("application_secret_encrypted")
        .map_err(DbError::Query)?;
    let consumer_key_encrypted: Vec<u8> = row
        .try_get("consumer_key_encrypted")
        .map_err(DbError::Query)?;

    Ok(Some(OvhCredentials {
        application_key: row.try_get("application_key").map_err(DbError::Query)?,
        application_secret: crate::crypto::decrypt(key, &application_secret_encrypted)?,
        consumer_key: crate::crypto::decrypt(key, &consumer_key_encrypted)?,
        service_name: row.try_get("service_name").map_err(DbError::Query)?,
        sender: row.try_get("sender").map_err(DbError::Query)?,
    }))
}

/// Plaintext OVH credentials, in memory only for the duration of a send. Not
/// `Serialize` — nothing in this crate is ever handed to `evp-api` to render.
///
/// `Debug` is hand-written rather than derived, and redacts the two secret
/// fields — a derived `Debug` would print the OVH application secret and
/// consumer key verbatim into any log line that ever formats this value by
/// accident, which is exactly what docs/12 §5 exists to prevent.
#[derive(Clone)]
pub struct OvhCredentials {
    pub application_key: String,
    pub application_secret: String,
    pub consumer_key: String,
    pub service_name: String,
    pub sender: String,
}

impl std::fmt::Debug for OvhCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OvhCredentials")
            .field("application_key", &self.application_key)
            .field("application_secret", &"[redacted]")
            .field("consumer_key", &"[redacted]")
            .field("service_name", &self.service_name)
            .field("sender", &self.sender)
            .finish()
    }
}

/// Creates or replaces the org's settings.
///
/// `application_secret_encrypted` / `consumer_key_encrypted` are resolved to
/// concrete bytes *before* the statement runs, rather than left for
/// PostgreSQL to `COALESCE` against `EXCLUDED` inside `ON CONFLICT DO
/// UPDATE`: `NOT NULL` is checked against the row PostgreSQL is about to
/// write during speculative insertion, before it knows whether a conflict
/// will redirect that write to the `UPDATE` branch — so binding `NULL` for
/// an omitted secret fails `23502` even when a row already exists to fall
/// back to. Fetching the existing ciphertext first and binding *that* when
/// the input omits a secret means the column is never bound `NULL` unless
/// there truly is nothing to fall back to, which is exactly the first-time
/// case this function must still refuse.
///
/// # Errors
///
/// [`DbError::Query`] if the statement fails (`NOT NULL` on a first insert
/// with a missing secret surfaces as `23502`), [`DbError::Crypto`] if sealing
/// either secret fails.
pub async fn upsert(
    conn: &mut PgConnection,
    org_id: Uuid,
    actor_id: Uuid,
    key: &EncryptionKey,
    input: &SmsSettingsInput,
) -> Result<(SmsSettings, crate::catalog::OperationId), DbError> {
    let existing = sqlx::query(
        "SELECT application_secret_encrypted, consumer_key_encrypted \
           FROM org_sms_settings WHERE org_id = $1",
    )
    .bind(org_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let existing_application_secret: Option<Vec<u8>> = existing
        .as_ref()
        .map(|row| row.try_get("application_secret_encrypted"))
        .transpose()
        .map_err(DbError::Query)?;
    let existing_consumer_key: Option<Vec<u8>> = existing
        .as_ref()
        .map(|row| row.try_get("consumer_key_encrypted"))
        .transpose()
        .map_err(DbError::Query)?;

    let application_secret_encrypted = match input.application_secret.as_deref() {
        Some(value) => Some(crate::crypto::encrypt(key, value)?),
        None => existing_application_secret,
    };
    let consumer_key_encrypted = match input.consumer_key.as_deref() {
        Some(value) => Some(crate::crypto::encrypt(key, value)?),
        None => existing_consumer_key,
    };

    let row = sqlx::query(
        "INSERT INTO org_sms_settings \
           (org_id, provider, application_key, application_secret_encrypted, \
            consumer_key_encrypted, service_name, sender, updated_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (org_id) DO UPDATE SET \
           provider = EXCLUDED.provider, \
           application_key = EXCLUDED.application_key, \
           application_secret_encrypted = EXCLUDED.application_secret_encrypted, \
           consumer_key_encrypted = EXCLUDED.consumer_key_encrypted, \
           service_name = EXCLUDED.service_name, \
           sender = EXCLUDED.sender, \
           updated_by = EXCLUDED.updated_by, \
           updated_at = now() \
         RETURNING provider, service_name, sender, application_key, \
                   application_secret_encrypted, consumer_key_encrypted, updated_at",
    )
    .bind(org_id)
    .bind(&input.provider)
    .bind(&input.application_key)
    .bind(application_secret_encrypted)
    .bind(consumer_key_encrypted)
    .bind(&input.service_name)
    .bind(&input.sender)
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    let settings = decode(&row)?;

    // Not through `record_pattern_operation`/`record_shift_operation`
    // (ADR-0024): both record an `inverse` that is a *replayable command*,
    // and there is no safe one here — the previous plaintext secret is gone
    // the moment this statement commits (only the new ciphertext exists), so
    // "undo" cannot mean "put the old value back". `undoable = false` says so
    // in the schema rather than in a comment a future `POST …/undo` handler
    // would not read.
    let operation_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO operations \
           (id, org_id, event_id, actor_id, kind, summary, inverse, entity_ids, undoable) \
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, false)",
    )
    .bind(operation_id)
    .bind(org_id)
    .bind(actor_id)
    .bind("sms_settings.update")
    .bind(serde_json::json!({
        "service_name": settings.service_name,
        "sender": settings.sender,
    }))
    .bind(serde_json::json!({
        "reason": "OVH credentials are not replayable — the previous \
                   plaintext no longer exists once this write commits",
    }))
    .bind(&[org_id][..])
    .execute(&mut *conn)
    .await
    .map_err(DbError::Query)?;

    Ok((settings, crate::catalog::OperationId(operation_id)))
}
