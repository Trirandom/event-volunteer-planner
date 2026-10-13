# Development key material — not secret, and never to be deployed

The two files beside this one are committed on purpose, so that a fresh clone
runs `docker compose up` and works with no setup step
([01 §4 S0b](../../docs/01-product-spec.md#setting-up)). They are fixtures, not
secrets: their values are in public version control, and anything signed or
encrypted with them is readable by anyone who has the repository.

| File | What it keys | Rotating it |
| --- | --- | --- |
| `session_key` | Session cookie signing | Signs every session out |
| `app_key` | Encryption of values that must stay *recoverable* — webhook signing secrets ([08 §3](../../docs/08-volunteer-intake.md)) | Requires `evp-cli rotate-app-key` first, or those values become unreadable |

Production supplies both as Compose secrets from `./secrets/`, which is
git-ignored — see the header of [`compose.prod.yaml`](../../compose.prod.yaml).
The two mechanisms are deliberately different paths (`/run/dev-secrets` versus
`/run/secrets`) so that a production deployment cannot silently fall back to
these: a missing secret is a refusal to boot, not a default.
