// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The details page's editing state: what is unsaved, and what can be undone
 * (ADR-0051).
 *
 * The missions page's arrangement (`useMissionEditing.ts`): each `EventCard`
 * keeps and autosaves its own draft, and registers with the page so that
 * "is everything saved?" and Ctrl+Z, which are questions about the whole page,
 * have somebody to ask. An undo sets a card's draft back, and the card sends
 * it like any edit, so the write is a fresh `PATCH` asserting the row's current
 * version. Nothing is restored behind the server's back.
 */
import {
  computed,
  inject,
  provide,
  ref,
  shallowReactive,
  shallowRef,
  type InjectionKey,
} from 'vue';

import { t } from '../i18n';
import type { EventDraft } from './eventDraft';
import {
  afterRedo,
  afterUndo,
  emptyEventHistory,
  nextRedo,
  nextUndo,
  recordStep,
  type EventStep,
} from './eventHistory';

/** How one card's draft stands. `blocked` is a draft that will not be sent
 * until it is corrected: a problem in its fields, or a refused save. */
export type EventSaveState = 'saved' | 'saving' | 'blocked';

export interface EventEditor {
  /** Puts a draft back without recording it as a step (an undo, a redo). */
  readonly setDraft: (draft: EventDraft) => void;
  /** Sends what is pending now, and resolves once nothing is in flight. */
  readonly flush: () => Promise<void>;
  readonly state: () => EventSaveState;
}

export interface EventEditing {
  /** Returns the unregister function, for `onBeforeUnmount`. */
  readonly register: (eventId: string, editor: EventEditor) => () => void;
  readonly record: (step: EventStep) => void;
}

const KEY: InjectionKey<EventEditing> = Symbol('event-editing');

/** `null` outside the details page, where a card has nobody to report to. */
export function injectEventEditing(): EventEditing | null {
  return inject(KEY, null);
}

export function provideEventEditing() {
  const editors = shallowReactive(new Map<string, EventEditor>());
  const history = shallowRef(emptyEventHistory());
  /** What the last undo or redo did, or why it did not, for a live region. */
  const announcement = ref('');

  const editing: EventEditing = {
    register(eventId, editor) {
      editors.set(eventId, editor);
      return () => {
        if (editors.get(eventId) === editor) {
          editors.delete(eventId);
        }
      };
    },
    record(step) {
      history.value = recordStep(history.value, step);
    },
  };
  provide(KEY, editing);

  function run(direction: 'undo' | 'redo'): void {
    const step =
      direction === 'undo' ? nextUndo(history.value) : nextRedo(history.value);
    if (step === null) {
      return;
    }
    // Gone: deleted here, or narrowed out of the page by the day strip. The
    // step stays, so it applies again once the event is back on screen.
    const editor = editors.get(step.eventId);
    if (editor === undefined) {
      announcement.value = t('events.history.gone');
      return;
    }
    editor.setDraft(direction === 'undo' ? step.before : step.after);
    history.value =
      direction === 'undo'
        ? afterUndo(history.value)
        : afterRedo(history.value);
    announcement.value =
      direction === 'undo'
        ? t('events.history.undone')
        : t('events.history.redone');
  }

  const undoable = computed(() => nextUndo(history.value) !== null);
  const redoable = computed(() => nextRedo(history.value) !== null);

  /** The page's save state, most urgent first: one blocked card is what a
   * coordinator has to hear about, whatever the others are doing. */
  const saveState = computed(
    (): { readonly state: EventSaveState; readonly blocked: number } => {
      const states = [...editors.values()].map((editor) => editor.state());
      const blocked = states.filter((state) => state === 'blocked').length;
      if (blocked > 0) {
        return { state: 'blocked', blocked };
      }
      return {
        state: states.includes('saving') ? 'saving' : 'saved',
        blocked: 0,
      };
    },
  );

  async function flushAll(): Promise<void> {
    await Promise.all(
      [...editors.values()].map(async (editor) => editor.flush()),
    );
  }

  return {
    undo: () => {
      run('undo');
    },
    redo: () => {
      run('redo');
    },
    undoable,
    redoable,
    saveState,
    announcement,
    flushAll,
  };
}
