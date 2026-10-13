// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `GET`/`PUT /api/v1/orgs/{org}/sms-settings` — one organisation's OVH SMS
//! credentials (ADR-0034, docs/04 §"SMS settings").
//!
//! `Owner`-only, matching "Org settings, members, invites" in docs/04 §4
//! rather than "Intake sources, secrets, mappings" (owner + coordinator): an
//! OVH account is billed to the organisation and can send to any number
//! under its sender id, which is closer to "who runs this organisation's
//! account" than to a per-source webhook secret a coordinator configures
//! day to day.
//!
//! Neither handler ever reads or returns `application_secret` /
//! `consumer_key` in plaintext — `evp_db::sms_settings::get` does not decrypt
//! them, only reports whether they are set. Only the (not yet built) outbox
//! consumer calls `evp_db::sms_settings::decrypted`.

use axum::Router;
use axum::extract::{FromRef, State};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;

use crate::auth::SessionPolicy;
use crate::error::ApiError;
use crate::extract::JsonBody;
use crate::org::Owner;

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
    SessionPolicy: FromRef<S>,
    evp_db::crypto::EncryptionKey: FromRef<S>,
{
    Router::new().route(
        "/api/v1/orgs/{org}/sms-settings",
        get(get_settings).put(put_settings),
    )
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct SmsSettingsResponse {
    pub provider: String,
    pub service_name: String,
    pub sender: String,
    pub application_key: String,
    pub has_application_secret: bool,
    pub has_consumer_key: bool,
    /// RFC 3339, UTC.
    pub updated_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SmsSettingsWritten {
    #[serde(flatten)]
    pub settings: SmsSettingsResponse,
    pub operation_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateSmsSettingsRequest {
    pub provider: String,
    pub service_name: String,
    pub sender: String,
    pub application_key: String,
    /// Omitted, not `null`: means "keep whatever is already stored"
    /// (ADR-0034). A `PUT` for an org with no row yet must send both this
    /// and `consumer_key`.
    #[serde(default)]
    pub application_secret: Option<String>,
    #[serde(default)]
    pub consumer_key: Option<String>,
}

fn render(settings: evp_db::sms_settings::SmsSettings) -> SmsSettingsResponse {
    SmsSettingsResponse {
        provider: settings.provider,
        service_name: settings.service_name,
        sender: settings.sender,
        application_key: settings.application_key,
        has_application_secret: settings.has_application_secret,
        has_consumer_key: settings.has_consumer_key,
        updated_at: settings.updated_at.to_string(),
    }
}

/// Known providers (ADR-0034: OVH first, the trait keeps a second one a
/// config change rather than a schema change — but the `CHECK` constraint on
/// `provider` only knows about `'ovh'` today, and this mirrors that rather
/// than let a caller send a provider the database will refuse anyway with a
/// less useful error).
fn validate_request(request: &UpdateSmsSettingsRequest) -> Result<(), ApiError> {
    if request.provider != "ovh" {
        return Err(ApiError::ValidationFailed(
            "provider must be \"ovh\".".to_owned(),
        ));
    }
    if request.service_name.trim().is_empty() {
        return Err(ApiError::ValidationFailed(
            "service_name must not be blank.".to_owned(),
        ));
    }
    if request.sender.trim().is_empty() {
        return Err(ApiError::ValidationFailed(
            "sender must not be blank.".to_owned(),
        ));
    }
    if request.application_key.trim().is_empty() {
        return Err(ApiError::ValidationFailed(
            "application_key must not be blank.".to_owned(),
        ));
    }
    Ok(())
}

fn map_write_error(error: evp_db::DbError) -> ApiError {
    match error.sqlstate().as_deref() {
        // provider CHECK, or application_secret_encrypted /
        // consumer_key_encrypted NOT NULL on a first insert that skipped
        // `validate_request`'s "both secrets required" check somehow.
        Some("23514" | "23502") => ApiError::ValidationFailed(
            "provider must be \"ovh\", and a first-time save needs both application_secret and \
             consumer_key."
                .to_owned(),
        ),
        _ => ApiError::Internal(error),
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `GET /api/v1/orgs/{org}/sms-settings`.
///
/// `404` when nothing has been saved yet, rather than a `200` of nulls: this
/// matches how `evp-db` already reports "no row" (`Option::None`) up through
/// every other single-resource `GET` in this crate (`evp_db::catalog::get_event`
/// and friends all become `ApiError::NotFound` the same way).
async fn get_settings(Owner(mut org): Owner) -> Result<axum::Json<SmsSettingsResponse>, ApiError> {
    let settings = evp_db::sms_settings::get(&mut org.tx, org.org_id)
        .await
        .map_err(ApiError::from)?
        .ok_or(ApiError::NotFound)?;
    org.commit().await?;

    Ok(axum::Json(render(settings)))
}

/// `PUT /api/v1/orgs/{org}/sms-settings`.
async fn put_settings(
    Owner(mut org): Owner,
    State(key): State<evp_db::crypto::EncryptionKey>,
    JsonBody(request): JsonBody<UpdateSmsSettingsRequest>,
) -> Result<axum::Json<SmsSettingsWritten>, ApiError> {
    validate_request(&request)?;

    let existing = evp_db::sms_settings::get(&mut org.tx, org.org_id)
        .await
        .map_err(ApiError::from)?;

    let application_secret = request.application_secret.filter(|value| !value.is_empty());
    let consumer_key = request.consumer_key.filter(|value| !value.is_empty());

    if existing.is_none() && (application_secret.is_none() || consumer_key.is_none()) {
        return Err(ApiError::ValidationFields {
            detail: "A first-time save needs both application_secret and consumer_key.".to_owned(),
            errors: [
                (
                    "application_secret".to_owned(),
                    vec!["Required the first time SMS settings are saved.".to_owned()],
                ),
                (
                    "consumer_key".to_owned(),
                    vec!["Required the first time SMS settings are saved.".to_owned()],
                ),
            ]
            .into_iter()
            .collect(),
        });
    }

    let input = evp_db::sms_settings::SmsSettingsInput {
        provider: request.provider,
        service_name: request.service_name,
        sender: request.sender,
        application_key: request.application_key,
        application_secret,
        consumer_key,
    };

    let (settings, operation_id) =
        evp_db::sms_settings::upsert(&mut org.tx, org.org_id, org.user_id, &key, &input)
            .await
            .map_err(map_write_error)?;
    org.commit().await?;

    Ok(axum::Json(SmsSettingsWritten {
        settings: render(settings),
        operation_id: operation_id.0.to_string(),
    }))
}
