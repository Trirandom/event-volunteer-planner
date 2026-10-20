// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Composition root.
//!
//! M0's whole job is to prove that configuration, wiring and hot reload work
//! end to end ([docs/07](../../../docs/07-roadmap.md)). Three routes, one
//! pool, one subscriber. Everything else arrives with the milestone that needs
//! it.

mod config;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use anyhow::{Context as _, bail};
use axum::http::{HeaderName, Request, StatusCode};
use clap::{Parser, Subcommand};
use config::LogFormat;
use secrecy::ExposeSecret as _;
use sqlx::migrate::Migrator;
use tower::ServiceBuilder;
use tower_http::LatencyUnit;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::request_id::{
    MakeRequestId, PropagateRequestIdLayer, RequestId, SetRequestIdLayer,
};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::{DefaultOnResponse, TraceLayer};
use tracing::Level;
use tracing_subscriber::EnvFilter;

/// Ceiling on a request body. Larger than any JSON this API accepts and far
/// smaller than an accident; intake uploads get their own, lower, limit at
/// their own endpoint, checked before parsing rather than during (docs/12 §6).
const MAX_BODY_BYTES: usize = 2_097_152;

/// A request that has not been answered in this long will not be answered.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// How often the rate limiter's bucket store is swept.
///
/// The store keys on the caller's address and never forgets one on its own, so
/// without this a long-running process accumulates a bucket per address it has
/// ever answered — and an address is something the caller supplies. A minute
/// is far longer than a quota period, so a sweep only ever drops buckets that
/// were already back to a full burst.
const RATE_LIMIT_SWEEP: Duration = Duration::from_secs(60);

fn request_id_header() -> HeaderName {
    HeaderName::from_static("x-request-id")
}

#[derive(Debug, Parser)]
#[command(name = "evp", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Ask the local `/readyz` whether this process can serve traffic; exit 0
    /// if it can.
    ///
    /// It exists because the production image is distroless: there is no
    /// shell, no `curl` and no `wget` for a compose healthcheck to use. A
    /// healthcheck that needs a package installed into the runtime image has
    /// bought a package manager to avoid writing twenty lines.
    Healthcheck,
    /// Apply outstanding migrations as `evp_migrator`, then exit.
    Migrate {
        /// Directory holding the ordered `.sql` files.
        #[arg(long, default_value = "migrations")]
        source: std::path::PathBuf,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Some(Command::Healthcheck) => healthcheck().await,
        Some(Command::Migrate { source }) => migrate(&source).await,
        None => serve().await,
    }
}

/// Everything the handlers share, built from the loaded configuration.
fn api_state(
    pool: sqlx::PgPool,
    config: &config::Config,
    sessions: evp_api::SessionPolicy,
) -> anyhow::Result<evp_api::ApiState> {
    Ok(evp_api::ApiState {
        pool,
        meta: evp_api::Meta {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            commit: env!("EVP_COMMIT").to_owned(),
            source_url: config.source_url.clone(),
        },
        sessions,
        secret_key: evp_db::crypto::EncryptionKey::new(secrecy::SecretString::from(
            config.secret_key.expose_secret().to_owned(),
        )),
        captcha: evp_api::captcha::CaptchaPolicy::from_secret(
            config.secret_key.expose_secret().as_bytes(),
            evp_api::captcha::DEFAULT_MAX_NUMBER,
        )
        .context("deriving the form captcha key from EVP_SECRET_KEY_FILE")?,
    })
}

