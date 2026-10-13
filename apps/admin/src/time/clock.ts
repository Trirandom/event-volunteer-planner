// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The one place the coordinator application reads the wall clock.
 *
 * `docs/13 §8` forbids a test reading the clock, and `ADR-0019` forbids the
 * backend reading it inside business logic. The frontend equivalent is this:
 * "is this event in the past?" is a pure function of an instant that is passed
 * in (see `plan/agenda.ts`), and the single ambient read that question
 * ultimately needs lives here, behind a name a test can stub.
 *
 * Captured once per mount rather than ticking: a list that silently reorders
 * itself the moment an event ends would move a row out from under a pointer
 * already on its way to it (docs/14 §2). The next navigation re-reads it.
 */
import { Temporal } from '@evp/shared/time';

export function nowInstant(): Temporal.Instant {
  return Temporal.Now.instant();
}
