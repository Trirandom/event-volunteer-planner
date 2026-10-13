// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Configuration, parsed once at startup into a typed struct.
//!
//! The process refuses to start on anything missing or malformed rather than
//! failing at somebody's first login ([docs/02 §8], [docs/06 §2]). Every
//! failure in this module is a startup failure by design.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, bail};
use figment::Figment;
use figment::providers::{Env, Format as _, Serialized, Toml};
use secrecy::{ExposeSecret as _, SecretString};
use serde::{Deserialize, Deserializer};

const PREFIX: &str = "EVP_";
const FILE_SUFFIX: &str = "_FILE";

/// Key material never has a plain form. Setting one is a configuration
/// mistake with a security consequence — an environment value is visible in
/// `docker inspect` and in any crash dump of the environment (docs/12 §5) — so
/// it is refused rather than accepted with a warning.
const FILE_ONLY: [&str; 3] = ["SESSION_KEY", "SECRET_KEY", "SMS_CREDENTIALS"];

/// Variables this binary understands. Anything else prefixed `EVP_` is
/// reported at startup and ignored.
///
/// The list is maintained by hand beside [`Config`] because serde will not
/// give us the field names. A field added to one without the other produces a
/// startup warning naming the variable, which is a cheap way to notice.
const KNOWN: [&str; 26] = [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "BIND",
    "PUBLIC_URL",
    "SESSION_KEY",
    "SECRET_KEY",
    "AUTH_CONFIG",
    "OIDC_ALLOWED_REDIRECTS",
    "SMTP_URL",
    "MAIL_FROM",
    "SMS_PROVIDER",
    "SMS_CREDENTIALS",
    "SMS_SENDER",
    "RUN_WORKER",
    "LOG_FORMAT",
    "RETENTION_SWEEP_ENABLED",
    "SOURCE_URL",
    "RUST_LOG",
    "BOOTSTRAP_USERNAME",
    "BOOTSTRAP_PASSWORD",
    "BOOTSTRAP_ORG_NAME",
    "SESSION_ABSOLUTE_LIFETIME_HOURS",
    "SESSION_IDLE_TIMEOUT_MINUTES",
    "TRUSTED_PROXY_HOPS",
    "LOGIN_RATE_LIMIT_BURST",
    "LOGIN_RATE_LIMIT_REPLENISH_SECONDS",
];

