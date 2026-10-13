// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Extractors whose rejections are [`ApiError`]s, so that no request can leave
//! this crate shaped like anything but RFC 9457.
//!
//! [`axum::Json`] is a good deserialiser and a bad citizen of this API. Its
//! rejection is `text/plain` carrying serde's own words:
//!
//! ```text
//! Failed to deserialize the JSON body into the target type: missing field `password` at line 1 column 17
//! ```
//!
//! which contradicts docs/04 twice over. A client that was told every error is
//! `application/problem+json` gets a body with no `type` to branch on, and the
//! prose it does get describes our deserialiser rather than the caller's
//! mistake (docs/12 §5). Worse, that prose quotes the submitted value back —
//! a numeric `password` field comes back as "invalid type: integer 12345" —
//! and the one endpoint that most needs this fixing takes a password.
//!
//! So handlers take [`JsonBody`], whose only difference from `axum::Json` is
//! `type Rejection = ApiError`.
//!
//! **Why a module of its own rather than [`crate::error`].** `error` answers
//! "what does a failure look like on the wire?" and is the single place that
//! decides; an extractor is not that, it is one more thing that can fail and
//! must route into it. The same treatment is owed to `Query` and `Path`, whose
//! rejections are plain text for exactly the same reason, and they will land
//! beside this one rather than accreting in `error`.
//!
//! **Why it is generic rather than a fix to `login`.** The defect is not that
//! one handler used `axum::Json`; it is that using `axum::Json` was the
//! obvious thing to write. A replacement that is not available to every
//! handler leaves the next one free to reintroduce it silently.

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use axum::http::{StatusCode, header};
use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// A JSON request body. Deserialises exactly like [`axum::Json`] and rejects
/// as an [`ApiError`].
///
/// Named `JsonBody` rather than `Json` deliberately: handlers return
/// `Json<UserResponse>` and take `JsonBody<LoginRequest>`, so the direction is
/// legible in the signature and an import cannot quietly shadow one with the
/// other.
#[derive(Debug, Clone, Copy, Default)]
pub struct JsonBody<T>(pub T);

impl<T, S> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        axum::Json::<T>::from_request(request, state)
            .await
            .map(|axum::Json(value)| Self(value))
            .map_err(ApiError::from)
    }
}

/// The caller-safe sentence for a body that parsed as JSON but is not the
/// document this endpoint expects.
///
/// It is the one detail in this module rather than in [`crate::error`], because
/// [`ApiError::Invalid`] is by design the variant that carries its own message
/// — the other three arms below are single-cause and their prose lives beside
/// the rest of the envelope.
///
/// Fixed, rather than naming the offending field. Naming it would be genuinely
/// helpful, and the only place that name exists is serde's message — whose
/// wording is not a contract and which quotes submitted values (see the module
/// documentation). Recovering a field name by parsing that prose would make
/// this response body depend on a `serde_json` patch release; the honest way
/// to tell a client which fields are required is the generated OpenAPI
/// document, which does it before the request is sent rather than after.
const DATA_DETAIL: &str =
    "The request body is missing a required field, or a field has the wrong type.";

