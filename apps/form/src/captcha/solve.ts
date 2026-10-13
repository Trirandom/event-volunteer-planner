// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The form's invisible captcha, client half (ADR-0043): find the number the
 * server hashed into its challenge, by counting up, while the volunteer is
 * still reading the first question.
 *
 * `crypto.subtle` rather than a hashing library: it is in every browser this
 * bundle targets, costs nothing to ship (docs/01 §5's load budget), and runs
 * off the main thread, so the page never stutters while it works. Hashes go
 * out in batches so the search is not one promise per number. No worker, no
 * WASM: the production CSP allows neither inline nor blob workers, and the
 * search is small enough not to need one.
 *
 * `crypto.subtle` exists only in a secure context — HTTPS, or localhost. On a
 * plain-HTTP LAN address there is nothing to solve with, so the result is
 * `null`, the submission goes without, and the server's refusal says so.
 */

/** The challenge as the form is served with it (ALTCHA's shape). */
export interface CaptchaChallenge {
  readonly algorithm: string;
  readonly challenge: string;
  readonly salt: string;
  readonly maxnumber: number;
  readonly signature: string;
}

/** What the submission carries back. */
export interface CaptchaSolution {
  readonly challenge: string;
  readonly salt: string;
  readonly number: number;
  readonly signature: string;
}

/** Hashes in flight at once: enough to keep `subtle` busy, few enough that an
 * aborted search stops promptly. */
const BATCH = 500;

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * `crypto.subtle`, which the DOM types declare always present — and which a
 * page served over plain HTTP from anything but localhost does not have.
 * Read reflectively so the check is not optimised away by the type system.
 */
function subtleCrypto(): SubtleCrypto | null {
  const crypto: unknown = Reflect.get(globalThis, 'crypto');
  const subtle: unknown =
    typeof crypto === 'object' && crypto !== null
      ? Reflect.get(crypto, 'subtle')
      : undefined;
  return typeof subtle === 'object' && subtle !== null
    ? globalThis.crypto.subtle
    : null;
}

/**
 * Searches `0..=maxnumber` for the number whose `sha256(salt + number)` is
 * the challenge. `null` when there is nothing to search with, the algorithm
 * is not one this solver knows, the search was aborted, or — a server bug —
 * the number is not in range.
 */
export async function solve(
  challenge: CaptchaChallenge,
  signal?: AbortSignal,
): Promise<CaptchaSolution | null> {
  const subtle = subtleCrypto();
  if (subtle === null || challenge.algorithm !== 'SHA-256') {
    return null;
  }
  for (let start = 0; start <= challenge.maxnumber; start += BATCH) {
    if (signal?.aborted === true) {
      return null;
    }
    const end = Math.min(start + BATCH - 1, challenge.maxnumber);
    const numbers = Array.from(
      { length: end - start + 1 },
      (_, i) => start + i,
    );
    const digests = await Promise.all(
      numbers.map(async (number) =>
        subtle.digest(
          'SHA-256',
          encoder.encode(challenge.salt + String(number)),
        ),
      ),
    );
    const found = digests.findIndex(
      (digest) => hex(digest) === challenge.challenge,
    );
    const number = numbers[found];
    if (number !== undefined) {
      return {
        challenge: challenge.challenge,
        salt: challenge.salt,
        number,
        signature: challenge.signature,
      };
    }
  }
  return null;
}
