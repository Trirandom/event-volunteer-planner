// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Administrative tasks that are not requests.
//!
//! The subcommands are declared before they are implemented on purpose: the
//! justfile and the documentation already name them
//! ([docs/06 §3](../../../docs/06-local-development.md)), and a CLI that
//! answers "unknown subcommand" is indistinguishable from a broken image,
//! whereas one that answers "not implemented until M1" is not.
//!
//! Migrations are **not** here. They are `evp migrate` on the main binary,
//! because the migrate step runs with a different database role and a
//! different lifetime from everything in this file (docs/06 §1).

use anyhow::{Context as _, bail};
use clap::{Parser, Subcommand};
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(name = "evp-cli", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Create the first organisation and its owner. Invitations need an
    /// existing owner, so without this a fresh deployment cannot be started
    /// at all (docs/07, M0).
    CreateOrg {
        /// Address the owner will receive their magic link at.
        #[arg(long)]
        owner_email: String,
        /// Organisation slug.
        #[arg(long)]
        slug: Option<String>,
    },
    /// Load a realistic three-day event: 40 posts, 500 volunteers, ~2000
    /// shifts, and at least one post on a non-uniform shift pattern
    /// (ADR-0029).
    Seed,
    /// Re-encrypt every recoverable secret under a new `EVP_SECRET_KEY_FILE`.
    RotateAppKey,
    /// Reconcile the organisation's form submissions that are still
    /// `received` into the pool (ADR-0042): those stored before reconciliation
    /// existed, and any whose inline reconcile failed. Safe to run again.
    Reconcile {
        /// The organisation whose submissions to reconcile.
        #[arg(long)]
        org_id: Uuid,
        /// The application role's URL — never the migrator's, which owns the
        /// tables and so would be the one connection RLS does not narrow
        /// unless forced.
        #[arg(long, env = "EVP_DATABASE_URL", hide_env_values = true)]
        database_url: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::CreateOrg { .. } => bail!("`create-org` lands with M0's tenant tables"),
        Command::Seed => bail!("`seed` lands with M2's events and shifts"),
        Command::RotateAppKey => bail!("`rotate-app-key` lands with M1's webhook secrets"),
        Command::Reconcile {
            org_id,
            database_url,
        } => reconcile(org_id, &database_url).await,
    }
}

#[expect(
    clippy::print_stdout,
    reason = "the counts are this command's output, read by whoever ran it"
)]
async fn reconcile(org_id: Uuid, database_url: &str) -> anyhow::Result<()> {
    let pool = evp_db::connect(database_url)
        .await
        .context("connecting to the database")?;
    let done = evp_db::intake::backfill(&pool, org_id)
        .await
        .context("reconciling")?;
    println!(
        "applied {}, held for review {}, skipped {}, failed {}",
        done.applied, done.needs_review, done.skipped, done.failed
    );
    if done.failed > 0 {
        bail!(
            "{} submission(s) could not be reconciled; see the log",
            done.failed
        );
    }
    Ok(())
}