impl From<JsonRejection> for ApiError {
    /// Maps each rejection onto the variant that keeps its status.
    ///
    /// `JsonRejection` already distinguishes four faults with four statuses,
    /// and flattening them into the one variant that happened to exist would
    /// be the real regression: a caller who forgot a header fixes it by
    /// setting a header, a caller who sent a truncated document fixes it by
    /// sending the whole one, and neither learns that from `422`. That is why
    /// [`ApiError::Malformed`], [`ApiError::UnsupportedMediaType`] and
    /// [`ApiError::PayloadTooLarge`] were added rather than reusing
    /// [`ApiError::Invalid`] for everything — `Invalid` keeps only the case it
    /// already described, a body that parsed and is semantically unusable.
    ///
    /// The wildcard arm exists because `JsonRejection` is `#[non_exhaustive]`:
    /// a kind added by a future axum must degrade to a correct-shaped `400`
    /// rather than fail the build or, worse, be mapped by guesswork.
    fn from(rejection: JsonRejection) -> Self {
        // The cause is logged here rather than carried into the variant, which
        // inverts what `ApiError::Internal` does and for the same underlying
        // reason: `Internal` may hold its cause because no arm of `detail()`
        // ever returns it, whereas `Invalid` returns its string verbatim. A
        // cause that cannot be carried safely is a cause that gets recorded at
        // the point it is dropped.
        //
        // `debug` rather than `warn`: a wrong-shaped body is a routine event on
        // a public endpoint — a scanner, a half-written integration — so an
        // operator alerting on it learns nothing. `debug` is also the ceiling
        // on purpose, because the message can quote a submitted value and
        // production runs at `evp=info` (compose.prod.yaml); a developer
        // integrating a client turns `evp=debug` on and sees the real text.
        tracing::debug!(
            status = %rejection.status(),
            rejection = %rejection,
            "request body rejected"
        );

        match rejection {
            JsonRejection::JsonDataError(_) => Self::Invalid(DATA_DETAIL.to_owned()),
            JsonRejection::MissingJsonContentType(_) => Self::UnsupportedMediaType,
            // `BytesRejection` is either a length-limit breach or a body that
            // stopped arriving, and only the first has a status of its own.
            // Told apart by the status axum already computed rather than by a
            // nested match, because `FailedToBufferBody` underneath it is
            // non-exhaustive too.
            JsonRejection::BytesRejection(inner)
                if inner.status() == StatusCode::PAYLOAD_TOO_LARGE =>
            {
                Self::PayloadTooLarge
            }
            // `JsonSyntaxError`, a body that stopped arriving, and whatever a
            // future axum adds: all of them are `400`, and folding them into
            // one arm is what keeps a new rejection kind from compiling into a
            // guess about which of the others it resembles.
            _ => Self::Malformed,
        }
    }
}

// ---------------------------------------------------------------------------
// Optimistic concurrency (docs/04 §1, "Optimistic concurrency")
// ---------------------------------------------------------------------------

/// What an `If-Match` header asserts about the resource the caller is about to
/// change.
///
/// Rendered from, and compared against, the `version` column every versioned
/// table carries and every `*_bump_version` trigger maintains. The entity-tag
/// on the wire is that integer in quotes — `"3"` — so the `ETag` a client echoes
/// back is the row version, and there is no second concurrency token to keep in
/// step with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IfMatch {
    /// `If-Match: *` — "whatever version, as long as it still exists". The
    /// HTTP-defined wildcard, honoured rather than refused: a client doing
    /// blind-but-safe overwrite of a resource it knows nothing about is a
    /// legitimate use, and it still fails against a row that has been deleted.
    Any,
    /// `If-Match: "3"` — this exact row version and no other.
    Version(i32),
}

impl IfMatch {
    /// Does the row the handler just read satisfy what the caller asserted?
    #[must_use]
    pub fn matches(self, version: i32) -> bool {
        match self {
            Self::Any => true,
            Self::Version(expected) => expected == version,
        }
    }

    /// The `version` a `WHERE version = $n` predicate should carry, or `None`
    /// for the wildcard, which constrains nothing.
    #[must_use]
    pub fn version(self) -> Option<i32> {
        match self {
            Self::Any => None,
            Self::Version(version) => Some(version),
        }
    }
}

/// The `ETag` value for a row at `version`.
#[must_use]
pub fn etag(version: i32) -> String {
    format!("\"{version}\"")
}

