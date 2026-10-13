// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `SmsSender` and the OVH implementation (docs/02 §"Async work": "SMS | HTTP
//! provider behind an `SmsSender` trait; OVH first"), ported from
//! `docs/googleSheets/send-sms.js`'s `sendSMSWithOVH` (ADR-0034).
//!
//! **Not wired into the outbox consumer.** There is no outbox table yet
//! (docs/02 §"Async work" is itself unbuilt) and no recipient-selection or
//! template feature to feed it — see ADR-0034's "What is not built here".
//! This module is the trait plus a correct, unit-tested OVH client; a future
//! task calls `evp_db::sms_settings::decrypted` to build one of these per
//! organisation and actually enqueues a send.

use std::future::Future;
use std::pin::Pin;

use evp_domain::Clock;
use serde::Serialize;
use sha1::{Digest as _, Sha1};

use crate::gsm7;

/// Anything that can deliver one SMS. `dyn`-safe by construction (a boxed
/// future rather than `async fn` in the trait), because the outbox consumer
/// this eventually serves picks a provider per organisation at runtime.
pub trait SmsSender: Send + Sync {
    /// Sends `message` to `to` (E.164). `message` is transliterated to
    /// GSM-7 by the implementation, not the caller — same as `sendSms` in
    /// the spreadsheet workflow, which always routed through
    /// `sendSMSWithOVH` and never sent raw text.
    fn send<'a>(
        &'a self,
        to: &'a str,
        message: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), SmsError>> + Send + 'a>>;
}

#[derive(Debug, thiserror::Error)]
pub enum SmsError {
    /// The OVH API answered outside 2xx.
    #[error("the SMS provider rejected the request ({status}): {body}")]
    Provider { status: u16, body: String },
    /// Could not even reach it.
    #[error("could not reach the SMS provider")]
    Transport(#[source] reqwest::Error),
}

/// The `body` object from `sendSMSWithOVH`, field for field. `Serialize`'s
/// struct field order is declaration order (this is not a `serde_json::Map`,
/// which — without the `preserve_order` feature this workspace does not
/// enable — would sort keys alphabetically and silently stop matching what
/// OVH's own docs show). Byte-for-byte parity with `send-sms.js`'s key order
/// is not what OVH actually requires, though: the requirement is only that
/// the signed string and the sent body are identical, which
/// [`OvhSmsSender::send`] guarantees by signing exactly what it serializes,
/// once.
#[derive(Debug, Serialize)]
struct OvhSmsRequest<'a> {
    charset: &'static str,
    class: &'static str,
    coding: &'static str,
    message: &'a str,
    #[serde(rename = "noStopClause")]
    no_stop_clause: bool,
    priority: &'static str,
    receivers: [&'a str; 1],
    sender: &'a str,
    #[serde(rename = "senderForResponse")]
    sender_for_response: bool,
    #[serde(rename = "validityPeriod")]
    validity_period: u32,
}

/// Lowercase hex. Same idiom as `evp_domain::token::hex` (not reused
/// directly — that function is private to its crate): `char::from_digit`
/// rather than a lookup table, because the workspace denies
/// `indexing_slicing`, and `extend` over the `Option` it returns expresses
/// "both nibbles are always < 16" without an `unwrap` the lints also deny.
fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        out.extend(char::from_digit(u32::from(byte >> 4), 16));
        out.extend(char::from_digit(u32::from(byte & 0x0f), 16));
    }
    out
}

/// `'$1$' + SHA1(secret + '+' + consumer + '+' + method + '+' + url + '+' +
/// body + '+' + timestamp)` — OVH's own scheme (docs/17: "not a choice this
/// project made"), plain SHA-1 rather than HMAC because that is what OVH's
/// API specifies.
#[must_use]
pub fn signature(
    application_secret: &str,
    consumer_key: &str,
    method: &str,
    url: &str,
    body: &str,
    timestamp: &str,
) -> String {
    let mut to_sign = String::with_capacity(
        application_secret
            .len()
            .saturating_add(consumer_key.len())
            .saturating_add(method.len())
            .saturating_add(url.len())
            .saturating_add(body.len())
            .saturating_add(timestamp.len())
            .saturating_add(5),
    );
    to_sign.push_str(application_secret);
    to_sign.push('+');
    to_sign.push_str(consumer_key);
    to_sign.push('+');
    to_sign.push_str(method);
    to_sign.push('+');
    to_sign.push_str(url);
    to_sign.push('+');
    to_sign.push_str(body);
    to_sign.push('+');
    to_sign.push_str(timestamp);

    let digest = Sha1::digest(to_sign.as_bytes());
    let mut signature = String::with_capacity(44);
    signature.push_str("$1$");
    signature.push_str(&to_hex(&digest));
    signature
}

/// A path segment is escaped the same conservative way `encodeURIComponent`
/// would for the characters an OVH `serviceName` could plausibly contain —
/// full RFC 3986 generality is not needed for one path segment with no
/// external dependency pulled in to get it.
fn percent_encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || byte == b'-'
            || byte == b'_'
            || byte == b'.'
            || byte == b'~';
        if unreserved {
            out.push(char::from(byte));
        } else {
            out.push('%');
            let hex = to_hex(&[byte]);
            out.push_str(&hex.to_uppercase());
        }
    }
    out
}

