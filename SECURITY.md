# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/Trirandom/event-volunteer-planner/security/advisories/new)
(the repository's **Security** tab → *Report a vulnerability*). Include enough
detail to reproduce: the affected endpoint or page, the request, what you
expected and what happened.

Reports are most valuable in these areas:

- **Tenant isolation** — anything that lets one organisation read or write
  another's data (Row-Level Security, `org_id` handling, `SET LOCAL`).
- **Authentication and sessions** — sign-in, the session cookie, the bootstrap
  owner.
- **The public volunteer form** — `/api/v1/public/forms/{slug}`, its captcha
  and rate limits, and inline reconciliation into the volunteer pool.
- **Capability URLs**, once they exist (form token links, ICS feeds).

The threat model and the invariants the design relies on are in
[docs/12 — Security](docs/12-security.md).

## Supported versions

The project is pre-1.0 and has no released versions yet. Fixes land on the
default branch only.

## Deploying safely

- `docker/dev-secrets/` and the passwords in `.env.example` are **public
  development fixtures**. Never use them for a reachable deployment: production
  takes every key and password from files under `./secrets/` (see
  `compose.prod.yaml` and [docs/06](docs/06-local-development.md)).
- Remove `EVP_BOOTSTRAP_USERNAME` / `EVP_BOOTSTRAP_PASSWORD` once the first
  owner has signed in.