/// Parses one `If-Match` header value.
///
/// Returns `None` for anything this API cannot have issued — a weak tag
/// (`W/"3"`), an unquoted or non-numeric tag, an empty list. Those are not
/// rejected as malformed: an entity-tag we did not mint cannot match a row we
/// own, so the honest answer is the same `409` a stale tag gets. Treating them
/// as `400` would invite a client to retry with a "fixed" tag that is equally
/// meaningless.
///
/// A multi-tag list (`"3", "4"`) matches if any member does, which is what
/// RFC 9110 §13.1.1 says and costs nothing to honour.
fn parse_if_match(raw: &str) -> Option<Vec<IfMatch>> {
    let raw = raw.trim();
    if raw == "*" {
        return Some(vec![IfMatch::Any]);
    }
    let tags: Vec<IfMatch> = raw
        .split(',')
        .filter_map(|tag| {
            tag.trim()
                .strip_prefix('"')
                .and_then(|rest| rest.strip_suffix('"'))
                .and_then(|digits| digits.parse().ok())
                .map(IfMatch::Version)
        })
        .collect();
    (!tags.is_empty()).then_some(tags)
}

/// The `If-Match` precondition a caller attached to an unsafe method.
///
/// Extracting it is how docs/04 §1's "a missing `If-Match` is `428`, not a
/// silent overwrite" is enforced: a handler that takes this parameter cannot
/// run without one, the same way a handler that takes [`crate::org::Owner`]
/// cannot run for a coordinator. There is deliberately no optional variant —
/// an endpoint either is versioned or is not, and "concurrency checking if the
/// client felt like it" is the behaviour this replaces.
#[derive(Debug, Clone)]
pub struct Precondition(pub Vec<IfMatch>);

impl Precondition {
    /// Reads the header, which is all this extractor does.
    ///
    /// # Errors
    ///
    /// [`ApiError::PreconditionRequired`] if there is no readable `If-Match`.
    fn from_headers(headers: &axum::http::HeaderMap) -> Result<Self, ApiError> {
        let raw = headers
            .get(header::IF_MATCH)
            .ok_or(ApiError::PreconditionRequired)?;
        // A header that is not even UTF-8 is treated as absent rather than as
        // a mismatch: the caller has not made an assertion this API can read,
        // so telling them to send one is the useful answer.
        let raw = raw.to_str().map_err(|_| ApiError::PreconditionRequired)?;
        let tags = parse_if_match(raw).unwrap_or_default();
        if tags.is_empty() {
            // An unreadable tag list is a mismatch, not a missing header — see
            // `parse_if_match`. `-1` is a version no row can hold, so `check`
            // refuses whatever it is given.
            return Ok(Self(vec![IfMatch::Version(-1)]));
        }
        Ok(Self(tags))
    }

    /// Checks the precondition against the row the handler read, turning a
    /// mismatch into the `409` docs/04 §2 specifies.
    ///
    /// # Errors
    ///
    /// [`ApiError::Conflict`] if no tag the caller sent names `version`.
    pub fn check(&self, version: i32) -> Result<(), ApiError> {
        if self.0.iter().any(|tag| tag.matches(version)) {
            return Ok(());
        }
        Err(ApiError::Conflict(format!(
            "This resource has changed since you read it; it is now at version {version}. \
             Re-read it and reapply your change."
        )))
    }
}

impl<S> FromRequestParts<S> for Precondition
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    // Not `async fn`: there is nothing to await — the header is already in
    // `parts` — and an `async` body with no `.await` in it is a future that
    // exists only to be polled once.
    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Self::from_headers(&parts.headers))
    }
}