/// The typed configuration. No field is `Option` unless the deployment may
/// genuinely omit it.
#[derive(Debug, Deserialize)]
pub(crate) struct Config {
    /// Connection URL for the **unprivileged** role. A URL embeds its
    /// password, so production supplies `EVP_DATABASE_URL_FILE`.
    pub(crate) database_url: SecretString,
    pub(crate) bind: SocketAddr,
    pub(crate) public_url: String,
    /// 32 bytes. Rotating it invalidates every session.
    pub(crate) session_key: SecretString,
    /// 32 bytes. Encrypts the values that must be recoverable rather than
    /// hashed — webhook signing secrets above all.
    pub(crate) secret_key: SecretString,
    /// Path to `providers.toml`. Absent means magic links only, which is a
    /// valid deployment and the default `docker compose up` experience.
    #[serde(default, rename = "auth_config")]
    pub(crate) auth_providers: Option<PathBuf>,
    #[serde(default = "default_redirects", deserialize_with = "comma_separated")]
    pub(crate) oidc_allowed_redirects: Vec<String>,
    /// `SecretString`, not `String`: an SMTP URL for a real relay embeds
    /// credentials (`smtp://user:pass@host`). It is never logged, and the
    /// redacting `Debug` is what makes that structural rather than a habit
    /// ([docs/12 §5](../../../docs/12-security.md)).
    #[expect(
        dead_code,
        reason = "read when the outbox mailer lands; the expect expires by itself when it is"
    )]
    pub(crate) smtp_url: SecretString,
    pub(crate) mail_from: String,
    #[serde(default)]
    pub(crate) sms_provider: SmsProvider,
    #[serde(default)]
    pub(crate) sms_credentials: Option<SecretString>,
    #[serde(default)]
    pub(crate) sms_sender: Option<String>,
    #[serde(default = "yes", deserialize_with = "flag")]
    pub(crate) run_worker: bool,
    #[serde(default)]
    pub(crate) log_format: LogFormat,
    #[serde(default = "yes", deserialize_with = "flag")]
    pub(crate) retention_sweep_enabled: bool,
    /// Shown to every network user for AGPL §13. A modified deployment must
    /// point this at its own fork.
    #[serde(default = "default_source_url")]
    pub(crate) source_url: String,
    /// `tracing-subscriber` filter directives. Named `EVP_RUST_LOG` rather
    /// than `RUST_LOG` so that a shell's ambient `RUST_LOG` cannot change a
    /// container's logging by accident.
    #[serde(default = "default_rust_log")]
    pub(crate) rust_log: String,

    /// Address of the owner account to create on an empty deployment.
    ///
    /// Named `USERNAME` because that is what an operator expects to type, but
    /// it is an email address: `users.email` is the account key, and magic
    /// links and OIDC — when they land — both match on an address. Accepting a
    /// bare handle here would create an account that no other method can ever
    /// authenticate.
    #[serde(default, deserialize_with = "absent_if_blank")]
    pub(crate) bootstrap_username: Option<String>,

    /// Password for that account.
    ///
    /// This is the one secret deliberately **not** in [`FILE_ONLY`], because a
    /// bootstrap credential an operator cannot type into `.env` is a bootstrap
    /// credential nobody uses. The `_FILE` form works too and costs nothing —
    /// [`resolve_environment`] resolves any variable that way — and production
    /// should use it: an environment value is visible in `docker inspect` and
    /// in any crash dump of the environment (docs/12 §5). Startup warns when
    /// the plain form is used.
    #[serde(default, deserialize_with = "secret_absent_if_blank")]
    pub(crate) bootstrap_password: Option<SecretString>,

    /// Display name for the organisation created alongside that owner.
    #[serde(
        default = "default_org_name",
        deserialize_with = "non_blank_or_default"
    )]
    pub(crate) bootstrap_org_name: String,

    /// How long a session lives regardless of activity.
    #[serde(default = "default_absolute_hours", deserialize_with = "positive")]
    pub(crate) session_absolute_lifetime_hours: i64,

    /// How long a session survives without being used.
    #[serde(default = "default_idle_minutes", deserialize_with = "positive")]
    pub(crate) session_idle_timeout_minutes: i64,

    /// How many reverse proxies stand between the internet and this process.
    ///
    /// The rate limiter keys on the caller's address, and behind a proxy that
    /// address is only in `X-Forwarded-For`. This is what says how much of
    /// that header was written by something this deployment controls: the
    /// limiter counts that many entries from the right and believes no
    /// further. Getting it *wrong* is worse than not having it, in both
    /// directions — too high reads an entry the caller wrote and lets them
    /// pick their own bucket, too low reads a proxy's own address and puts
    /// every caller behind it in one.
    ///
    /// `1` is right for every deployment this repository ships: Caddy, and
    /// nothing in front of it (docs/06 §1). `0` is right when the process is
    /// exposed directly, and a CDN in front of Caddy makes it `2`.
    #[serde(default = "default_proxy_hops", deserialize_with = "whole_number")]
    pub(crate) trusted_proxy_hops: usize,

    /// Sign-in attempts one address may make back to back.
    #[serde(default = "default_login_burst", deserialize_with = "positive")]
    pub(crate) login_rate_limit_burst: u32,

    /// How long until one of those attempts comes back.
    #[serde(
        default = "default_login_replenish_seconds",
        deserialize_with = "positive"
    )]
    pub(crate) login_rate_limit_replenish_seconds: u64,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LogFormat {
    #[default]
    Json,
    Pretty,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SmsProvider {
    Ovh,
    Twilio,
    /// Disables the channel. A publish then reports SMS as skipped rather than
    /// failing.
    #[default]
    None,
}

/// What [`load`] produces: the configuration, plus anything prefixed `EVP_`
/// that this binary did not recognise.
#[derive(Debug)]
pub(crate) struct Startup {
    pub(crate) config: Config,
    /// Reported once tracing is up. Not fatal: the migrate step and the API
    /// share an environment, and a future sidecar will add more.
    pub(crate) unrecognised: Vec<String>,
}

/// Read the environment, resolve the `_FILE` convention, and produce a typed
/// configuration.
///
/// # Errors
///
/// Returns an error — and the process exits — if a variable is set in both its
/// plain and its `_FILE` form, if a `_FILE` path cannot be read, if key
/// material is not 32 bytes, if a required variable is absent, or if any value
/// does not parse.
pub(crate) fn load() -> anyhow::Result<Startup> {
    let resolved = resolve_environment()?;

    let unrecognised = resolved
        .keys()
        .filter(|name| !KNOWN.contains(&name.as_str()))
        .map(|name| format!("{PREFIX}{name}"))
        .collect();

    let lowercased: BTreeMap<String, String> = resolved
        .iter()
        .map(|(name, value)| (name.to_lowercase(), value.clone()))
        .collect();

    // Defaults, then the process environment (so figment can name it in an
    // error), then the values that came from files. Order is presentational:
    // a variable present in two of these is already a hard error above.
    let config: Config = Figment::new()
        .merge(Env::prefixed(PREFIX))
        .merge(Serialized::defaults(lowercased))
        .extract()
        .context("configuration is incomplete or malformed — see docs/06 §2")?;

    check_key_length("EVP_SESSION_KEY_FILE", &config.session_key)?;
    check_key_length("EVP_SECRET_KEY_FILE", &config.secret_key)?;

    if config.sms_provider != SmsProvider::None && config.sms_credentials.is_none() {
        bail!(
            "EVP_SMS_PROVIDER is set but EVP_SMS_CREDENTIALS_FILE is not. \
             A configured SMS channel with no credentials fails at the first \
             publish, which is the worst possible moment."
        );
    }

    validate_bootstrap(&config)?;

    if let Some(path) = &config.auth_providers {
        let providers = load_providers(path)?;
        tracing::debug!(count = providers.len(), "auth providers declared");
    }

    Ok(Startup {
        config,
        unrecognised,
    })
}

/// The migration step's URL, resolved through the same `_FILE` convention.
///
/// Deliberately separate from [`load`]: `evp migrate` runs as a different
/// database role, before the schema exists, and must not need a session key or
/// an SMTP server to do its one job.
///
/// # Errors
///
/// Returns an error if the variable is absent, set twice, or unreadable.
pub(crate) fn migration_database_url() -> anyhow::Result<SecretString> {
    let resolved = resolve_environment()?;
    resolved
        .get("MIGRATION_DATABASE_URL")
        .map(|url| SecretString::from(url.clone()))
        .context("EVP_MIGRATION_DATABASE_URL (or …_FILE) is not set")
}

/// Collect `EVP_*`, resolving `<NAME>_FILE` to the contents of the named file.
fn resolve_environment() -> anyhow::Result<BTreeMap<String, String>> {
    let mut plain: BTreeMap<String, String> = BTreeMap::new();
    let mut from_file: BTreeMap<String, PathBuf> = BTreeMap::new();

    for (key, value) in std::env::vars() {
        let Some(name) = key.strip_prefix(PREFIX) else {
            continue;
        };
        match name.strip_suffix(FILE_SUFFIX) {
            Some(base) => {
                from_file.insert(base.to_owned(), PathBuf::from(value));
            }
            None => {
                plain.insert(name.to_owned(), value);
            }
        }
    }

    for base in from_file.keys() {
        if plain.contains_key(base) {
            bail!(
                "{PREFIX}{base} and {PREFIX}{base}{FILE_SUFFIX} are both set. \
                 Exactly one of the two forms may be given — a precedence rule \
                 is a rule nobody remembers at three in the morning (docs/06 §2)."
            );
        }
    }

    for base in FILE_ONLY {
        if plain.contains_key(base) {
            bail!(
                "{PREFIX}{base} is set as an environment value. It is key \
                 material, so it must be given as {PREFIX}{base}{FILE_SUFFIX} \
                 naming a file (docs/12 §5)."
            );
        }
    }

    let mut resolved = plain;
    for (base, path) in from_file {
        let bytes = std::fs::read(&path).with_context(|| {
            format!(
                "{PREFIX}{base}{FILE_SUFFIX} names {}, which could not be read",
                path.display()
            )
        })?;
        let value = String::from_utf8(strip_one_trailing_newline(bytes)).with_context(|| {
            format!(
                "{PREFIX}{base}{FILE_SUFFIX} names {}, whose contents are not UTF-8",
                path.display()
            )
        })?;
        resolved.insert(base, value);
    }

    Ok(resolved)
}

/// A file written by `echo` ends in a newline and a file written by
/// `openssl rand` does not. Exactly one trailing newline is removed, so both
/// produce the same value and a secret that genuinely ends in whitespace is
/// only ever shortened by one byte — which the length check then catches.
fn strip_one_trailing_newline(mut bytes: Vec<u8>) -> Vec<u8> {
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    bytes
}

fn check_key_length(variable: &str, key: &SecretString) -> anyhow::Result<()> {
    use secrecy::ExposeSecret as _;

    let length = key.expose_secret().len();
    if length == 32 {
        return Ok(());
    }
    bail!(
        "{variable} holds {length} bytes; it must hold exactly 32. \
         A short key is a weak key and a long one is usually a stray newline."
    );
}

/// Minimal validation of `providers.toml`: it must parse, and every entry must
/// carry a non-empty `id`, because `id` is stored in `identities.provider` and
/// is immutable once used (docs/06 §2).
///
/// The full schema — issuer, claim map, `trust_email_verified` — is validated
/// by the OIDC client when it lands (ADR-0014). A file of nothing but comments
/// is a valid file declaring no providers, which is the default development
/// deployment.
fn load_providers(path: &Path) -> anyhow::Result<Vec<String>> {
    #[derive(Debug, Default, Deserialize)]
    struct ProvidersFile {
        #[serde(default)]
        providers: Vec<Provider>,
    }

    #[derive(Debug, Deserialize)]
    struct Provider {
        id: String,
    }

    if !path.exists() {
        bail!(
            "EVP_AUTH_CONFIG names {}, which does not exist. Unset it to run \
             with magic links only.",
            path.display()
        );
    }

    let file: ProvidersFile = Figment::from(Toml::file(path))
        .extract()
        .with_context(|| format!("{} is not a readable provider list", path.display()))?;

    let mut ids = Vec::with_capacity(file.providers.len());
    for provider in file.providers {
        if provider.id.trim().is_empty() {
            bail!("{} declares a provider with an empty id", path.display());
        }
        ids.push(provider.id);
    }
    Ok(ids)
}

/// The bootstrap pair is all-or-nothing, and the password must clear the same
/// floor every other password will.
///
/// Both checks are startup failures rather than warnings. Half a pair means an
/// operator believes they have configured an owner and has not — they would
/// discover it at the first login attempt, which on a fresh deployment is the
/// only thing they are trying to do. And a rejected password would fail inside
/// the bootstrap, after the process reported itself healthy.
fn validate_bootstrap(config: &Config) -> anyhow::Result<()> {
    match (&config.bootstrap_username, &config.bootstrap_password) {
        (Some(username), Some(password)) => {
            if !is_email(username) {
                bail!(
                    "EVP_BOOTSTRAP_USERNAME is {username:?}, which is not an email address.                      The account key is an address, so a bare handle here would create an                      owner that magic links and OIDC can never sign in (docs/03)."
                );
            }
            if password.expose_secret().chars().count() < evp_domain::password::MIN_PASSWORD_LENGTH
            {
                bail!(
                    "EVP_BOOTSTRAP_PASSWORD is shorter than {} characters. It is the                      credential for the account with the most authority on this                      deployment.",
                    evp_domain::password::MIN_PASSWORD_LENGTH
                );
            }
            Ok(())
        }
        (None, None) => Ok(()),
        (Some(_), None) => bail!(
            "EVP_BOOTSTRAP_USERNAME is set but EVP_BOOTSTRAP_PASSWORD (or …_FILE) is not.              No owner would be created, and the deployment would have no way in."
        ),
        (None, Some(_)) => bail!(
            "EVP_BOOTSTRAP_PASSWORD is set but EVP_BOOTSTRAP_USERNAME is not.              There is no account for it to be the password of."
        ),
    }
}

/// Deliberately not a validating regex.
///
/// RFC 5322 permits addresses no useful deployment has, and every short regex
/// that claims to implement it rejects real ones. The only property that
/// matters here is that this is an address rather than a handle — the operator
/// finds out whether it is *their* address when the mail arrives.
fn is_email(candidate: &str) -> bool {
    let trimmed = candidate.trim();
    match trimmed.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !domain.contains(' ')
        }
        None => false,
    }
}

