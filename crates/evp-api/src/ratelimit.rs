// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Rate limiting for the routes that can be reached without a session.
//!
//! `POST /api/v1/auth/login` is the only one at M0 and is the reason this
//! module exists. It takes a human-chosen password
//! ([ADR-0031](../../../docs/adr/0031-password-bootstrap-credential.md)), so
//! an online guessing attack against it is worth mounting in a way that one
//! against a 32-byte session token is not — and until this landed, the only
//! thing bounding such an attack was Argon2's own cost. That is a defence paid
//! for by the defender: each attempt costs this process ~19 MiB and a slice of
//! a core, so an unbounded login endpoint is a memory exhaustion primitive
//! before it is a guessing oracle. The quota below bounds both.
//!
//! Three things are decided here rather than at the route.
//!
//! **The key is the client address, which is not the peer address.** The API
//! is reached through Caddy in every deployment this repository ships
//! (docs/06 §1), so the peer address is the proxy's and keying on it would put
//! every coordinator in the world in one bucket. The client address therefore
//! comes from `X-Forwarded-For` — but only by counting from the *right*, and
//! only as far as the operator says the trusted chain reaches
//! (`EVP_TRUSTED_PROXY_HOPS`). Caddy *appends* to whatever the client sent, so
//! the left of that header is attacker-controlled: reading the first entry —
//! which is what a "smart" IP extractor does — lets anybody pick their own
//! rate-limit bucket by sending one header.
//!
//! **The refusal is `problem+json`.** `tower_governor` answers `text/plain`
//! by default, which contradicts docs/04 for exactly the reasons
//! [`crate::extract`] exists: a client told that every error carries a `type`
//! to branch on gets a body with none. The layer is given an error handler
//! that routes back through [`ApiError`].
//!
//! **The bucket store is swept.** `governor`'s keyed store never forgets a key
//! on its own, and the key here is chosen by the caller — a single client on a
//! `/64` can mint 2^64 of them. [`RateLimitSweeper`] drops the buckets that are
//! indistinguishable from fresh ones; the composition root calls it on a timer.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ConnectInfo;
use axum::http::Request;
use axum::http::header::HeaderMap;
use axum::response::{IntoResponse as _, Response};
use axum::routing::MethodRouter;
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::KeyExtractor;
use tower_governor::{GovernorError, GovernorLayer};

use crate::error::ApiError;

/// The header every reverse proxy in this stack sets. `Forwarded` (RFC 7239)
/// is deliberately not read: Caddy does not send it, and a second accepted
/// spelling is a second thing to get the trust rules right for.
const FORWARDED_FOR: &str = "x-forwarded-for";

/// The bucket shared by every caller whose address could not be determined.
///
/// Unreachable in a served deployment — the composition root installs
/// `ConnectInfo`, so there is always a peer address — and reachable in a test
/// that drives the router directly. Sharing one bucket is the fail-*closed*
/// answer: an unidentifiable caller is throttled with the others rather than
/// exempted, and the alternative (refusing the request) would turn a missing
/// extension into a 500 on the one route a deployment cannot do without.
const UNIDENTIFIED: IpAddr = IpAddr::V4(Ipv4Addr::UNSPECIFIED);

/// What the deployment decided about throttling, resolved once at startup.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitPolicy {
    /// Attempts a single client address may make back to back.
    ///
    /// Sized for simultaneity rather than for sustained load: a dozen
    /// coordinators signing in from one office NAT at eight in the morning are
    /// one address to everything downstream of the proxy.
    pub login_burst: u32,
    /// How long until one attempt of that burst comes back.
    pub login_replenish: Duration,
    /// How many reverse proxies stand between the internet and this process.
    ///
    /// `1` for every deployment this repository ships — Caddy, and nothing
    /// else. `0` means the process is exposed directly and no forwarded header
    /// may be believed; a higher number means a CDN or load balancer in front
    /// of Caddy, and it must be exact: too high reads an entry the client
    /// wrote, too low reads a proxy's own address and throttles everybody
    /// behind it as one.
    pub trusted_proxy_hops: usize,
}

/// Drops the rate-limit buckets nobody is using any more.
///
/// Separate from the layer because the loop that drives it belongs to the
/// composition root, not to a library: a crate that spawns its own background
/// task is a crate whose shutdown behaviour is invisible from `main`.
pub struct RateLimitSweeper {
    sweep: Box<dyn Fn() + Send + Sync + 'static>,
}