async fn serve() -> anyhow::Result<()> {
    let startup = config::load()?;
    let config = startup.config;

    init_tracing(config.log_format, &config.rust_log)?;

    for variable in &startup.unrecognised {
        tracing::warn!(variable = %variable, "unrecognised EVP_ variable; ignoring");
    }
    for variable in &startup.plain_secrets {
        tracing::warn!(
            variable = %variable,
            "secret given as a plain environment value; prefer {variable}_FILE, \
             which `docker inspect` does not show (docs/12 §5)"
        );
    }

    assert_tzdb_is_available()?;

    let pool = evp_db::connect(config.database_url.expose_secret())
        .await
        .context("could not reach the database named by EVP_DATABASE_URL")?;

    // Before the listener binds, so that a deployment configured with a
    // bootstrap owner either has one or has failed to start. Doing it lazily on
    // the first login would put account creation on an unauthenticated path.
    bootstrap(&pool, &config).await?;

    let sessions = evp_api::SessionPolicy {
        absolute_lifetime_seconds: config.session_absolute_lifetime_hours.saturating_mul(3_600),
        idle_timeout_seconds: config.session_idle_timeout_minutes.saturating_mul(60),
        // Derived from the public URL rather than configured separately: an
        // HTTPS deployment that forgot to tick "secure cookies" is the mistake
        // worth making unreachable, and the operator has already said this.
        secure: config.public_url.starts_with("https://"),
    };

    let limits = evp_api::RateLimitPolicy {
        login_burst: config.login_rate_limit_burst,
        login_replenish: Duration::from_secs(config.login_rate_limit_replenish_seconds),
        trusted_proxy_hops: config.trusted_proxy_hops,
    };

    let state = api_state(pool, &config, sessions)?;

    let (router, sweeper) = evp_api::router(state, limits).context(
        "EVP_LOGIN_RATE_LIMIT_BURST and EVP_LOGIN_RATE_LIMIT_REPLENISH_SECONDS do not \
         describe a usable quota",
    )?;

    // Dropped with the runtime at shutdown, which is the whole of its
    // lifecycle: it holds nothing that has to be flushed, and a sweep
    // interrupted halfway loses nothing but the sweep.
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RATE_LIMIT_SWEEP);
        loop {
            ticker.tick().await;
            sweeper.sweep();
        }
    });

    let app = router.layer(
        ServiceBuilder::new()
            // Outermost: a panicked handler becomes a 500 rather than taking
            // the process and every in-flight request with it (docs/11 §2).
            .layer(CatchPanicLayer::new())
            .layer(SetRequestIdLayer::new(request_id_header(), RequestIds))
            .layer(
                TraceLayer::new_for_http()
                    .make_span_with(HttpSpan)
                    .on_response(
                        DefaultOnResponse::new()
                            .level(Level::INFO)
                            .latency_unit(LatencyUnit::Millis),
                    ),
            )
            .layer(PropagateRequestIdLayer::new(request_id_header()))
            .layer(TimeoutLayer::with_status_code(
                StatusCode::REQUEST_TIMEOUT,
                REQUEST_TIMEOUT,
            ))
            .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES)),
    );

    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("could not bind {}", config.bind))?;

    // Everything the configuration resolved to, minus the secrets, on one
    // line at boot. An operator debugging "why is it doing that" should not
    // have to reconstruct the environment from a compose file, three overrides
    // and a shell history.
    tracing::info!(
        bind = %config.bind,
        version = env!("CARGO_PKG_VERSION"),
        commit = env!("EVP_COMMIT"),
        public_url = %config.public_url,
        source_url = %config.source_url,
        mail_from = %config.mail_from,
        sms_provider = ?config.sms_provider,
        sms_sender = config.sms_sender.as_deref().unwrap_or("-"),
        allowed_redirects = config.oidc_allowed_redirects.len(),
        worker = config.run_worker,
        retention_sweep = config.retention_sweep_enabled,
        providers_file = config.auth_providers.is_some(),
        session_hours = config.session_absolute_lifetime_hours,
        session_idle_minutes = config.session_idle_timeout_minutes,
        trusted_proxy_hops = config.trusted_proxy_hops,
        login_burst = config.login_rate_limit_burst,
        login_replenish_seconds = config.login_rate_limit_replenish_seconds,
        secure_cookies = config.public_url.starts_with("https://"),
        "evp is listening"
    );

    // `into_make_service_with_connect_info` rather than the plain service:
    // it is what puts the peer address in each request's extensions, and the
    // rate limiter needs it — directly when nothing is proxying, and as the
    // fallback for a request that did not arrive through the trusted chain
    // (`EVP_TRUSTED_PROXY_HOPS`). Without it every caller would share one
    // bucket and one of them could starve the rest.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await
    .context("the HTTP server stopped unexpectedly")
}

