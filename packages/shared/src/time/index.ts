// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The single place `Temporal` enters the frontend.
 *
 * Importing it from here rather than from `temporal-polyfill` directly means
 * the day `Temporal` reaches Baseline Widely Available, dropping the polyfill
 * is an edit to this file and a dependency removal — not a search across two
 * applications (docs/16 §4).
 */
import type { Temporal as TemporalNamespace } from 'temporal-polyfill';

export { Temporal, Intl as TemporalIntl } from 'temporal-polyfill';

/**
 * `now()` is injected, never read ambiently, so a test can control it and does
 * not fail on a DST Sunday six months from now (docs/13 §8).
 */
export interface Clock {
  readonly instant: () => TemporalNamespace.Instant;
}
