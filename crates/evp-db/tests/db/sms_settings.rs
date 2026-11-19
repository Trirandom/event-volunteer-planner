// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed tests for `evp_db::sms_settings` and migration
//! `20260918150000_add_org_sms_settings` (ADR-0034): RLS isolation, the
//! `provider` `CHECK`, the `NOT NULL` on a first-time save with no secret,
//! and that a value round-trips through encryption unchanged.
//!
//! Same discipline as `patterns.rs` in this directory: one transaction per
//! test against the shared dev database as `evp_migrator`, `FORCE ROW LEVEL
//! SECURITY` is what makes RLS bind even to that connection, and nothing a
//! test does outlives its (uncommitted) transaction.

use evp_db::crypto::EncryptionKey;
use evp_db::sms_settings::{self, SmsSettingsInput};
use secrecy::SecretString;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn pool() -> PgPool {
    let url = std::env::var("EVP_MIGRATION_DATABASE_URL").expect(
        "EVP_MIGRATION_DATABASE_URL must be set to run crates/evp-db's database-backed tests; \
         `just test`/`just test-tz` set it via compose.override.yaml",
    );
    evp_db::connect(&url)
        .await
        .expect("could not connect to the test database")
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_org(conn: &mut PgConnection) -> (Uuid, Uuid) {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    let suffix = Uuid::now_v7().simple().to_string();

    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *conn)
        .await
        .expect("set app.current_org_id");
    sqlx::query("SELECT set_config('app.current_role', 'owner', true)")
        .execute(&mut *conn)
        .await
        .expect("set app.current_role");
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2::citext, 'Test Org')")
        .bind(org_id)
        .bind(format!("test-{suffix}"))
        .execute(&mut *conn)
        .await
        .expect("insert organizations row");
    sqlx::query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, 'Test Owner')",
    )
    .bind(user_id)
    .bind(format!("{suffix}@example.test"))
    .execute(&mut *conn)
    .await
    .expect("insert users row");
    (org_id, user_id)
}

fn key() -> EncryptionKey {
    EncryptionKey::new(SecretString::from("k".repeat(32)))
}

fn full_input() -> SmsSettingsInput {
    SmsSettingsInput {
        provider: "ovh".to_owned(),
        service_name: "sms-xxxxx-1".to_owned(),
        sender: "Soundclash".to_owned(),
        application_key: "app-key-123".to_owned(),
        application_secret: Some("first-secret".to_owned()),
        consumer_key: Some("first-consumer".to_owned()),
    }
}

#[tokio::test]
async fn no_settings_yet_is_none_not_an_error() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, _user_id) = seed_org(&mut tx).await;

    let settings = sms_settings::get(&mut tx, org_id)
        .await
        .expect("get must succeed with no row");
    assert!(settings.is_none());
}

#[tokio::test]
async fn first_save_stores_both_secrets_and_reports_them_as_set() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let (settings, operation_id) =
        sms_settings::upsert(&mut tx, org_id, user_id, &key(), &full_input())
            .await
            .expect("first save");

    assert_eq!(settings.provider, "ovh");
    assert_eq!(settings.service_name, "sms-xxxxx-1");
    assert_eq!(settings.sender, "Soundclash");
    assert_eq!(settings.application_key, "app-key-123");
    assert!(settings.has_application_secret);
    assert!(settings.has_consumer_key);
    assert_ne!(operation_id.0, Uuid::nil());

    let fetched = sms_settings::get(&mut tx, org_id)
        .await
        .expect("get after save")
        .expect("a row now exists");
    assert!(fetched.has_application_secret);
    assert!(fetched.has_consumer_key);
}

#[tokio::test]
async fn round_trips_through_encryption_unchanged() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let key = key();

    sms_settings::upsert(&mut tx, org_id, user_id, &key, &full_input())
        .await
        .expect("first save");

    let decrypted = sms_settings::decrypted(&mut tx, org_id, &key)
        .await
        .expect("decrypt")
        .expect("a row exists");
    assert_eq!(decrypted.application_secret, "first-secret");
    assert_eq!(decrypted.consumer_key, "first-consumer");
    assert_eq!(decrypted.application_key, "app-key-123");
    assert_eq!(decrypted.service_name, "sms-xxxxx-1");
}

#[tokio::test]
async fn omitting_a_secret_on_update_keeps_the_one_already_stored() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;
    let key = key();

    sms_settings::upsert(&mut tx, org_id, user_id, &key, &full_input())
        .await
        .expect("first save");

    // Rotate only the consumer key; the application secret is omitted, as a
    // `PUT` that leaves the field blank would.
    let update = SmsSettingsInput {
        service_name: "sms-yyyyy-2".to_owned(),
        application_secret: None,
        consumer_key: Some("rotated-consumer".to_owned()),
        ..full_input()
    };
    sms_settings::upsert(&mut tx, org_id, user_id, &key, &update)
        .await
        .expect("update");

    let decrypted = sms_settings::decrypted(&mut tx, org_id, &key)
        .await
        .expect("decrypt")
        .expect("a row exists");
    assert_eq!(
        decrypted.application_secret, "first-secret",
        "an omitted secret on update must not be overwritten with null"
    );
    assert_eq!(decrypted.consumer_key, "rotated-consumer");
    assert_eq!(decrypted.service_name, "sms-yyyyy-2");
}

#[tokio::test]
async fn a_first_save_with_no_secret_is_refused_23502() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let input = SmsSettingsInput {
        application_secret: None,
        consumer_key: None,
        ..full_input()
    };
    let error = sms_settings::upsert(&mut tx, org_id, user_id, &key(), &input)
        .await
        .expect_err("a first insert with a null secret column must be refused");

    assert_eq!(
        error.sqlstate().as_deref(),
        Some("23502"),
        "expected a NOT NULL violation, got {error:?}"
    );
}

#[tokio::test]
async fn an_unknown_provider_is_refused_23514() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");
    let (org_id, user_id) = seed_org(&mut tx).await;

    let input = SmsSettingsInput {
        provider: "twilio".to_owned(),
        ..full_input()
    };
    let error = sms_settings::upsert(&mut tx, org_id, user_id, &key(), &input)
        .await
        .expect_err("only 'ovh' is a known provider so far");

    assert_eq!(error.sqlstate().as_deref(), Some("23514"));
}

#[tokio::test]
async fn org_a_cannot_see_org_b_s_sms_settings() {
    let pool = pool().await;
    let mut tx = pool.begin().await.expect("begin");

    let (org_a, user_a) = seed_org(&mut tx).await;
    sms_settings::upsert(&mut tx, org_a, user_a, &key(), &full_input())
        .await
        .expect("save for org A");

    // `seed_org` re-points the GUCs, which is what a request scoped to the
    // other organisation would do.
    let (org_b, _user_b) = seed_org(&mut tx).await;
    let settings = sms_settings::get(&mut tx, org_b)
        .await
        .expect("get as org B");
    assert!(
        settings.is_none(),
        "RLS must hide another tenant's SMS settings entirely"
    );

    // The row exists — this is RLS hiding it, not an absence of data.
    let count =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM org_sms_settings WHERE org_id = $1")
            .bind(org_a)
            .fetch_one(&mut *tx)
            .await
            .expect("count as org B");
    assert_eq!(
        count, 0,
        "a bare SELECT under org B's GUCs must not see org A's row either"
    );
}
