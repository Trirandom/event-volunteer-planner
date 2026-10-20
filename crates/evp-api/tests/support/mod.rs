// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Fixtures shared by the route-level suites in this directory.
//!
//! Every suite here drives the *real* router through
//! `tower::ServiceExt::oneshot`, against a live PostgreSQL as `evp_api` — the
//! same role and the same RLS policies a deployment runs under, never a mock
//! (docs/13 §1). What that costs is a shared helper module; what it buys is
//! that a test passing here means the org extractor, the `SET LOCAL` dance and
//! the policies all agreed.
//!
//! A `tests/support/` subdirectory rather than a `tests/support.rs`: Cargo
//! compiles every top-level file in `tests/` as its own test binary, and a
//! helper module compiled as a binary with no `#[test]` in it is a warning at
//! best and a confusing empty suite at worst.

// Every suite in this directory compiles its own copy of this module, and each
// uses a different subset of it — so `dead_code` and `unreachable_pub` fire on
// whatever the *other* suites needed. `allow` rather than `expect` for exactly
// that reason: which items are unused differs per binary, so an `expect` would
// be unfulfilled in whichever suite happens to use them all.
#![allow(
    dead_code,
    unreachable_pub,
    reason = "shared test fixtures; each suite uses a different subset"
)]

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Request, StatusCode, header};
use evp_domain::token::Token;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt as _;
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
pub async fn pool() -> PgPool {
    let url = std::env::var("EVP_DATABASE_URL").expect(
        "EVP_DATABASE_URL must be set to run crates/evp-api's database-backed tests; \
         `just test`/`just test-tz` set it via compose.override.yaml",
    );
    evp_db::connect(&url)
        .await
        .expect("could not connect to the test database as evp_api")
}

pub fn router(pool: PgPool) -> Router {
    router_with_backoffice(pool, None)
}

/// [`router`], with the backoffice switched on by `key` (ADR-0045).
#[expect(
    clippy::expect_used,
    reason = "test fixture — an unusable quota here is a broken test, not a runtime case"
)]
pub fn router_with_backoffice(pool: PgPool, key: Option<&str>) -> Router {
    let state = evp_api::ApiState {
        pool,
        meta: evp_api::Meta {
            version: "test".to_owned(),
            commit: "test".to_owned(),
            source_url: "https://example.test/source".to_owned(),
        },
        sessions: evp_api::SessionPolicy {
            absolute_lifetime_seconds: 3600,
            idle_timeout_seconds: 3600,
            secure: false,
        },
        secret_key: evp_db::crypto::EncryptionKey::new(secrecy::SecretString::from("0".repeat(32))),
        // A search space of 50, so a test solves its challenge in microseconds.
        captcha: evp_api::captcha::CaptchaPolicy::from_secret(&[0; 32], 50)
            .expect("HMAC accepts any key"),
        backoffice: evp_api::backoffice::BackofficeAccess(
            key.map(|key| evp_domain::backoffice::BackofficeKey::new(&key.to_owned().into())),
        ),
    };
    let limits = evp_api::RateLimitPolicy {
        login_burst: 100,
        login_replenish: std::time::Duration::from_secs(1),
        trusted_proxy_hops: 0,
    };
    let (router, _sweeper) = evp_api::router(state, limits)
        .expect("100 burst / 1s replenish is a usable rate-limit quota");
    router
}

/// Creates an organisation and one member of the given role, all on one
/// transaction (the same `SET LOCAL` dance `evp-api::org` performs for a real
/// request) — then a live session for that member. Returns the org id and the
/// `Cookie` header value a request from that member would carry.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
pub async fn seed_member(pool: &PgPool, role: &str) -> (Uuid, String) {
    let org_id = Uuid::now_v7();
    let user_id = Uuid::now_v7();
    let suffix = Uuid::now_v7().simple().to_string();

    let mut tx = pool.begin().await.expect("begin fixture transaction");
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("set app.current_org_id");
    sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("set app.current_user_id");
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2::citext, 'Test Org')")
        .bind(org_id)
        .bind(format!("test-{suffix}"))
        .execute(&mut *tx)
        .await
        .expect("insert organizations row");
    sqlx::query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, 'Test Member')",
    )
    .bind(user_id)
    .bind(format!("{suffix}@example.test"))
    .execute(&mut *tx)
    .await
    .expect("insert users row");
    sqlx::query(
        "INSERT INTO memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4::member_role)",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(user_id)
    .bind(role)
    .execute(&mut *tx)
    .await
    .expect("insert memberships row");
    tx.commit().await.expect("commit fixture transaction");

    let token = Token::generate();
    evp_db::auth::create_session(pool, user_id, &token.hash(), 3600, None, None)
        .await
        .expect("create a live session for the fixture member");

    (
        org_id,
        format!("{}={}", evp_api::auth::COOKIE_NAME, token.expose()),
    )
}