#[cfg(test)]
mod tests {
    use super::JsonBody;
    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode, header};
    use axum::routing::post;
    use serde::Deserialize;
    use tower::ServiceExt as _;

    /// Stands in for `LoginRequest`: two required strings, one of them named
    /// `password`, because the disclosure this module exists to stop is serde
    /// naming that field — or quoting its value — in a response body.
    #[derive(Debug, Deserialize)]
    struct Probe {
        email: String,
        password: String,
    }

    async fn probe(JsonBody(body): JsonBody<Probe>) -> String {
        format!("{}/{}", body.email, body.password.len())
    }

    /// What a caller actually receives: status line, media type, and the body
    /// as it went over the wire.
    ///
    /// The raw text is kept rather than only the parsed document because half
    /// of what is asserted below is an *absence* — serde's wording must not
    /// appear anywhere in the response, including in a field nobody thought to
    /// look at.
    struct Received {
        status: StatusCode,
        media_type: String,
        body: String,
    }

    impl Received {
        /// The `type` URI clients branch on, or the empty string if the body
        /// carried none — which is itself the bug this module fixes, so it
        /// must fail an assertion rather than panic the test.
        fn problem_type(&self) -> String {
            serde_json::from_str::<serde_json::Value>(&self.body)
                .ok()
                .as_ref()
                .and_then(|document| document.get("type"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned()
        }
    }

    async fn post_body(content_type: &str, body: &'static str) -> Received {
        let response = Router::new()
            .route("/probe", post(probe))
            .oneshot(
                Request::post("/probe")
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Body::from(body))
                    .expect("a request with one header and a literal body is well formed"),
            )
            .await
            .expect("routing a request to an existing route is infallible");

        let status = response.status();
        let media_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let bytes = to_bytes(response.into_body(), 65_536)
            .await
            .expect("a problem document is far below the limit");

        Received {
            status,
            media_type,
            body: String::from_utf8(bytes.to_vec()).expect("a problem document is UTF-8"),
        }
    }

    #[tokio::test]
    async fn a_well_formed_body_still_reaches_the_handler() {
        // The guard on the four below: an extractor that rejected everything
        // would pass all of them.
        let received = post_body(
            "application/json",
            r#"{"email":"a@b.c","password":"hunter22"}"#,
        )
        .await;

        assert_eq!(received.status, StatusCode::OK);
        assert_eq!(received.body, "a@b.c/8");
    }

    #[tokio::test]
    async fn a_missing_field_is_an_unprocessable_entity_problem() {
        let received = post_body("application/json", r#"{"email":"a@b.c"}"#).await;

        assert_eq!(
            received.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            received.body
        );
        assert_eq!(
            received.media_type, "application/problem+json",
            "{}",
            received.body
        );
        assert_eq!(
            received.problem_type(),
            "https://evp.example/errors/invalid-request",
            "nothing stable for a client to branch on: {}",
            received.body
        );
    }

    #[tokio::test]
    async fn a_rejected_body_never_carries_serde_s_own_words() {
        // The regression this module was written for. Asserted separately from
        // the status above because it is a different behaviour: that one is
        // about the contract, this one is about what the contract may contain.
        let received = post_body("application/json", r#"{"email":"a@b.c"}"#).await;

        assert!(
            !received.body.contains("missing field"),
            "serde's message reached the caller: {}",
            received.body
        );
        assert!(
            !received.body.contains("Failed to deserialize"),
            "serde's message reached the caller: {}",
            received.body
        );
        assert!(
            !received.body.contains("password"),
            "the response named a field of the rejected request: {}",
            received.body
        );
    }

    #[tokio::test]
    async fn a_body_that_is_not_json_is_a_bad_request_problem() {
        // 400, not 422: this caller has to fix their serialiser, not a field.
        let received = post_body("application/json", "x").await;

        assert_eq!(
            received.status,
            StatusCode::BAD_REQUEST,
            "{}",
            received.body
        );
        assert_eq!(
            received.media_type, "application/problem+json",
            "{}",
            received.body
        );
        assert_eq!(
            received.problem_type(),
            "https://evp.example/errors/malformed-body",
            "{}",
            received.body
        );
        assert!(
            !received.body.contains("expected value"),
            "serde's message reached the caller: {}",
            received.body
        );
    }

    #[tokio::test]
    async fn the_wrong_content_type_is_an_unsupported_media_type_problem() {
        // 415, not 422: nothing is wrong with the body, and the caller fixes
        // this by setting one header.
        let received = post_body("text/plain", "x").await;

        assert_eq!(
            received.status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "{}",
            received.body
        );
        assert_eq!(
            received.media_type, "application/problem+json",
            "{}",
            received.body
        );
        assert_eq!(
            received.problem_type(),
            "https://evp.example/errors/unsupported-media-type",
            "{}",
            received.body
        );
    }
}