/// Create the first organisation and its owner from configuration, if the
/// deployment asked for one and has no users yet.
///
/// ## Why this is guarded on "no users exist" and not on "this user does not
/// exist"
///
/// The obvious reading of "create the user if it is missing" is to look up that
/// one address. It is the wrong guard. An operator who edits
/// `EVP_BOOTSTRAP_USERNAME` on a running deployment — a typo, a handover, a
/// copied `.env` — would mint a *second* owner on a system that already has
/// real data, without anybody deciding that. Worse, an owner deleted on purpose
/// would reappear at the next restart.
///
/// "No users at all" is the only state in which creating an owner cannot grant
/// access to somebody else's deployment. Past that point, an owner is added by
/// an existing owner's invitation, which is what docs/07 M0 describes and what
/// `evp-cli create-org` is for.
///
/// It is therefore a no-op on every restart after the first, which is what
/// makes it safe to leave configured.
async fn bootstrap(pool: &sqlx::PgPool, config: &config::Config) -> anyhow::Result<()> {
    let (Some(username), Some(password)) = (&config.bootstrap_username, &config.bootstrap_password)
    else {
        return Ok(());
    };

    if evp_db::auth::any_user_exists(pool)
        .await
        .context("could not check whether this deployment already has users")?
    {
        tracing::debug!("bootstrap owner configured; users already exist, so nothing to do");
        return Ok(());
    }

    let email = username.trim();
    let hashed = evp_domain::password::hash(password)
        .context("EVP_BOOTSTRAP_PASSWORD could not be hashed")?;

    evp_db::auth::create_owner(
        pool,
        email,
        // The part before the @, as a first guess the owner can change. Better
        // than the whole address, which renders as a mailto in every list it
        // appears in, and better than an empty string.
        email.split('@').next().unwrap_or(email),
        &hashed,
        &slugify(&config.bootstrap_org_name),
        &config.bootstrap_org_name,
    )
    .await
    .context("could not create the bootstrap owner")?;

    tracing::warn!(
        email = %email,
        "created the bootstrap owner and its organisation. Remove \
         EVP_BOOTSTRAP_USERNAME and EVP_BOOTSTRAP_PASSWORD once you have signed \
         in: they are no longer read, and an unused credential in an \
         environment is one nobody rotates."
    );
    Ok(())
}

/// A slug for the bootstrap organisation, matching
/// `organizations_slug_format`: lowercase alphanumerics and hyphens, 3 to 40
/// characters, no leading or trailing hyphen.
///
/// Falls back rather than failing. The organisation's *name* is what anybody
/// sees; the slug is a URL component the owner renames later, and refusing to
/// start because a display name transliterated badly would be a poor trade.
fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            slug.extend(character.to_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }

    let trimmed: String = slug.trim_matches('-').chars().take(40).collect();
    let trimmed = trimmed.trim_matches('-');

    if trimmed.chars().count() < 3 {
        return "my-organisation".to_owned();
    }
    trimmed.to_owned()
}

async fn migrate(source: &std::path::Path) -> anyhow::Result<()> {
    init_tracing(LogFormat::Pretty, "evp=info,sqlx=info")?;

    let url = config::migration_database_url()?;
    let migrator = Migrator::new(source)
        .await
        .with_context(|| format!("could not read migrations from {}", source.display()))?;

    let pool = evp_db::connect(url.expose_secret())
        .await
        .context("could not reach the database named by EVP_MIGRATION_DATABASE_URL")?;

    migrator.run(&pool).await.context("a migration failed")?;
    tracing::info!("migrations applied");
    Ok(())
}

async fn healthcheck() -> anyhow::Result<()> {
    // Deliberately reads one variable rather than the whole configuration: a
    // healthcheck that fails because the SMTP URL is missing tells the
    // orchestrator to restart a container that is serving traffic perfectly
    // well.
    let bind: SocketAddr = std::env::var("EVP_BIND")
        .unwrap_or_else(|_| "0.0.0.0:3000".to_owned())
        .parse()
        .context("EVP_BIND is not a socket address")?;

    let address = SocketAddr::new(loopback_for(bind.ip()), bind.port());
    let url = format!("http://{address}/readyz");

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .context("could not build the healthcheck client")?
        .get(&url)
        .send()
        .await
        .with_context(|| format!("{url} did not answer"))?;

    if response.status().is_success() {
        return Ok(());
    }
    bail!("{url} answered {}", response.status());
}

