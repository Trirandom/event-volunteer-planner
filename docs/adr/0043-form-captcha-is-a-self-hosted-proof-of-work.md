# ADR-0043: The form's captcha is a self-hosted proof of work, always on

**Status:** Accepted · **Date:** 2026-10-08
**Amends:** docs/09 §5 ("Optional captcha: Turnstile or hCaptcha, off by
default, per-organisation config"), docs/07 M5 (the same item), and docs/04
§"Public and unauthenticated" (`captcha` on the form and the submission).

## Context

[ADR-0042](0042-public-submissions-reconciled-inline.md) lets a public
submission create a volunteer without a coordinator. That makes the anti-abuse
measures on the public route the only thing keeping spam out of the pool. The
existing measures are a rate limit, a honeypot and a timing floor. All three
stop a careless script, and none of them costs a deliberate one anything per
submission.

docs/09 planned an optional third-party captcha (Turnstile or hCaptcha) as
per-organisation configuration. Both load a script from another company onto
the volunteer form, which then needs mentioning in the privacy notice. Both
also need keys from an account the deployment has to open. The
`forms.captcha` column for that choice exists, but nothing reads it.

## Decision

**Every public submission carries a solved proof of work. The challenge is
served with the form, and the server signs and verifies it. There are no
third parties and no per-organisation setting.**

- **What the volunteer's browser does.** `GET /public/forms/{slug}` includes
  `captcha: {algorithm, challenge, salt, maxnumber, signature}` (ALTCHA's
  shape). `challenge = sha256(salt ‖ n)` for a secret `n ≤ maxnumber`. The
  bundle counts up to find `n` with `crypto.subtle`, in the background, from
  the moment the form renders. It sends `captcha: {challenge, salt, number,
  signature}` with the submission. Nobody sees or clicks anything.
- **What the server checks.** The signature is `HMAC-SHA256` under a key
  derived from `EVP_SECRET_KEY_FILE` (no new secret to provision), compared
  in constant time. The salt carries its own expiry (6 hours, judged by
  PostgreSQL's clock), and the expiry is inside what is hashed. The number
  must solve the challenge.
- **One solution, one submission.** A solution is spent when its submission
  is stored, and a spent one is refused. A submission refused for its
  answers does not spend it, so a volunteer who fixes a field keeps the work
  already done. The spent set lives in memory: one API replica, bounded by
  the rate limit. A second replica moves it to a table.
- **Refusal.** `422` with type `…/errors/captcha-failed`, the same for
  missing, forged, wrong, expired and spent. Which check failed goes to the
  log, not the response. The bundle then fetches a fresh challenge and sends
  again once without telling the volunteer. Only if that also fails does it
  show a message.
- **Difficulty.** `maxnumber = 100 000`, about a second of hashing on a phone,
  spent while the volunteer is still reading. Tests run at 50.
- **Order.** Honeypot (silent `202`), then the captcha, then the version
  check, then validation, then the timing floor.

## Alternatives considered

**Turnstile or hCaptcha, as docs/09 planned.** Rejected for now. Each puts a
third-party script and its cookies on a form filled in by members of the
public, and makes every deployment open an account. They detect bots better,
so they remain an option if proof of work proves too weak.

**A puzzle the volunteer solves.** Rejected. It is an accessibility barrier
(docs/14) on the one page every volunteer must get through.

**Per-organisation on/off, as the `forms.captcha` column allows.** Rejected:
with ADR-0042 in place, a form without it is the weakest point of every
organisation's pool. The column stays unused, ready for a third-party option
if one is ever added.

**A Web Worker or WASM solver.** Rejected. The production CSP allows neither
blob/inline workers nor `wasm-unsafe-eval`, and `crypto.subtle` already runs
off the main thread.

## Consequences

- Each scripted submission now costs CPU time. That limits volume; it does
  not stop someone determined.
- `crypto.subtle` exists only in a secure context. In production that is
  HTTPS. In development it is `localhost`, but **not** a LAN address such as
  `http://192.168…` (testing on a phone). There the solver has nothing to
  hash with, and the form is refused with the captcha message.
- The development demo (`/f/demo`) has no challenge and sends none. It never
  reached the server anyway.
