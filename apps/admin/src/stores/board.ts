// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The board's tool settings: how far it is zoomed in, and how long a slot is.
 *
 * Genuinely client-side state, which is why it is Pinia and not a query —
 * `main.ts` names "board zoom, selection, filters" as the split, and this is
 * the first of them to exist.
 *
 * The slot length is the interesting one. It is **not** stored anywhere and
 * must not be: ADR-0029 rejected a `shifts.source_pattern_id` provenance
 * column precisely because recording which division made a shift invites
 * "the pattern changed, update 240 shifts?" — the constraint alternative
 * arriving through a side door. So this is a setting on the *tool*, in the
 * same family as the zoom: it decides where the next cut falls and has no
 * opinion at all about the shifts already on the board. A coordinator who
 * drags one to end at 10:20 is having a normal Tuesday.
 *
 * It survives moving between the festival and its days, which is the point of
 * holding it here rather than in the view: setting "90" for Artiste and then
 * clicking through to Saturday should not silently put it back to 120.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

/** Two hours, "because that is what most missions run on" (docs/01 §S7b). */
const DEFAULT_CUT_MINUTES = 120;

/** `shifts_period_sane` refuses anything longer than a day, so a longer slot
 * is not a slot the database will accept. */
const MAX_CUT_MINUTES = 24 * 60;

/** ADR-0029's floor: the axis granularity is the GCD of an event's segment
 * durations, floored at 15 minutes. Nothing finer is offered here because
 * nothing finer can be declared against on the volunteer form. */
const MIN_CUT_MINUTES = 15;

const MIN_PIXELS_PER_HOUR = 12;
const MAX_PIXELS_PER_HOUR = 240;

function clampCut(minutes: number): number {
  if (!Number.isFinite(minutes)) {
    return DEFAULT_CUT_MINUTES;
  }
  return Math.min(
    Math.max(Math.round(minutes), MIN_CUT_MINUTES),
    MAX_CUT_MINUTES,
  );
}

export const useBoardStore = defineStore('board', () => {
  const pixelsPerHour = ref(40);
  const defaultCutMinutes = ref(DEFAULT_CUT_MINUTES);

  /**
   * Per-mission overrides, keyed by the mission key `plan/missions.ts` folds
   * on. Sparse on purpose: a mission with no entry follows the default, so
   * changing the default still moves every mission the coordinator has not
   * had an opinion about.
   */
  const cutOverrides = ref(new Map<string, number>());

  const pixelsPerMinute = computed(() => pixelsPerHour.value / 60);

  function cutMinutesFor(missionKey: string): number {
    return cutOverrides.value.get(missionKey) ?? defaultCutMinutes.value;
  }

  function setCutMinutes(missionKey: string, minutes: number): void {
    // A new Map rather than a mutation: `ref` tracks the reference, and an
    // in-place `set` on a plain Map would change the answer without telling
    // anything that reads it.
    const next = new Map(cutOverrides.value);
    next.set(missionKey, clampCut(minutes));
    cutOverrides.value = next;
  }

  function setDefaultCutMinutes(minutes: number): void {
    defaultCutMinutes.value = clampCut(minutes);
  }

  function setPixelsPerHour(value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    pixelsPerHour.value = Math.min(
      Math.max(Math.round(value), MIN_PIXELS_PER_HOUR),
      MAX_PIXELS_PER_HOUR,
    );
  }

  return {
    pixelsPerHour,
    pixelsPerMinute,
    defaultCutMinutes,
    cutOverrides,
    cutMinutesFor,
    setCutMinutes,
    setDefaultCutMinutes,
    setPixelsPerHour,
    MIN_CUT_MINUTES,
    MAX_CUT_MINUTES,
    MIN_PIXELS_PER_HOUR,
    MAX_PIXELS_PER_HOUR,
  };
});
