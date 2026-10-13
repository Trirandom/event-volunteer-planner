// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Source connectors, the field-mapping engine and reconciliation.
//!
//! Pure over stored payloads, with no database: everything here takes what a
//! submission stored and what the pool already holds, and returns what should
//! happen. `evp_db::intake` does the reading and the writing around it. That
//! split is what keeps replay a re-run of the same function over the same
//! payload, and mutation testing over this crate affordable (docs/13 §9).
//!
//! * [`internal_form`] maps a first-party form submission onto the volunteer
//!   columns its questions target (docs/08 §9: the mapping is the questions'
//!   own `target_path`).
//! * [`reconcile`] is the identity ladder of docs/08 §6, from step 2 on —
//!   token links (step 0) are not built, and a first-party submission has no
//!   provider id to replay (step 1).
//!
//! The foreign-source connectors and their column mappings are still to come
//! (docs/07, M1).

pub mod internal_form;
pub mod reconcile;
