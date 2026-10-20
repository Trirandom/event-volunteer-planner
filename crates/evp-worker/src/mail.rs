// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! `MailSender` and its SMTP implementation (docs/02 §"Async work": "Email |
//! SMTP via `lettre`"), with an in-memory sink for tests (docs/13 §"Testing
//! the outbox": Mailpit for SMTP, a sink for unit tests).
//!
//! **Not wired into the outbox consumer yet** — there is no outbox table.
//! Messages arrive here fully rendered: the worker never reads tenant data to
//! build one, so this module knows nothing about volunteers or schedules.
//!
//! Errors are split into [`MailError::Transient`] and [`MailError::Permanent`]
//! because the consumer treats them differently: a 4xx or a dropped
//! connection is retried with backoff, a 5xx or an unparseable address will
//! not get better and is parked at once.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, PoisonError};

use lettre::message::{Mailbox, MultiPart};
use lettre::transport::smtp;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport as _, Message, Tokio1Executor};

/// One rendered message, as the outbox payload carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingMail {
    /// Becomes the local part of `Message-ID`. The outbox row's id, so a
    /// message resent after a crash between "sent" and "marked sent" carries
    /// the same `Message-ID` and mail clients can collapse the duplicate
    /// (at-least-once delivery, ADR-0006).
    pub id: String,
    pub to: String,
    /// Display name on `From`. The address is always the deployment's
    /// `EVP_MAIL_FROM`; a relay will not sign for anyone else's domain.
    pub from_name: Option<String>,
    pub reply_to: Option<String>,
    pub subject: String,
    pub html: String,
    pub text: String,
}

/// Anything that can deliver one email. `dyn`-safe by construction, like
/// [`crate::ovh::SmsSender`], so the consumer can hold a `Box<dyn MailSender>`
/// and tests can swap in [`MemoryMailSender`].
pub trait MailSender: Send + Sync {
    fn send<'a>(
        &'a self,
        mail: &'a OutgoingMail,
    ) -> Pin<Box<dyn Future<Output = Result<(), MailError>> + Send + 'a>>;
}

#[derive(Debug, thiserror::Error)]
pub enum MailError {
    /// Worth retrying: a 4xx, a timeout, a refused or dropped connection.
    #[error("the mail relay could not take the message now")]
    Transient(#[source] smtp::Error),
    /// Will fail the same way every time: a 5xx, or a message that cannot be
    /// built from what was queued (a malformed address above all).
    #[error("the message was refused permanently: {0}")]
    Permanent(String),
}

impl MailError {
    #[must_use]
    pub fn is_permanent(&self) -> bool {
        matches!(self, Self::Permanent(_))
    }
}

/// The deployment's relay configuration could not be used.
#[derive(Debug, thiserror::Error)]
pub enum MailConfigError {
    /// Deliberately carries no detail: lettre's parse error can echo the
    /// URL, and the URL embeds the relay's credentials (docs/12 §5).
    #[error("EVP_SMTP_URL is not a valid smtp:// or smtps:// URL")]
    SmtpUrl,
    #[error("EVP_MAIL_FROM is not a valid email address")]
    MailFrom,
}

/// Delivers through the relay named by `EVP_SMTP_URL`.
///
/// TLS uses the operating system's root store (`rustls-native-certs`), which
/// distroless/cc ships; see docs/17 §7 for why it is not `webpki-roots`.
pub struct SmtpMailSender {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Address,
}

/// Hand-written so that the transport — which holds the relay credentials —
/// is never formatted, whatever lettre's own `Debug` does.
impl fmt::Debug for SmtpMailSender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SmtpMailSender")
            .field("from", &self.from)
            .finish_non_exhaustive()
    }
}

impl SmtpMailSender {
    /// `smtp://host:1025` (plain, Mailpit), `smtp://user:pass@host:587?tls=required`
    /// (STARTTLS) or `smtps://user:pass@host:465` (implicit TLS).
    ///
    /// # Errors
    ///
    /// When either value cannot be parsed. Neither error repeats the input.
    pub fn from_url(smtp_url: &str, mail_from: &str) -> Result<Self, MailConfigError> {
        let from = mail_from
            .parse::<Address>()
            .map_err(|_| MailConfigError::MailFrom)?;
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(smtp_url)
            .map_err(|_| MailConfigError::SmtpUrl)?
            .build();
        Ok(Self { transport, from })
    }
}

impl MailSender for SmtpMailSender {
    fn send<'a>(
        &'a self,
        mail: &'a OutgoingMail,
    ) -> Pin<Box<dyn Future<Output = Result<(), MailError>> + Send + 'a>> {
        Box::pin(async move {
            let message = build_message(&self.from, mail)?;
            match self.transport.send(message).await {
                Ok(_) => Ok(()),
                Err(error) if error.is_permanent() => Err(MailError::Permanent(error.to_string())),
                Err(error) => Err(MailError::Transient(error)),
            }
        })
    }
}

