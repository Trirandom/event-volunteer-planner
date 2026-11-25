// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Database-backed suites for `evp-db`, compiled as one test binary.
//!
//! Each file under `tests/` would otherwise be its own binary, each linking
//! sqlx, tokio and their debuginfo again. One binary links once. nextest still
//! runs every test in its own process, so nothing is shared between tests that
//! was not shared before.
//!
//! A new suite is a file in this directory plus a `mod` line below; fixtures
//! every suite shares go in `support.rs`.

mod support;

mod assignments;
mod availability;
mod backoffice;
mod catalog;
mod forms;
mod intake;
mod locations;
mod patterns;
mod posts;
mod public_forms;
mod schedule;
mod sms_settings;
mod submissions;
mod transactions;