impl RateLimitSweeper {
    /// Drop every bucket whose state is indistinguishable from a fresh one,
    /// which is every client that has not been seen for a full quota period.
    ///
    /// Cheap and safe to call at any time: a client whose bucket is dropped
    /// simply starts again from a full burst, which is what it would have had
    /// anyway.
    pub fn sweep(&self) {
        (self.sweep)();
    }

    /// One sweeper for two stores, so the composition root keeps driving a
    /// single timer however many routes carry a quota.
    #[must_use]
    pub(crate) fn and(self, other: Self) -> Self {
        Self {
            sweep: Box::new(move || {
                self.sweep();
                other.sweep();
            }),
        }
    }
}

impl fmt::Debug for RateLimitSweeper {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RateLimitSweeper")
            .finish_non_exhaustive()
    }
}

/// Wrap one route in the login quota, and hand back the sweeper for its store.
///
/// `None` if the quota is degenerate — a zero burst would refuse every request
/// and a zero period would replenish infinitely fast. `config.rs` refuses both
/// before this is reached, so the composition root treats it as a startup
/// failure rather than papering over it with a default nobody asked for.
pub(crate) fn protect<S>(
    route: MethodRouter<S>,
    policy: RateLimitPolicy,
) -> Option<(MethodRouter<S>, RateLimitSweeper)>
where
    S: Clone + Send + Sync + 'static,
{
    quota(
        route,
        policy.login_burst,
        policy.login_replenish,
        policy.trusted_proxy_hops,
    )
}

/// Submissions one client address may send back to back to
/// `POST /api/v1/public/forms/{slug}/submissions` (docs/09 §5).
///
/// Sized for a recruitment evening, not for one volunteer: a crew filling the
/// form in together on the venue's wifi is one address to this process, and
/// a refusal there costs a real sign-up. A script is bounded all the same —
/// ten a minute once the burst is spent — and what it does get through lands
/// in the review queue rather than the pool, which is the structural defence
/// (docs/09 §5, "a public submission never reaches the volunteer pool without
/// a coordinator resolving it").
///
/// A constant rather than an `EVP_*` variable, as `evp_db::MAX_CONNECTIONS`
/// is: it becomes configuration the day an operator has a reason to change
/// it. The *per claimed email* half of docs/09 §5's rule is not here: it has
/// to key on the body, which a `tower_governor` key extractor cannot read
/// without buffering it ahead of the handler.
const FORM_SUBMISSION_BURST: u32 = 20;
const FORM_SUBMISSION_REPLENISH: Duration = Duration::from_secs(6);

/// Wrap the public submission route in its own quota — a bucket store of its
/// own, so a flood of submissions cannot spend the login budget, or the
/// reverse.
pub(crate) fn protect_form_submissions<S>(
    route: MethodRouter<S>,
    policy: RateLimitPolicy,
) -> Option<(MethodRouter<S>, RateLimitSweeper)>
where
    S: Clone + Send + Sync + 'static,
{
    quota(
        route,
        FORM_SUBMISSION_BURST,
        FORM_SUBMISSION_REPLENISH,
        policy.trusted_proxy_hops,
    )
}

fn quota<S>(
    route: MethodRouter<S>,
    burst: u32,
    replenish: Duration,
    hops: usize,
) -> Option<(MethodRouter<S>, RateLimitSweeper)>
where
    S: Clone + Send + Sync + 'static,
{
    let config = Arc::new(
        GovernorConfigBuilder::default()
            .period(replenish)
            .burst_size(burst)
            .key_extractor(ClientIp { hops })
            .finish()?,
    );

    let sweeper = {
        let config = Arc::clone(&config);
        RateLimitSweeper {
            sweep: Box::new(move || {
                let limiter = config.limiter();
                limiter.retain_recent();
                tracing::debug!(buckets = limiter.len(), "rate-limit buckets swept");
            }),
        }
    };

    Some((
        route.layer(GovernorLayer::new(config).error_handler(rejection)),
        sweeper,
    ))
}