/// jiff reads the platform time zone database from `/usr/share/zoneinfo`
/// rather than bundling one, so that a tzdb update arrives with a base-image
/// rebuild instead of a code change — and so the API and PostgreSQL stay on
/// comparable data.
///
/// The cost of that choice is a runtime dependency on the image, and its
/// failure mode is an event in a real timezone failing to resolve months after
/// deployment. So it is asserted at startup instead: a container without a
/// tzdb does not boot.
fn assert_tzdb_is_available() -> anyhow::Result<()> {
    jiff::tz::TimeZone::get("Europe/Paris")
        .map(drop)
        .context("no time zone database: the image must provide /usr/share/zoneinfo")
}

/// `0.0.0.0` and `::` mean "every interface", which is not an address to
/// connect to. Everything else is used as given, so a container bound to one
/// interface is probed on that one.
fn loopback_for(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(v4) if v4.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(v6) if v6.is_unspecified() => IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        other => other,
    }
}

fn init_tracing(format: LogFormat, directives: &str) -> anyhow::Result<()> {
    use tracing_subscriber::layer::SubscriberExt as _;
    use tracing_subscriber::util::SubscriberInitExt as _;

    let filter = EnvFilter::try_new(directives)
        .with_context(|| format!("EVP_RUST_LOG is not a valid filter: {directives}"))?;

    let registry = tracing_subscriber::registry().with(filter);

    match format {
        LogFormat::Json => registry
            .with(tracing_subscriber::fmt::layer().json())
            .init(),
        LogFormat::Pretty => registry
            .with(tracing_subscriber::fmt::layer().pretty())
            .init(),
    }
    Ok(())
}

/// UUIDv7 request ids, for the same reason the primary keys are: they sort by
/// time, so a log search for a window is a range scan rather than a shuffle.
#[derive(Debug, Clone, Copy)]
struct RequestIds;

impl MakeRequestId for RequestIds {
    fn make_request_id<B>(&mut self, _request: &Request<B>) -> Option<RequestId> {
        let id = uuid::Uuid::now_v7().to_string();
        id.parse().ok().map(RequestId::new)
    }
}

/// Every span carries the request id, so a `problem+json` body handed to a
/// user is enough for an operator to find the log line that has the detail
/// ([docs/12 §5](../../../docs/12-security.md)).
#[derive(Debug, Clone, Copy)]
struct HttpSpan;

impl<B> tower_http::trace::MakeSpan<B> for HttpSpan {
    fn make_span(&mut self, request: &Request<B>) -> tracing::Span {
        let request_id = request
            .headers()
            .get(request_id_header())
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");

        tracing::info_span!(
            "http",
            method = %request.method(),
            path = %request.uri().path(),
            request_id,
        )
    }
}

/// SIGTERM is how Docker asks. Ctrl-C is how a developer asks.
async fn shutdown() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(error) => tracing::error!(error = %error, "could not listen for SIGTERM"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {},
        () = terminate => {},
    }

    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn a_plain_name_becomes_a_plain_slug() {
        assert_eq!(slugify("Les Vieilles Charrues"), "les-vieilles-charrues");
    }

    #[test]
    fn runs_of_punctuation_collapse_to_one_hyphen() {
        assert_eq!(slugify("Foo  --  Bar!!"), "foo-bar");
    }

    #[test]
    fn a_name_that_slugifies_to_nothing_usable_falls_back() {
        // The constraint needs at least three characters, so neither of these
        // may be allowed to reach the database.
        assert_eq!(slugify("!!!"), "my-organisation");
        assert_eq!(slugify("ab"), "my-organisation");
    }

    #[test]
    fn a_slug_never_starts_or_ends_with_a_hyphen() {
        // organizations_slug_format rejects both, and the failure would be a
        // startup crash on a fresh deployment.
        let slug = slugify("  ...Association de Test...  ");
        assert!(!slug.starts_with('-'), "{slug}");
        assert!(!slug.ends_with('-'), "{slug}");
    }

    #[test]
    fn a_very_long_name_is_truncated_without_a_trailing_hyphen() {
        let slug = slugify(&format!("{} x", "a".repeat(60)));
        assert!(slug.chars().count() <= 40, "{slug}");
        assert!(!slug.ends_with('-'), "{slug}");
    }
}
