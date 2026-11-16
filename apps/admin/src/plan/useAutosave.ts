// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Sends the builder's draft once edits pause (ADR-0048).
 *
 * The draft is saved whole, so there is never a reason to have two saves in
 * flight: the second would carry the first's etag and be refused. An edit made
 * while a save is in flight is sent once that save returns. A save that comes
 * back with nothing new to send is not repeated. That is what keeps a failed
 * save from retrying in a loop: the next edit is what tries again.
 */
import { onBeforeUnmount, ref, watch } from 'vue';

/** Long enough that a word is typed before anything is sent; short enough
 * that switching tab right after an edit rarely has to wait on it. */
export const AUTOSAVE_DELAY_MS = 800;

export function useAutosave(options: {
  /** What changing means "an edit happened": the draft itself. */
  readonly trigger: () => unknown;
  /** Whether the draft is dirty and allowed to be sent right now. */
  readonly canSave: () => boolean;
  readonly save: () => Promise<void>;
}) {
  /** An edit is waiting for the delay to pass. */
  const waiting = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  /** Counts edits, so a save can tell whether any arrived while it was in
   * flight. */
  let edits = 0;

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    waiting.value = false;
  }

  function schedule(): void {
    cancel();
    if (!options.canSave()) {
      return;
    }
    waiting.value = true;
    timer = setTimeout(() => {
      timer = null;
      waiting.value = false;
      void run();
    }, AUTOSAVE_DELAY_MS);
  }

  async function run(): Promise<void> {
    if (inFlight !== null) {
      return inFlight;
    }
    if (!options.canSave()) {
      return undefined;
    }
    const before = edits;
    inFlight = options.save();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
    if (edits !== before) {
      schedule();
    }
    return undefined;
  }

  /** Sends whatever is waiting now, and resolves once nothing is in flight. */
  async function flush(): Promise<void> {
    cancel();
    if (inFlight !== null) {
      await inFlight;
    }
    await run();
  }

  watch(options.trigger, () => {
    edits += 1;
    schedule();
  });
  onBeforeUnmount(cancel);

  return { waiting, flush };
}