/// An unset Compose variable interpolates to the empty string, not to nothing:
/// `EVP_BOOTSTRAP_USERNAME: ${EVP_BOOTSTRAP_USERNAME:-}` sets the variable to
/// `""` on every deployment that did not ask for a bootstrap owner. Without
/// this, that empty value would reach [`validate_bootstrap`] and refuse to
/// start with "which is not an email address" — on exactly the deployments that
/// wanted nothing to do with it.
///
/// Treating blank as absent is also the honest reading of an operator writing
/// `EVP_BOOTSTRAP_USERNAME=` in a `.env` by hand.
fn absent_if_blank<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(raw.filter(|value| !value.trim().is_empty()))
}

/// [`absent_if_blank`], for the value that must not pass through a plain
/// `String` it could be logged from.
fn secret_absent_if_blank<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<SecretString>, D::Error> {
    Ok(absent_if_blank(deserializer)?.map(SecretString::from))
}

/// `#[serde(default)]` applies when a field is *missing*, not when it is
/// present and empty — so a blank `EVP_BOOTSTRAP_ORG_NAME` would otherwise
/// name an organisation `""`.
fn non_blank_or_default<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(absent_if_blank(deserializer)?.unwrap_or_else(default_org_name))
}

fn default_org_name() -> String {
    "My organisation".to_owned()
}