/// Builds the MIME message: `multipart/alternative` with the plain-text part
/// first, so a client that cannot render HTML shows the text rather than an
/// attachment.
///
/// # Errors
///
/// [`MailError::Permanent`] when an address does not parse.
pub fn build_message(from: &Address, mail: &OutgoingMail) -> Result<Message, MailError> {
    let mailbox = |raw: &str, what: &str| {
        raw.parse::<Mailbox>()
            .map_err(|_| MailError::Permanent(format!("invalid {what} address")))
    };
    let mut builder = Message::builder()
        .from(Mailbox::new(mail.from_name.clone(), from.clone()))
        .to(mailbox(&mail.to, "recipient")?)
        .subject(&mail.subject)
        .message_id(Some(format!("<{}@{}>", mail.id, from.domain())));
    if let Some(reply_to) = &mail.reply_to {
        builder = builder.reply_to(mailbox(reply_to, "reply-to")?);
    }
    builder
        .multipart(MultiPart::alternative_plain_html(
            mail.text.clone(),
            mail.html.clone(),
        ))
        .map_err(|error| MailError::Permanent(error.to_string()))
}

/// Records what it was asked to send instead of sending it.
#[derive(Debug, Default)]
pub struct MemoryMailSender {
    sent: Mutex<Vec<OutgoingMail>>,
}

impl MemoryMailSender {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Everything sent so far, in order.
    #[must_use]
    pub fn sent(&self) -> Vec<OutgoingMail> {
        self.sent
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl MailSender for MemoryMailSender {
    fn send<'a>(
        &'a self,
        mail: &'a OutgoingMail,
    ) -> Pin<Box<dyn Future<Output = Result<(), MailError>> + Send + 'a>> {
        Box::pin(async move {
            self.sent
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(mail.clone());
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{MailSender as _, MemoryMailSender, OutgoingMail, SmtpMailSender, build_message};

    fn mail() -> OutgoingMail {
        OutgoingMail {
            id: "0192f1c4-0000-7000-8000-000000000001".to_owned(),
            to: "aurel@example.test".to_owned(),
            from_name: Some("Festival des Lumières".to_owned()),
            reply_to: Some("benevoles@example.test".to_owned()),
            subject: "Vos créneaux".to_owned(),
            html: "<p>Bonjour Aurel</p>".to_owned(),
            text: "Bonjour Aurel".to_owned(),
        }
    }

    fn formatted(mail: &OutgoingMail) -> String {
        let from = "planner@evp.localhost".parse().expect("valid address");
        let message = build_message(&from, mail).expect("message builds");
        String::from_utf8(message.formatted()).expect("ASCII headers and encoded bodies")
    }

    #[test]
    fn headers_carry_the_display_name_reply_to_and_a_stable_message_id() {
        let raw = formatted(&mail());
        assert!(
            raw.contains("From: =?utf-8?b?"),
            "non-ASCII name is encoded:\n{raw}"
        );
        assert!(raw.contains("<planner@evp.localhost>"));
        assert!(raw.contains("To: aurel@example.test"));
        assert!(raw.contains("Reply-To: benevoles@example.test"));
        assert!(
            raw.contains("Message-ID: <0192f1c4-0000-7000-8000-000000000001@evp.localhost>"),
            "{raw}"
        );
    }

    #[test]
    fn body_is_alternative_with_text_before_html() {
        let raw = formatted(&mail());
        assert!(raw.contains("multipart/alternative"));
        let text = raw.find("text/plain").expect("text part");
        let html = raw.find("text/html").expect("html part");
        assert!(text < html, "plain text must come first");
    }

    #[test]
    fn reply_to_is_omitted_when_not_configured() {
        let raw = formatted(&OutgoingMail {
            reply_to: None,
            ..mail()
        });
        assert!(!raw.contains("Reply-To:"));
    }

    #[test]
    fn a_malformed_recipient_is_permanent() {
        let from = "planner@evp.localhost".parse().expect("valid address");
        let error = build_message(
            &from,
            &OutgoingMail {
                to: "not an address".to_owned(),
                ..mail()
            },
        )
        .expect_err("refused");
        assert!(error.is_permanent());
    }

    // The pooled transport spawns onto the runtime when dropped, so it can
    // only exist inside one — as it always does in the worker.
    #[tokio::test]
    async fn configuration_errors_do_not_echo_the_url() {
        let error = SmtpMailSender::from_url("smtp://user:hunter2@", "planner@evp.localhost")
            .err()
            .map(|error| error.to_string())
            .unwrap_or_default();
        assert!(!error.contains("hunter2"));
        assert!(SmtpMailSender::from_url("smtp://mailpit:1025", "nope").is_err());
        assert!(SmtpMailSender::from_url("smtp://mailpit:1025", "a@b.test").is_ok());
    }

    #[tokio::test]
    async fn debug_does_not_print_the_transport() {
        let sender = SmtpMailSender::from_url("smtp://user:hunter2@mailpit:1025", "a@b.test")
            .expect("valid");
        assert!(!format!("{sender:?}").contains("hunter2"));
    }

    #[tokio::test]
    async fn the_memory_sink_records_in_order() {
        let sink = MemoryMailSender::new();
        let first = mail();
        let second = OutgoingMail {
            id: "2".to_owned(),
            ..mail()
        };
        sink.send(&first).await.expect("sent");
        sink.send(&second).await.expect("sent");
        assert_eq!(sink.sent(), vec![first, second]);
    }
}
