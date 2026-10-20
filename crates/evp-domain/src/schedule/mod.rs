// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! The schedule email, server side: a volunteer's lines, what changed since
//! they were last written to, and the message that says so (docs/04
//! §Publishing, docs/03 §3.7).
//!
//! The admin app previews the same message from `apps/admin/src/plan/emails.ts`.
//! The two are kept in step by `fixtures/schedule_render.json`, which both
//! test suites read: a preview that differs from what is sent is worse than no
//! preview.

pub mod lines;
pub mod locale;
pub mod plan;
pub mod render;
pub mod text;