/// The one error envelope this API has, for a refusal produced by middleware
/// that has never heard of it.
fn rejection(error: GovernorError) -> Response {
    let retry_after_seconds = match error {
        // Rounded up rather than reported as given: `wait_time` is whole
        // seconds, so a sub-second wait arrives as `0`, and `Retry-After: 0`
        // invites the client to retry into the same refusal immediately.
        GovernorError::TooManyRequests { wait_time, .. } => wait_time.max(1),
        // Unreachable while [`ClientIp::extract`] is infallible, which it is.
        // Answering 429 rather than 500 is the deliberate choice if that ever
        // stops being true: a rate limiter that cannot identify a caller has
        // to fail closed, or it is a way to switch itself off.
        other => {
            tracing::error!(error = %other, "the rate limiter could not classify a request");
            1
        }
    };

    ApiError::RateLimited {
        retry_after_seconds,
    }
    .into_response()
}

/// Keys the quota by the address of whoever is actually calling.
///
/// The two trait methods below the extraction are `tower_governor`'s tracing
/// hooks, and exist only while its `tracing` feature is on — which is why that
/// feature is not optional for this workspace (see the root `Cargo.toml`).
#[derive(Debug, Clone, Copy)]
struct ClientIp {
    hops: usize,
}

impl KeyExtractor for ClientIp {
    type Key = IpAddr;

    fn name(&self) -> &'static str {
        "client address"
    }

    fn extract<T>(&self, request: &Request<T>) -> Result<Self::Key, GovernorError> {
        Ok(self.client_address(request))
    }

    fn key_name(&self, key: &Self::Key) -> Option<String> {
        Some(key.to_string())
    }
}

impl ClientIp {
    fn client_address<T>(self, request: &Request<T>) -> IpAddr {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(address)| address.ip());

        if self.hops == 0 {
            return peer.unwrap_or(UNIDENTIFIED);
        }

        // Falling back to the peer address covers the request that did not
        // come through the whole chain — a health check on the container
        // network, a proxy misconfigured to drop the header — and is the safe
        // direction: the peer is an address this process observed rather than
        // one it was told about.
        forwarded_for(request.headers(), self.hops)
            .or(peer)
            .unwrap_or(UNIDENTIFIED)
    }
}

/// The entry `hops` positions from the **right** of the forwarded chain.
///
/// Counting from the right is the whole defence. Each proxy appends the
/// address it saw, so the rightmost entry was written by the proxy nearest
/// this process and the leftmost by whoever felt like sending a header. With
/// one trusted hop the last entry is the address Caddy observed; entries to
/// the left of it are the client's fiction and shift nothing, because the
/// index is anchored to the end.
///
/// Unparseable entries keep their position rather than being filtered out —
/// dropping them would let a client shift the index by sending junk.
fn forwarded_for(headers: &HeaderMap, hops: usize) -> Option<IpAddr> {
    let chain: Vec<&str> = headers
        .get_all(FORWARDED_FOR)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .collect();

    let index = chain.len().checked_sub(hops)?;
    parse_address(chain.get(index)?)
}

/// A chain entry is a bare address, but a proxy that forwards the source port
/// writes `address:port`, and IPv6 then arrives bracketed. Both spellings are
/// the same address and must land in the same bucket.
fn parse_address(entry: &str) -> Option<IpAddr> {
    entry
        .parse::<IpAddr>()
        .ok()
        .or_else(|| entry.parse::<SocketAddr>().ok().map(|address| address.ip()))
}

#[cfg(test)]
mod tests {
    use super::{ClientIp, RateLimitPolicy, UNIDENTIFIED, protect};
    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::extract::ConnectInfo;
    use axum::http::{Request, StatusCode, header};
    use axum::routing::post;
    use std::net::{IpAddr, SocketAddr};
    use std::time::Duration;
    use tower::ServiceExt as _;

    /// The address Caddy would have appended, and the one a client may claim.
    const REAL: &str = "203.0.113.7";
    const CLAIMED: &str = "198.51.100.9";
    const PEER: &str = "10.0.0.2";

    fn address(literal: &str) -> IpAddr {
        literal.parse().expect("the test literals are addresses")
    }

    /// A request as it reaches the extractor: an optional forwarded chain, and
    /// the peer address axum's `ConnectInfo` would carry.
    fn arriving(chain: Option<&str>, peer: Option<&str>) -> Request<()> {
        let mut builder = Request::post("/api/v1/auth/login");
        if let Some(chain) = chain {
            builder = builder.header("x-forwarded-for", chain);
        }
        if let Some(peer) = peer {
            let socket = SocketAddr::new(address(peer), 51_234);
            builder = builder.extension(ConnectInfo(socket));
        }
        builder.body(()).expect("a request with no body")
    }

