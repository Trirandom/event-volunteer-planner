// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Dragging something into a gap of a vertical list: a card already in it, or
 * a new one out of the toolbox beside it.
 *
 * Pointer Events, not the HTML drag-and-drop API, for the reason the shift
 * board gives (`PlanShiftsView.vue`): the drop target is a computed gap, not
 * an element, and the HTML API does not fire on touch at all. It is the
 * pointer path only. Every move it makes has a keyboard and click
 * equivalent on the page (WCAG 2.2 2.5.7, ADR-0017): the card's move buttons
 * and shortcuts, and a click on a toolbox entry, which appends.
 *
 * The cards are measured once, when the drag starts, in document coordinates
 * — so a wheel scroll mid-drag does not throw the gaps off, and the gap fed to
 * `placeQuestion` counts the list as it was before anything moved, which is
 * how that function counts it.
 */
import { computed, onBeforeUnmount, shallowRef, type Ref } from 'vue';

import { dropGap } from './dropGap';

/** How far a press on a toolbox entry has to travel before it is a drag and
 * not a click. A card's grip has no click of its own, so it starts at once. */
const CLICK_SLOP_PX = 4;

interface Rect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface ListDrag<P> {
  readonly payload: P;
  /** The gap the pointer is over, or `null` when it is outside the list and
   * letting go would drop nothing. */
  readonly gap: number | null;
  /** Viewport coordinates, for the ghost that follows the pointer. */
  readonly x: number;
  readonly y: number;
}

export function useListDrag<P>(options: {
  readonly list: Readonly<Ref<HTMLElement | null>>;
  /** Whether the pointer must be over the list's own column for a gap to
   * count. A card being reordered is always somewhere in its list; a toolbox
   * entry let go over the toolbox is a drag that was abandoned. */
  readonly needsColumn: (payload: P) => boolean;
  readonly drop: (payload: P, gap: number) => void;
}) {
  const active = shallowRef<ListDrag<P> | null>(null);

  let pending: {
    readonly payload: P;
    readonly x: number;
    readonly y: number;
    readonly slop: number;
  } | null = null;
  let cards: Rect[] = [];
  let column: Rect | null = null;
  let swallowClick = false;

  function documentRect(element: Element): Rect {
    const box = element.getBoundingClientRect();
    return {
      top: box.top + window.scrollY,
      bottom: box.bottom + window.scrollY,
      left: box.left + window.scrollX,
      right: box.right + window.scrollX,
    };
  }

  function measure(): void {
    const list = options.list.value;
    cards = list === null ? [] : [...list.children].map(documentRect);
    column = list === null ? null : documentRect(list);
  }

  function gapAt(payload: P, x: number, y: number): number | null {
    const docX = x + window.scrollX;
    const docY = y + window.scrollY;
    if (options.needsColumn(payload)) {
      // A generous band above and below, so a list of two short cards is
      // not a target the size of two short cards.
      const band = 48;
      if (
        column === null ||
        docX < column.left ||
        docX > column.right ||
        docY < column.top - band ||
        docY > column.bottom + band
      ) {
        return null;
      }
    }
    return dropGap(cards, docY);
  }

  function begin(payload: P, x: number, y: number): void {
    measure();
    active.value = { payload, gap: gapAt(payload, x, y), x, y };
  }

  function onMove(event: PointerEvent): void {
    const current = active.value;
    if (current === null) {
      if (
        pending === null ||
        Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <
          pending.slop
      ) {
        return;
      }
      begin(pending.payload, event.clientX, event.clientY);
      return;
    }
    active.value = {
      payload: current.payload,
      gap: gapAt(current.payload, event.clientX, event.clientY),
      x: event.clientX,
      y: event.clientY,
    };
  }

  function onUp(): void {
    const current = active.value;
    finish();
    if (current === null) {
      return;
    }
    // A drag that ended over the entry it started on would otherwise also be
    // that entry's click, and add the question a second time at the end.
    swallowClick = true;
    window.setTimeout(() => {
      swallowClick = false;
    }, 0);
    if (current.gap !== null) {
      options.drop(current.payload, current.gap);
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && active.value !== null) {
      event.preventDefault();
      finish();
    }
  }

  function listen(on: boolean): void {
    if (on) {
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', finish);
      window.addEventListener('keydown', onKey);
      return;
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', finish);
    window.removeEventListener('keydown', onKey);
  }

  function finish(): void {
    pending = null;
    active.value = null;
    listen(false);
  }

  /** A press that may become a drag. `immediate` for a grip, which has no
   * click to be told apart from. */
  function press(
    event: PointerEvent,
    payload: P,
    { immediate }: { readonly immediate: boolean },
  ): void {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    if (immediate) {
      // Otherwise the press starts a text selection across every card the
      // pointer then crosses.
      event.preventDefault();
    }
    finish();
    pending = {
      payload,
      x: event.clientX,
      y: event.clientY,
      slop: immediate ? 0 : CLICK_SLOP_PX,
    };
    listen(true);
    if (immediate) {
      begin(payload, event.clientX, event.clientY);
    }
  }

  /** `true` when the click being handled is the tail of a drag. */
  function isDragClick(): boolean {
    return swallowClick;
  }

  onBeforeUnmount(finish);

  return { active: computed(() => active.value), press, isDragClick };
}