#[derive(Debug)]
pub struct OvhSmsSender<'c> {
    http: reqwest::Client,
    credentials: evp_db::sms_settings::OvhCredentials,
    clock: &'c dyn Clock,
}

impl<'c> OvhSmsSender<'c> {
    #[must_use]
    pub fn new(
        http: reqwest::Client,
        credentials: evp_db::sms_settings::OvhCredentials,
        clock: &'c dyn Clock,
    ) -> Self {
        Self {
            http,
            credentials,
            clock,
        }
    }

    fn jobs_url(&self) -> String {
        let mut url = String::from("https://eu.api.ovh.com/1.0/sms/");
        url.push_str(&percent_encode_segment(&self.credentials.service_name));
        url.push_str("/jobs");
        url
    }
}

impl SmsSender for OvhSmsSender<'_> {
    fn send<'a>(
        &'a self,
        to: &'a str,
        message: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), SmsError>> + Send + 'a>> {
        Box::pin(async move {
            let url = self.jobs_url();
            let optimized = gsm7::optimize(message);
            let request = OvhSmsRequest {
                charset: "UTF-8",
                class: "phoneDisplay",
                coding: "7bit",
                message: &optimized,
                no_stop_clause: true,
                priority: "high",
                receivers: [to],
                sender: &self.credentials.sender,
                sender_for_response: false,
                validity_period: 2880,
            };
            // Infallible for this struct — every field is a primitive, a
            // string slice or a one-element array of one — but `serde_json`
            // still returns a `Result`, so this is the one place that has to
            // decide what an impossible failure means. `unwrap_or_default`
            // would silently sign and send an *empty* body; refusing is the
            // honest answer to "this should never happen".
            let Ok(body) = serde_json::to_string(&request) else {
                return Err(SmsError::Provider {
                    status: 0,
                    body: "could not serialise the OVH SMS request body".to_owned(),
                });
            };

            let timestamp = self.clock.now().as_second().to_string();
            let signature = signature(
                &self.credentials.application_secret,
                &self.credentials.consumer_key,
                "POST",
                &url,
                &body,
                &timestamp,
            );

            let response = self
                .http
                .post(&url)
                .header("X-Ovh-Application", &self.credentials.application_key)
                .header("X-Ovh-Consumer", &self.credentials.consumer_key)
                .header("X-Ovh-Timestamp", &timestamp)
                .header("X-Ovh-Signature", &signature)
                .header(
                    reqwest::header::CONTENT_TYPE,
                    "application/json; charset=utf-8",
                )
                .body(body)
                .send()
                .await
                .map_err(SmsError::Transport)?;

            let status = response.status();
            if status.is_success() {
                return Ok(());
            }
            let body = response.text().await.unwrap_or_default();
            Err(SmsError::Provider {
                status: status.as_u16(),
                body,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{OvhSmsRequest, signature};

    /// `python3 -c` computed this independently from the same inputs — see
    /// this crate's PR description / ADR-0034 for the exact command — so the
    /// test is not "the Rust code agrees with itself", it is "the Rust code
    /// agrees with a SHA-1 implementation that never saw this file".
    #[test]
    fn signature_matches_an_independently_computed_sha1() {
        let request = OvhSmsRequest {
            charset: "UTF-8",
            class: "phoneDisplay",
            coding: "7bit",
            message: "Bonjour",
            no_stop_clause: true,
            priority: "high",
            receivers: ["+33600000000"],
            sender: "EVP",
            sender_for_response: false,
            validity_period: 2880,
        };
        let body = serde_json::to_string(&request).expect("request serialises");
        assert_eq!(
            body,
            "{\"charset\":\"UTF-8\",\"class\":\"phoneDisplay\",\"coding\":\"7bit\",\
             \"message\":\"Bonjour\",\"noStopClause\":true,\"priority\":\"high\",\
             \"receivers\":[\"+33600000000\"],\"sender\":\"EVP\",\
             \"senderForResponse\":false,\"validityPeriod\":2880}",
            "the body signed must be exactly the body this test independently verified",
        );

        let computed = signature(
            "s3cr3t-app-secret",
            "c0nsum3r-key",
            "POST",
            "https://eu.api.ovh.com/1.0/sms/sms-test-1/jobs",
            &body,
            "1700000000",
        );

        assert_eq!(
            computed, "$1$751cf01ed7ea853d973e0905035cf8ba4255e438",
            "hashlib.sha1 over the same six-part string produced this digest"
        );
    }

    #[test]
    fn changing_any_signed_field_changes_the_signature() {
        let base = signature("secret", "consumer", "POST", "https://x/y", "{}", "100");
        let different_secret = signature("secret2", "consumer", "POST", "https://x/y", "{}", "100");
        let different_body = signature(
            "secret",
            "consumer",
            "POST",
            "https://x/y",
            "{\"a\":1}",
            "100",
        );
        let different_timestamp =
            signature("secret", "consumer", "POST", "https://x/y", "{}", "101");

        assert_ne!(base, different_secret);
        assert_ne!(base, different_body);
        assert_ne!(base, different_timestamp);
    }
}