    fn key_of(hops: usize, chain: Option<&str>, peer: Option<&str>) -> IpAddr {
        ClientIp { hops }.client_address(&arriving(chain, peer))
    }

    #[test]
    fn one_trusted_hop_takes_the_address_that_proxy_appended() {
        assert_eq!(key_of(1, Some(REAL), Some(PEER)), address(REAL));
    }

    #[test]
    fn a_client_cannot_choose_its_own_bucket() {
        // What Caddy forwards when the client sent a header of its own: its
        // fiction first, the address Caddy actually saw appended after it.
        let forged = format!("{CLAIMED}, {REAL}");
        assert_eq!(key_of(1, Some(&forged), Some(PEER)), address(REAL));

        // And two of them shift nothing, because the index counts from the end.
        let doubled = format!("{CLAIMED}, {CLAIMED}, {REAL}");
        assert_eq!(key_of(1, Some(&doubled), Some(PEER)), address(REAL));
    }

    #[test]
    fn two_trusted_hops_look_one_entry_further_left() {
        let chain = format!("{CLAIMED}, {REAL}, 192.0.2.1");
        assert_eq!(key_of(2, Some(&chain), Some(PEER)), address(REAL));
    }

    #[test]
    fn no_trusted_proxy_means_the_header_is_not_read_at_all() {
        assert_eq!(key_of(0, Some(CLAIMED), Some(PEER)), address(PEER));
    }

    #[test]
    fn a_chain_shorter_than_the_trusted_hops_falls_back_to_the_peer() {
        assert_eq!(key_of(2, Some(REAL), Some(PEER)), address(PEER));
        assert_eq!(key_of(1, None, Some(PEER)), address(PEER));
    }

    #[test]
    fn an_entry_that_is_not_an_address_falls_back_to_the_peer() {
        assert_eq!(key_of(1, Some("not-an-address"), Some(PEER)), address(PEER));
    }

    #[test]
    fn an_entry_carrying_a_port_is_the_same_bucket_as_one_without() {
        let with_port = format!("{REAL}:41234");
        assert_eq!(key_of(1, Some(&with_port), Some(PEER)), address(REAL));
        assert_eq!(
            key_of(1, Some("[2001:db8::1]:443"), None),
            address("2001:db8::1")
        );
    }

    #[test]
    fn a_caller_with_no_address_at_all_shares_one_bucket() {
        assert_eq!(key_of(1, None, None), UNIDENTIFIED);
    }

    /// One attempt, then the next is refused: enough to assert the shape of
    /// the refusal, which is the part a client has to understand.
    #[tokio::test]
    async fn the_refusal_is_problem_json_with_a_retry_after() {
        let policy = RateLimitPolicy {
            login_burst: 1,
            login_replenish: Duration::from_secs(60),
            trusted_proxy_hops: 1,
        };
        let (route, sweeper) = protect(post(|| async { StatusCode::NO_CONTENT }), policy)
            .expect("a burst of one is a usable quota");
        let app = Router::new().route("/probe", route);

        let first = app
            .clone()
            .oneshot(
                Request::post("/probe")
                    .body(Body::empty())
                    .expect("a request"),
            )
            .await
            .expect("the router answers");
        assert_eq!(first.status(), StatusCode::NO_CONTENT);

        let second = app
            .clone()
            .oneshot(
                Request::post("/probe")
                    .body(Body::empty())
                    .expect("a request"),
            )
            .await
            .expect("the router answers");

        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            second
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/problem+json")
        );
        // docs/04 §2: a 429 carries `Retry-After`, and a client that obeys it
        // must not be sent straight back into the same refusal.
        let retry_after = second
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .expect("a whole number of seconds");
        assert!(retry_after >= 1, "{retry_after}");

        let body = to_bytes(second.into_body(), usize::MAX)
            .await
            .expect("the body is in memory");
        let document: serde_json::Value = serde_json::from_slice(&body).expect("the body is JSON");
        assert_eq!(
            document.get("type").and_then(serde_json::Value::as_str),
            Some("https://evp.example/errors/rate-limited")
        );

        // Nothing to assert beyond "it runs and does not take the buckets of
        // a client that is still being refused": the bucket above is not
        // fresh, so it must survive.
        sweeper.sweep();
        let third = app
            .oneshot(
                Request::post("/probe")
                    .body(Body::empty())
                    .expect("a request"),
            )
            .await
            .expect("the router answers");
        assert_eq!(third.status(), StatusCode::TOO_MANY_REQUESTS);
    }
}
