// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The outbox consumer and the daily retention sweep.
//!
//! Mostly empty until the outbox exists. It runs in the API process behind
//! `EVP_RUN_WORKER`, so splitting it into its own container later is a compose
//! change rather than a rewrite ([docs/02 §1](../../../docs/02-architecture.md)).
//!
//! [`ovh`] is the one exception: the `SmsSender` trait and its OVH
//! implementation (ADR-0034), built ahead of the outbox that will eventually
//! call them so the HTTP contract and the GSM-7/signature logic have their
//! own tests now rather than arriving untested bundled into a larger change
//! later.

pub mod gsm7;
pub mod ovh;
