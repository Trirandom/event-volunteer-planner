// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Route-level suites for `evp-api`, compiled as one test binary.
//!
//! Each file under `tests/` would otherwise be its own binary, each statically
//! linking the router, sqlx, tokio and their debuginfo (~175 MB apiece). One
//! binary links once. nextest still runs every test in its own process, so
//! nothing is shared between tests that was not shared before.
//!
//! A new suite is a file in this directory plus a `mod` line below.

mod support;

mod assignments;
mod backoffice;
mod events;
mod festivals;
mod forms;
mod generate;
mod locations;
mod participations;
mod posts;
mod public_form;
mod publish_test;
mod route_role_matrix;
mod shift_patterns;
mod shifts;
mod sms_settings;
mod submissions;
