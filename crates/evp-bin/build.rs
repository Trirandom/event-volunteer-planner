// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Stamps the build's commit into the binary, so `GET /api/v1/meta` and both
//! frontends can tell a network user exactly which source they are running
//! (AGPL §13, CONTRIBUTING.md).
//!
//! `EVP_BUILD_COMMIT` takes precedence over `git describe` because the
//! production image is built from a context that does not contain `.git` —
//! cargo-chef copies manifests and sources, not history. A Docker build
//! therefore passes the commit in as a build argument, and a local `cargo
//! build` discovers it. Neither path can produce a *wrong* commit; the worst
//! case is `unknown`, which is honest.
//!
//! No `vergen`: the dependency would exist to wrap the eight lines below and
//! would still not solve the Docker case, which needs the build argument
//! regardless.
//!
//! No lint suppression here: `[workspace.lints]` does not reach build scripts,
//! so the workspace `print_stdout = "deny"` does not apply and the `println!`
//! calls below — which are how a build script speaks to cargo — need no
//! `#[expect]`. Adding one is an error, because an expectation that is never
//! fulfilled is itself a warning (docs/11 §1).

use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo::rerun-if-env-changed=EVP_BUILD_COMMIT");

    let git_head = Path::new("../../.git/HEAD");
    if git_head.exists() {
        println!("cargo::rerun-if-changed=../../.git/HEAD");
    }

    let commit = std::env::var("EVP_BUILD_COMMIT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(git_describe)
        .unwrap_or_else(|| "unknown".to_owned());

    println!("cargo::rustc-env=EVP_COMMIT={commit}");
}

fn git_describe() -> Option<String> {
    let output = Command::new("git")
        .args(["describe", "--always", "--dirty", "--tags"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let described = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!described.is_empty()).then_some(described)
}
