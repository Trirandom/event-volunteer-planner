// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * When the builder's draft is sent (ADR-0048): once edits have paused, never
 * twice at once, not while it cannot be saved, and at once on `flush` when
 * the coordinator is leaving. Fake timers, so no test waits on a real clock.
 */
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import { AUTOSAVE_DELAY_MS, useAutosave } from './useAutosave';

function harness(options: { readonly saveable?: boolean } = {}) {
  const edits = ref(0);
  const saveable = ref(options.saveable ?? true);
  let release: (() => void) | null = null;
  const save = vi.fn(
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const made: { api?: ReturnType<typeof useAutosave> } = {};
  mount(
    defineComponent({
      setup() {
        made.api = useAutosave({
          trigger: () => edits.value,
          canSave: () => saveable.value,
          save,
        });
        return () => h('div');
      },
    }),
  );
  const { api } = made;
  if (api === undefined) {
    throw new Error('the harness did not set up');
  }
  async function edit(): Promise<void> {
    edits.value += 1;
    await nextTick();
  }
  async function finishSave(): Promise<void> {
    release?.();
    release = null;
    await vi.runOnlyPendingTimersAsync();
  }
  return { api, save, saveable, edit, finishSave };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutosave', () => {
  it('saves once edits have paused for the delay, not before', async () => {
    const { save, edit } = harness();

    await edit();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    await edit();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not save a draft that cannot be saved', async () => {
    const { save, edit } = harness({ saveable: false });

    await edit();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 3);

    expect(save).not.toHaveBeenCalled();
  });

  it('never sends two saves at once, and sends again for edits made meanwhile', async () => {
    const { save, edit, finishSave } = harness();

    await edit();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    await edit();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);

    await finishSave();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('does not retry by itself after a save that changed nothing more', async () => {
    const { save, edit, finishSave } = harness();

    await edit();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    await finishSave();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 5);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves at once on flush, without waiting for the delay', async () => {
    const { api, save, edit, finishSave } = harness();

    await edit();
    const flushed = api.flush();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    await finishSave();
    await flushed;

    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('says a save is waiting between an edit and its save', async () => {
    const { api, edit } = harness();

    expect(api.waiting.value).toBe(false);
    await edit();
    expect(api.waiting.value).toBe(true);
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    expect(api.waiting.value).toBe(false);
  });
});
