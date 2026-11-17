// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The missions page's editing state: what is unsaved, and what can be undone
 * (ADR-0049).
 *
 * Each `MissionCard` keeps its own draft and saves it itself. A dozen
 * independent drafts is still the right shape (`MissionCard.vue` says why),
 * but undo and "is everything saved?" are questions about the whole page. So
 * the view creates this, provides it, and each card registers with it: the
 * card says how its draft stands, and the page can put a draft back.
 *
 * Undo replays a step as a **new forward write**. A field goes back by setting
 * the card's draft, which the card then autosaves like any edit. A day goes
 * back by the same create or delete the checkbox sends. Both go through the
 * server's validation, and either can be refused. A refused step stays where it
 * was (`missionHistory.ts`'s peek/commit), and the refusal is announced.
 */
import {
  computed,
  inject,
  provide,
  ref,
  shallowReactive,
  shallowRef,
  type InjectionKey,
  type MaybeRefOrGetter,
} from 'vue';

import type { LocationWriteRejection } from '../api/locations';
import {
  refusedDaysText,
  useAddZoneDay,
  useRemoveZoneDay,
} from '../api/useMissionWrites';
import { useShiftsReader } from '../api/useShifts';
import { t } from '../i18n';
import { missionId, type DayRef, type ZoneGroup } from './missionCatalog';
import { canRemoveDay, dayCopy, dayRemoval } from './missionDays';
import type { MissionDraft } from './missionDraft';
import {
  afterRedo,
  afterUndo,
  emptyMissionHistory,
  nextRedo,
  nextUndo,
  recordStep,
  type MissionStep,
} from './missionHistory';

/** How one card's draft stands. `blocked` is a draft that will not be sent
 * until it is corrected: a problem in its fields, or a refused save. */
export type MissionSaveState = 'saved' | 'saving' | 'blocked';

export interface MissionEditor {
  /** Puts a draft back without recording it as a step (an undo, a redo). */
  readonly setDraft: (draft: MissionDraft) => void;
  /** Sends what is pending now, and resolves once nothing is in flight. */
  readonly flush: () => Promise<void>;
  readonly state: () => MissionSaveState;
}

export interface MissionEditing {
  /** Returns the unregister function, for `onBeforeUnmount`. */
  readonly register: (id: string, editor: MissionEditor) => () => void;
  readonly record: (step: MissionStep) => void;
}

const KEY: InjectionKey<MissionEditing> = Symbol('mission-editing');

/** `null` outside the missions page, where a card has nobody to report to. */
export function injectMissionEditing(): MissionEditing | null {
  return inject(KEY, null);
}

export function provideMissionEditing(options: {
  readonly orgId: MaybeRefOrGetter<string>;
  /** The page's zones, as `groupByZone` folds them now. */
  readonly groups: () => readonly ZoneGroup[];
}) {
  const editors = shallowReactive(new Map<string, MissionEditor>());
  const history = shallowRef(emptyMissionHistory());
  /** An undo or redo whose write is in flight. A second one waits its turn
   * rather than racing it to the same rows. */
  const busy = ref(false);
  /** What the last undo or redo did, or why it did not, for a live region. */
  const announcement = ref('');

  const addDay = useAddZoneDay(options.orgId);
  const removeDay = useRemoveZoneDay(options.orgId);
  const readShifts = useShiftsReader(options.orgId);

  const editing: MissionEditing = {
    register(id, editor) {
      editors.set(id, editor);
      return () => {
        if (editors.get(id) === editor) {
          editors.delete(id);
        }
      };
    },
    record(step) {
      history.value = recordStep(history.value, step);
    },
  };
  provide(KEY, editing);

  function rejected(day: DayRef, rejection: LocationWriteRejection): string {
    return refusedDaysText({ applied: 0, refusals: [{ ...day, rejection }] });
  }

  function groupOf(id: string): ZoneGroup | undefined {
    return options.groups().find((group) => missionId(group.zone) === id);
  }

  async function addTo(group: ZoneGroup, day: DayRef): Promise<string | null> {
    if (group.zone.placements.some((p) => p.eventId === day.eventId)) {
      return null;
    }
    const outcome = await addDay.mutateAsync({ day, copy: dayCopy(group) });
    return outcome.zoneCreated
      ? null
      : t('missions.days.notAdded', {
          name: group.zone.name,
          days: rejected(day, outcome.rejection),
        });
  }

  /** Only a day without shifts: anything else would delete work the step
   * being reversed did not create (ADR-0049). */
  async function removeFrom(
    group: ZoneGroup,
    day: DayRef,
  ): Promise<string | null> {
    const shifts = await readShifts(day.eventId);
    if (!shifts.ok) {
      return t('missions.days.checkFailed', { day: day.eventName });
    }
    const removal = dayRemoval(group, day.eventId, shifts.value);
    if (removal === null) {
      return null;
    }
    if (removal.shiftCount > 0) {
      return t('missions.history.dayHasShifts', {
        name: group.zone.name,
        day: day.eventName,
      });
    }
    if (!canRemoveDay(group.zone)) {
      return t('missions.days.lastDay');
    }
    const result = await removeDay.mutateAsync(removal.placement);
    return result.ok
      ? null
      : t('missions.days.notRemoved', {
          name: group.zone.name,
          days: rejected(day, result.rejection),
        });
  }

  /** Applies `step` in `direction`; the refusal's text, or `null` once done. */
  async function apply(
    step: MissionStep,
    direction: 'undo' | 'redo',
  ): Promise<string | null> {
    if (step.kind === 'edit') {
      const editor = editors.get(step.missionId);
      if (editor === undefined) {
        return t('missions.history.gone');
      }
      editor.setDraft(direction === 'undo' ? step.before : step.after);
      return null;
    }
    const group = groupOf(step.missionId);
    if (group === undefined) {
      return t('missions.history.gone');
    }
    const adding = step.added === (direction === 'redo');
    return adding ? addTo(group, step.day) : removeFrom(group, step.day);
  }

  async function run(direction: 'undo' | 'redo'): Promise<void> {
    const step =
      direction === 'undo' ? nextUndo(history.value) : nextRedo(history.value);
    if (step === null || busy.value) {
      return;
    }
    busy.value = true;
    try {
      const refusal = await apply(step, direction);
      if (refusal !== null) {
        announcement.value = refusal;
        return;
      }
      history.value =
        direction === 'undo'
          ? afterUndo(history.value)
          : afterRedo(history.value);
      announcement.value =
        direction === 'undo'
          ? t('missions.history.undone')
          : t('missions.history.redone');
    } finally {
      busy.value = false;
    }
  }

  const undoable = computed(
    () => !busy.value && nextUndo(history.value) !== null,
  );
  const redoable = computed(
    () => !busy.value && nextRedo(history.value) !== null,
  );

  /** The page's save state, most urgent first: one blocked card is what a
   * coordinator has to hear about, whatever the others are doing. */
  const saveState = computed(
    (): { readonly state: MissionSaveState; readonly blocked: number } => {
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
    undo: async () => run('undo'),
    redo: async () => run('redo'),
    undoable,
    redoable,
    saveState,
    announcement,
    flushAll,
  };
}