/// Twelve hours: long enough for an event day, short enough that a cookie
/// stolen in the morning is useless by the evening (docs/12, T5).
const fn default_absolute_hours() -> i64 {
    12
}

/// Eight hours of inactivity. A coordinator's laptop closed at lunch is still
/// signed in after lunch; one left in a marquee overnight is not.
const fn default_idle_minutes() -> i64 {
    480
}

/// Ten attempts, and one back every fifteen seconds.
///
/// Sized for simultaneity rather than for sustained load: a burst absorbs a
/// dozen coordinators signing in from one office NAT on an event morning, who
/// are one address to everything downstream of the proxy, while the refill
/// rate is what an attacker is left with — 240 guesses an hour against a
/// twelve-character minimum, which is nothing. The burst is also a memory
/// bound: every attempt in flight is an Argon2 verification holding ~19 MiB
/// (ADR-0031), so an unbounded one is a way to exhaust the host rather than to
/// guess a password.
const fn default_login_burst() -> u32 {
    10
}

const fn default_login_replenish_seconds() -> u64 {
    15
}

/// One reverse proxy — Caddy — because that is what compose.yaml and
/// compose.prod.yaml both put in front of this process, and a default that
/// matches the shipped topology is the one an operator never has to find out
/// about.
const fn default_proxy_hops() -> usize {
    1
}

