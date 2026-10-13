// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { expect, test } from '@playwright/test';

/**
 * `GET /api/v1/meta` reached through Caddy, the same origin the browser
 * uses — not a request straight to the `api` container.
 *
 * This is a regression test for a broken `docker compose up`: the `migrate`
 * service's dev container was missing the repository bind mount (only
 * `./migrations` was mounted), so `cargo run` had no `Cargo.toml` and exited
 * before applying anything. `api` depends on `migrate` completing
 * successfully and never started, so every request here — this one included
 * — got a connection error rather than a 4xx/5xx. Fixed in
 * compose.override.yaml by mounting the whole repository (and the shared
 * cargo volumes) for `migrate`, matching `api`.
 */
test('the api answers /api/v1/meta with the running build identity', async ({
  request,
}) => {
  const response = await request.get('/api/v1/meta');

  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body).toMatchObject({
    version: expect.any(String),
    commit: expect.any(String),
    source_url: expect.stringMatching(/^https?:\/\//),
  });
});

test('an unknown api route answers 404, not the frontend shell', async ({
  request,
}) => {
  const response = await request.get('/api/v1/does-not-exist');

  expect(response.status()).toBe(404);
});