/// Adds a second member, in the given role, to an organisation that already
/// exists — and returns their session cookie.
///
/// Distinct from [`seed_member`], which makes an org *and* its first member:
/// the role matrix is about several roles looking at the **same** event, and
/// two orgs cannot see each other's rows at all.
#[expect(
    clippy::expect_used,
    reason = "test fixture — a setup failure must abort the test loudly"
)]
pub async fn add_member(pool: &PgPool, org_id: Uuid, role: &str) -> String {
    let user_id = Uuid::now_v7();
    let suffix = Uuid::now_v7().simple().to_string();

    let mut tx = pool.begin().await.expect("begin fixture transaction");
    sqlx::query("SELECT set_config('app.current_org_id', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("set app.current_org_id");
    sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await
        .expect("set app.current_user_id");
    sqlx::query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2::citext, 'Second Member')",
    )
    .bind(user_id)
    .bind(format!("{suffix}@example.test"))
    .execute(&mut *tx)
    .await
    .expect("insert users row");
    sqlx::query(
        "INSERT INTO memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4::member_role)",
    )
    .bind(Uuid::now_v7())
    .bind(org_id)
    .bind(user_id)
    .bind(role)
    .execute(&mut *tx)
    .await
    .expect("insert memberships row");
    tx.commit().await.expect("commit fixture transaction");

    let token = Token::generate();
    evp_db::auth::create_session(pool, user_id, &token.hash(), 3600, None, None)
        .await
        .expect("create a live session for the fixture member");
    format!("{}={}", evp_api::auth::COOKIE_NAME, token.expose())
}

/// One request, described the way a test reads it.
///
/// A builder rather than a widening parameter list: the suites below differ in
/// which *two* of body, cookie and `If-Match` they care about, and a
/// six-argument `send` reads as a row of `None`s at every call site.
pub struct Call<'a> {
    method: &'a str,
    path: String,
    cookie: Option<&'a str>,
    body: Option<Value>,
    headers: Vec<(&'static str, String)>,
}

/// What came back. Carries the headers as well as the body, because half of
/// what this milestone's endpoints promise is in `ETag` (docs/04 §1).
pub struct Answer {
    pub status: StatusCode,
    pub body: Value,
    pub headers: HeaderMap,
}

impl Answer {
    /// The `ETag` as a client would echo it back in `If-Match`, verbatim.
    #[expect(
        clippy::expect_used,
        reason = "test assertion — a missing or unreadable ETag on a versioned GET is the failure"
    )]
    pub fn etag(&self) -> String {
        self.headers
            .get(header::ETAG)
            .expect("a versioned GET must carry an ETag (docs/04 §1)")
            .to_str()
            .expect("an ETag this API minted is ASCII")
            .to_owned()
    }
}

impl<'a> Call<'a> {
    pub fn new(method: &'a str, path: impl Into<String>) -> Self {
        Self {
            method,
            path: path.into(),
            cookie: None,
            body: None,
            headers: Vec::new(),
        }
    }

    #[must_use]
    pub fn signed_in_as(mut self, cookie: &'a str) -> Self {
        self.cookie = Some(cookie);
        self
    }

    #[must_use]
    pub fn body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    #[must_use]
    pub fn bearer(mut self, credential: &str) -> Self {
        self.headers
            .push(("authorization", format!("Bearer {credential}")));
        self
    }

    #[must_use]
    pub fn if_match(mut self, etag: &str) -> Self {
        self.headers.push(("if-match", etag.to_owned()));
        self
    }

    #[expect(
        clippy::expect_used,
        reason = "test assertions — a request that cannot be built or read is a broken test"
    )]
    pub async fn send(self, router: &Router) -> Answer {
        let mut builder = Request::builder().method(self.method).uri(&self.path);
        if let Some(cookie) = self.cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        for (name, value) in &self.headers {
            builder = builder.header(*name, value);
        }
        let request = if let Some(body) = &self.body {
            builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(body).expect("body serialises"),
                ))
                .expect("request builds")
        } else {
            builder.body(Body::empty()).expect("request builds")
        };

        let response = router
            .clone()
            .oneshot(request)
            .await
            .expect("routing a request to an existing route is infallible");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 1_048_576)
            .await
            .expect("response body is far below the limit");
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("every response body here is JSON")
        };
        Answer {
            status,
            body,
            headers,
        }
    }
}

/// An event body with a slug unique to this call, so parallel tests (nextest's
/// default) never collide on `events_org_id_slug_key`.
pub fn create_event_body(name: &str) -> Value {
    serde_json::json!({
        "name": name,
        "slug": format!("evt-{}", Uuid::now_v7().simple()),
        "timezone": "Europe/Paris",
        "period": { "start": "2026-07-04T06:00:00Z", "end": "2026-07-07T06:00:00Z" }
    })
}
