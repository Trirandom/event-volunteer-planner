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

# Frontend only: this stack's `web` and `caddy`, with the API borrowed from
# another stack on the host (the main checkout's on 8080 unless a port is
# given). No Rust is compiled and no database starts, so a worktree that only
# changes apps/ or packages/ is up in seconds. The borrowed API runs that
# stack's code against that stack's data: once this branch touches crates/ or
# migrations/, it is testing the wrong backend, so use `just up`.
#   just up-front          # API from http://localhost:8080
#   just up-front 8084     # API from the stack on 8084
up-front backend_port="8080":
    #!/bin/sh
    set -eu
    own=$(sed -n 's/^EVP_HTTP_PORT=//p' .env 2>/dev/null | tail -n 1)
    if [ "${own:-8080}" = "{{backend_port}}" ]; then
        echo "port {{backend_port}} is this stack's own Caddy; borrow another stack's" >&2
        exit 1
    fi
    if ! curl -fsS -o /dev/null "http://localhost:{{backend_port}}/api/v1/meta"; then
        echo "no API answers on :{{backend_port}}; start that stack first (just upd there)" >&2
        exit 1
    fi
    EVP_API_UPSTREAM="host.docker.internal:{{backend_port}}" {{compose}} up --build --no-deps web caddy

# Copy another stack's Rust build into this one: its cargo target and crate
# registry volumes. Every stack mounts the code at /app and the registry at the
# same path, so cargo's fingerprints still match: dependencies stay compiled
# and only the workspace crates, whose files are newer here, rebuild. Run it in
# a fresh worktree before its first `just up`; it replaces what this stack has
# built. Copied rather than shared, because a shared target would make
# concurrent builds queue on cargo's lock and branches overwrite each other's
# incremental state.
#   just seed-cache            # from the main checkout (project `evp`)
#   just seed-cache evp-foo    # from another worktree's project
seed-cache from="evp":
    #!/bin/sh
    set -eu
    # Git Bash rewrites anything shaped like a Unix path into a Windows one,
    # which turns the container-side paths below into nonsense.
    export MSYS_NO_PATHCONV=1
    name=$({{compose}} config | sed -n 's/^name: //p' | head -n 1)
    if [ "$name" = "{{from}}" ]; then
        echo "this stack is {{from}}; nothing to copy" >&2
        exit 1
    fi
    for v in evp-cargo-target evp-cargo-registry; do
        if ! docker volume inspect "{{from}}_$v" >/dev/null 2>&1; then
            echo "no volume {{from}}_$v; has that stack built?" >&2
            exit 1
        fi
    done
    if [ -n "$({{compose}} ps -q api migrate)" ]; then
        echo "this stack's api is running and writing to its target; just down first" >&2
        exit 1
    fi
    # Through `compose run`, so the destination volumes are created with this
    # project's labels, as `just up` would create them.
    {{compose}} run --rm --no-deps -T \
        -v "{{from}}_evp-cargo-target:/seed/target:ro" \
        -v "{{from}}_evp-cargo-registry:/seed/registry:ro" \
        --entrypoint sh api -c '
            set -eu
            find /app/target /usr/local/cargo/registry -mindepth 1 -maxdepth 1 -exec rm -rf {} +
            cp -a /seed/target/. /app/target/
            cp -a /seed/registry/. /usr/local/cargo/registry/
            du -sh /app/target /usr/local/cargo/registry'

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

# The SMTP sender against the dev stack's Mailpit: sends for real and reads it
# back through Mailpit's API (docs/13). Ignored by `just test` because it needs
# the mailpit service.
test-mail:
    {{compose}} run --rm -e EVP_TEST_SMTP_URL=smtp://mailpit:1025 -e EVP_TEST_MAILPIT_API=http://mailpit:8025 --entrypoint cargo api nextest run -p evp-worker --run-ignored only

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
