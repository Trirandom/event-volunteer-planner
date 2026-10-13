# Common paths, so nobody has to remember them (docs/06 §3).
#
# Everything that touches the database or the API runs *inside* Compose, so a
# contributor needs Docker and nothing else — no local Rust toolchain, no
# matching Postgres version, no "works on my machine" about which libpq is
# installed. The recipes that run on the host are the frontend ones, because
# Vite's watch loop is materially better outside a container.

# Recipes run under `sh`, on every platform. On Windows that means Git Bash,
# which is already needed to clone the repository — keeping PowerShell working
# too would mean maintaining two dialects of every recipe.

compose := "docker compose"

_default:
    @just --list --unsorted

# ── Running it ───────────────────────────────────────────────────────────────

# Start the whole stack with the dev override. http://localhost:8080
up:
    {{compose}} up --build

# Same, detached.
upd:
    {{compose}} up --build -d

# Stop everything, keep the data.
down:
    {{compose}} down

# Stop everything and destroy the data. This is the one that resets the roles.
nuke:
    {{compose}} down -v

# Follow the logs of one service, or all of them.
logs service="":
    {{compose}} logs -f {{service}}

# Start Dex as well, to exercise the OIDC path offline.
up-oidc:
    {{compose}} --profile oidc up --build

# ── Database ─────────────────────────────────────────────────────────────────

# Drop, recreate, migrate. The only way to re-run docker/db/init/, since those
# scripts execute once on an empty data directory and never again. It will seed
# too once `evp-cli seed` exists; restart the API afterwards so the bootstrap
# owner is recreated.
db-reset:
    {{compose}} down -v db
    {{compose}} up -d db
    {{compose}} run --rm migrate

# A psql session as the unprivileged API role — Row-Level Security applies, so
# what you see by hand is what the application sees. Reaching for the migrator
# is then a deliberate act rather than the path of least resistance.
#
# The password is expanded INSIDE the container, where the compose file already
# put it. Expanding it on the host would need the value in your own shell, and
# would put it in your shell history.
psql:
    {{compose}} exec db sh -c 'PGPASSWORD="$EVP_DB_API_PASSWORD" psql -U evp_api -d evp'

# A psql session as the migrator: owns every object, and is the only role that
# can change the schema. Spelled out separately for exactly that reason.
psql-admin:
    {{compose}} exec db sh -c 'PGPASSWORD="$EVP_DB_MIGRATOR_PASSWORD" psql -U evp_migrator -d evp'

# Apply pending migrations without restarting the API.
migrate:
    {{compose}} run --rm migrate

# Scaffold a migration:  just migrate-new add_shift_patterns
migrate-new name:
    {{compose}} run --rm --entrypoint sqlx migrate migrate add -r {{name}}

# The first owner on a fresh install (docs/07 M0). `evp-cli create-org` is still
# a stub; until it lands, set EVP_BOOTSTRAP_USERNAME/_PASSWORD in .env instead.
bootstrap email:
    {{compose}} exec api /app/evp-cli create-org --owner-email {{email}}

# A realistic 3-day event at the stated target scale: 500 volunteers, ~40 posts,
# ~2000 shifts — and deliberately not uniform, so any code assuming equal slot
# lengths fails here rather than at the event (docs/06 §3, ADR-0029). Not built
# yet: `evp-cli seed` is a stub. Use "Load the example festival" in the admin.
seed:
    {{compose}} exec api /app/evp-cli seed

# Reconcile an org's form submissions that are still `received` into the pool
# (ADR-0042): those stored before reconciliation existed, or whose inline
# reconcile failed. Idempotent. Runs as evp_api, so RLS applies.
#   just reconcile 01a0…
reconcile org_id:
    {{compose}} exec api cargo run -q --bin evp-cli -- reconcile --org-id {{org_id}}

# Replace the worked example ("Load the example festival/event") with one
# festival of a live org — events, missions, shifts — plus that org's
# volunteers, so only ever point it at an org of mock volunteers. The latest
# festival unless one is named. Rebuild the API afterwards; the file is
# embedded at compile time. See docker/db/dump-example.sql.
#   just dump-example zest-radio [soundclash-26]
dump-example org festival="":
    #!/bin/sh
    set -eu
    out=crates/evp-domain/src/example.json
    tmp="$out.tmp"
    trap 'rm -f "$tmp"' EXIT
    {{compose}} exec -T db psql -U postgres -d evp -X -q -v org={{quote(org)}} -v festival={{quote(festival)}} -f - \
        < docker/db/dump-example.sql | jq . > "$tmp"
    if [ "$(jq -r '.festival.name // empty' "$tmp")" = "" ]; then
        echo "no festival found for org '{{org}}'" >&2
        exit 1
    fi
    mv "$tmp" "$out"
    jq -r '"\(.festival.name): \(.events | length) events, \([.events[].locations | length] | add) missions, \([.events[].shifts | length] | add) shifts, \(.volunteers | length) volunteers -> '"$out"'"' "$out"

# ── Checks ───────────────────────────────────────────────────────────────────

# The local gate, in the order that fails fastest. CI runs the same checks
# (docs/06 §5); running this and `just test` first finds the failure sooner.
check: check-fmt check-rust check-sql check-web

check-fmt:
    {{compose}} run --rm --entrypoint cargo api fmt --all --check
    pnpm format:check

check-rust:
    {{compose}} run --rm --entrypoint cargo api clippy --workspace --all-targets -- -D warnings

# Fails if a query changed without regenerating the cached metadata (docs/06 §3).
# Queries are runtime `sqlx::query*` today, not macros, so this has nothing to
# check yet; it is kept so that the first `query!` is covered.
check-sql:
    {{compose}} run --rm --entrypoint cargo api sqlx prepare --check --workspace

check-web:
    pnpm lint
    pnpm typecheck

# ── Tests ────────────────────────────────────────────────────────────────────

test: test-rust test-web

test-rust:
    {{compose}} run --rm --entrypoint cargo api nextest run --workspace

test-web:
    pnpm test

# Browser journeys. Needs the stack up.
e2e:
    pnpm run e2e

# The whole suite again under a hostile timezone — +12:45 with its own DST
# rules. If storage is genuinely independent of the server's timezone, this
# passes identically (ADR-0019).
test-tz:
    {{compose}} run --rm -e TZ=Pacific/Chatham --entrypoint cargo api nextest run --workspace

# Mutation testing over the pure crates. Slow; run it before a PR, not on save.
mutants:
    {{compose}} run --rm --entrypoint cargo api mutants -p evp-domain -p evp-intake

# ── Contracts ────────────────────────────────────────────────────────────────

# Regenerate openapi.json and the TypeScript client (docs/11 §3, ADR-0030).
# Not built yet: evp-cli has no `openapi` subcommand and there is no
# `generate:api-client` script, so this recipe fails today.
openapi:
    {{compose}} run --rm --entrypoint cargo api run -p evp-cli -- openapi --out openapi.json
    pnpm run generate:api-client
