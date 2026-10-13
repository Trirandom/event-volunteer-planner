// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The outbox consumer and the daily retention sweep.
//!
//! Mostly empty until the outbox exists. It runs in the API process behind
//! `EVP_RUN_WORKER`, so splitting it into its own container later is a compose
//! change rather than a rewrite ([docs/02 §1](../../../docs/02-architecture.md)).
//!
//! [`ovh`] and [`mail`] are the exceptions: the `SmsSender` and `MailSender`
//! traits with their OVH and SMTP implementations (ADR-0034, docs/02 §"Async
//! work"), built ahead of the outbox that will eventually call them so the
//! provider contracts have their own tests now rather than arriving untested
//! bundled into a larger change later.

pub mod gsm7;
pub mod mail;
pub mod ovh;
