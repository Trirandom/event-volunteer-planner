# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Tristan Grunert and contributors
#
# Production image for the `api` service, and for the `migrate` init job.
#
#   docker build -f docker/api/Dockerfile --target runtime .
#   docker build -f docker/api/Dockerfile --target migrate .
#
# Build from the repository root: the build context is the workspace, because
# cargo-chef needs every member manifest to compute the dependency recipe.
#
# Bases are pinned by digest, not tag (docs/12 §8). The digests below were read
# from the registry on 2026-09-11; `rust:1-bookworm` resolved to 1.98.1, which
# is the version rust-toolchain.toml pins, so the toolchain is not re-downloaded
# at build time.

# syntax=docker/dockerfile:1

ARG RUST_IMAGE=rust:1.98.1-bookworm@sha256:9a73a5088750b4c95158ab26629c854c3d6fc4b173cb7bc8079ad252d8ed7bfa
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

# ---------------------------------------------------------------------------
# Toolchain, shared by the planner and the builder so cargo-chef is installed
# exactly once.
# ---------------------------------------------------------------------------
FROM ${RUST_IMAGE} AS chef
WORKDIR /app
RUN cargo install cargo-chef --locked --version 0.1.78

# ---------------------------------------------------------------------------
# Compute the dependency recipe. This stage's output changes only when a
# manifest changes, which is what makes the expensive stage below cacheable.
# ---------------------------------------------------------------------------
FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# ---------------------------------------------------------------------------
# Build. Dependencies first, from the recipe alone, so editing a handler does
# not rebuild sqlx.
# ---------------------------------------------------------------------------
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --locked --recipe-path recipe.json

COPY . .

# The context has no .git — cargo-chef copies sources, not history — so the
# commit arrives as a build argument and build.rs prefers it. Without it the
# binary reports `unknown`, which is honest but useless for AGPL §13, so a
# release build must always pass it.
ARG EVP_BUILD_COMMIT=unknown
ENV EVP_BUILD_COMMIT=${EVP_BUILD_COMMIT}

# Compile-time SQL verification would read a committed .sqlx cache rather than
# a live database, with `cargo sqlx prepare --check` in `just check` keeping it
# honest (docs/06 §3). No query uses the `query!` macros yet, so there is no
# cache to read; this keeps the first one from silently reaching for a
# database at build time.
ENV SQLX_OFFLINE=true

RUN cargo build --release --locked --bin evp --bin evp-cli

# ---------------------------------------------------------------------------
# sqlx-cli, for the migrate image only. Separate stage so the API image never
# carries it, and so it is not rebuilt when application code changes.
# ---------------------------------------------------------------------------
FROM ${RUST_IMAGE} AS sqlx-cli
RUN cargo install sqlx-cli --locked --version 0.9.0 \
      --no-default-features --features postgres,rustls,sqlx-toml

# ---------------------------------------------------------------------------
# Runtime: the `api` service. No shell, no package manager, non-root.
#
# distroless/cc supplies ca-certificates (rustls native roots) and tzdata
# (/usr/share/zoneinfo, which jiff reads). The process asserts the tzdb is
# resolvable at startup rather than discovering it is not at the first event.
# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app
COPY --from=builder /app/target/release/evp     /app/evp
COPY --from=builder /app/target/release/evp-cli /app/evp-cli
USER nonroot:nonroot
EXPOSE 3000
ENTRYPOINT ["/app/evp"]

# ---------------------------------------------------------------------------
# The `migrate` init job. Runs as `evp_migrator`, applies what is outstanding,
# exits 0. `api` waits on service_completed_successfully.
#
# The default command is `evp migrate`, not `sqlx migrate run`, for one reason:
# `EVP_MIGRATION_DATABASE_URL_FILE` (docs/06 §2). sqlx-cli reads DATABASE_URL
# from the environment and knows nothing about the _FILE convention, and this
# image has no shell to translate one into the other. Putting the migration
# through the binary that already implements that convention keeps exactly one
# implementation of "exactly one of the two forms may be set", which is a rule
# that must not drift.
#
# `sqlx` is still on PATH, so `docker compose run --rm --entrypoint sqlx migrate
# migrate add -r <name>` scaffolds a migration.
# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS migrate
WORKDIR /app
COPY --from=builder  /app/target/release/evp   /app/evp
COPY --from=sqlx-cli /usr/local/cargo/bin/sqlx /usr/local/bin/sqlx
COPY migrations /app/migrations
USER nonroot:nonroot
ENTRYPOINT ["/app/evp"]
CMD ["migrate"]
