// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { solve, type CaptchaChallenge } from './solve';

/** A challenge built the way `evp_domain::captcha` builds one. */
async function challengeFor(
  salt: string,
  number: number,
  maxnumber: number,
): Promise<CaptchaChallenge> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(salt + String(number)),
  );
  const challenge = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { algorithm: 'SHA-256', challenge, salt, maxnumber, signature: 'sig' };
}

describe('the proof-of-work solver', () => {
  it('finds the number, across batch boundaries, and echoes the challenge', async () => {
    const challenge = await challengeFor('abc?expires=1', 1_234, 2_000);
    expect(await solve(challenge)).toEqual({
      challenge: challenge.challenge,
      salt: 'abc?expires=1',
      number: 1_234,
      signature: 'sig',
    });
  });

  it('finds a number at either end of the range', async () => {
    expect((await solve(await challengeFor('s', 0, 10)))?.number).toBe(0);
    expect((await solve(await challengeFor('s', 10, 10)))?.number).toBe(10);
  });

  it('gives up rather than search for ever', async () => {
    const outOfRange = await challengeFor('s', 50, 10);
    expect(await solve(outOfRange)).toBeNull();
    const unknown = { ...(await challengeFor('s', 1, 10)), algorithm: 'MD5' };
    expect(await solve(unknown)).toBeNull();
  });

  it('stops when the form it was for is gone', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await solve(await challengeFor('s', 1, 10), controller.signal),
    ).toBeNull();
  });
});