/// A zero or negative session lifetime expires every session the moment it is
/// issued, which presents as "login silently does nothing" — the hardest
/// possible way to discover a typo. A zero rate-limit burst refuses every
/// login, and a zero replenish period is no limit at all.
///
/// Generic over the number type so that one deserialiser serves all four
/// rather than four near-identical copies drifting apart. `T::default()` is
/// zero for every integer, and an unsigned field rejects a negative value in
/// `parse` before this comparison is reached.
fn positive<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: std::str::FromStr + Default + PartialOrd + std::fmt::Display,
{
    use serde::de::Error as _;

    let raw = String::deserialize(deserializer)?;
    let value: T = raw
        .trim()
        .parse()
        .map_err(|_| D::Error::custom(format!("expected a whole number, found {raw:?}")))?;

    if value > T::default() {
        Ok(value)
    } else {
        Err(D::Error::custom(format!(
            "expected a positive number of units, found {value}"
        )))
    }
}

/// [`positive`], for the one count where zero is meaningful: no trusted proxy
/// at all.
fn whole_number<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: std::str::FromStr,
{
    use serde::de::Error as _;

    let raw = String::deserialize(deserializer)?;
    raw.trim()
        .parse()
        .map_err(|_| D::Error::custom(format!("expected a whole number, found {raw:?}")))
}

fn default_redirects() -> Vec<String> {
    vec!["/".to_owned()]
}

fn default_source_url() -> String {
    "https://github.com/Trirandom/event-volunteer-planner".to_owned()
}

fn default_rust_log() -> String {
    "evp=info,tower_http=info,sqlx=warn".to_owned()
}

const fn yes() -> bool {
    true
}

/// Environment variables are strings. This accepts the spellings an operator
/// actually types and refuses the rest, rather than treating anything that is
/// not `true` as false.
fn flag<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    use serde::de::Error as _;

    let raw = String::deserialize(deserializer)?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        other => Err(D::Error::custom(format!(
            "expected a boolean (true/false, 1/0, yes/no, on/off), found {other:?}"
        ))),
    }
}

fn comma_separated<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    let raw = String::deserialize(deserializer)?;
    Ok(raw
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::strip_one_trailing_newline;

    #[test]
    fn a_key_file_written_by_echo_and_one_written_by_openssl_agree() {
        let raw = b"0123456789abcdef0123456789abcdef".to_vec();
        let with_newline = b"0123456789abcdef0123456789abcdef\n".to_vec();
        let with_crlf = b"0123456789abcdef0123456789abcdef\r\n".to_vec();

        assert_eq!(strip_one_trailing_newline(raw.clone()), raw);
        assert_eq!(strip_one_trailing_newline(with_newline), raw);
        assert_eq!(strip_one_trailing_newline(with_crlf), raw);
    }

    #[test]
    fn only_one_trailing_newline_is_removed() {
        let two = b"secret\n\n".to_vec();
        assert_eq!(strip_one_trailing_newline(two), b"secret\n".to_vec());
    }
}
