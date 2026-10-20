// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `SmtpMailSender` against a real SMTP server: the dev stack's Mailpit
//! (docs/13 §"Testing the outbox"). Ignored by default because it needs the
//! `mailpit` service; `just test-mail` runs it inside Compose, where both
//! variables are set.
//!
//! It asserts on what Mailpit *received* through its HTTP API, not on what
//! lettre says it sent — the point is the bytes on the wire.

use std::hash::{BuildHasher as _, RandomState};

use evp_worker::mail::{MailSender as _, OutgoingMail, SmtpMailSender};
use serde_json::Value;

#[tokio::test]
#[ignore = "needs Mailpit; run with `just test-mail`"]
async fn a_message_reaches_mailpit_with_both_parts_and_its_headers() {
    let smtp_url = std::env::var("EVP_TEST_SMTP_URL").expect("set by `just test-mail`");
    let api = std::env::var("EVP_TEST_MAILPIT_API").expect("set by `just test-mail`");

    // Unique per run, so the search below finds this message and nothing a
    // developer left in the inbox. `RandomState` is seeded randomly per
    // process: a nonce without a clock read (ADR-0019) or a new dependency.
    let id = format!("mailpit-test-{:016x}", RandomState::new().hash_one(0_u8));
    let mail = OutgoingMail {
        id: id.clone(),
        to: "aurel@mailpit.test".to_owned(),
        from_name: Some("Festival des Lumières".to_owned()),
        reply_to: Some("benevoles@mailpit.test".to_owned()),
        subject: format!("Vos créneaux {id}"),
        html: "<p>Bonjour <strong>Aurel</strong></p>".to_owned(),
        text: "Bonjour Aurel".to_owned(),
    };

    let sender =
        SmtpMailSender::from_url(&smtp_url, "planner@evp.localhost").expect("valid config");
    sender
        .send(&mail)
        .await
        .expect("Mailpit accepts the message");

    let http = reqwest::Client::new();
    let found: Value = http
        .get(format!("{api}/api/v1/search"))
        .query(&[("query", format!("subject:\"{id}\""))])
        .send()
        .await
        .expect("Mailpit API reachable")
        .json()
        .await
        .expect("JSON");
    let messages = found["messages"].as_array().expect("messages array");
    assert_eq!(
        messages.len(),
        1,
        "exactly one message with this subject: {found}"
    );
    let summary = &messages[0];
    assert_eq!(summary["MessageID"], format!("{id}@evp.localhost"));
    assert_eq!(summary["From"]["Address"], "planner@evp.localhost");
    assert_eq!(summary["From"]["Name"], "Festival des Lumières");
    assert_eq!(summary["To"][0]["Address"], "aurel@mailpit.test");
    assert_eq!(summary["ReplyTo"][0]["Address"], "benevoles@mailpit.test");
    assert_eq!(summary["Subject"], mail.subject);

    let message: Value = http
        .get(format!(
            "{api}/api/v1/message/{}",
            summary["ID"].as_str().expect("ID")
        ))
        .send()
        .await
        .expect("Mailpit API reachable")
        .json()
        .await
        .expect("JSON");
    assert_eq!(
        message["Text"].as_str().map(str::trim),
        Some("Bonjour Aurel")
    );
    assert!(
        message["HTML"]
            .as_str()
            .is_some_and(|html| html.contains("<strong>Aurel</strong>")),
        "{message}"
    );
}
