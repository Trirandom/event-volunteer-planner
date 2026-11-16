// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The pointer wiring of a list drag. The geometry is `dropGap`'s and tested
 * there; this is what turns presses and moves into one drop, or none.
 *
 * jsdom lays nothing out, so each card's rectangle is stubbed: three 100 px
 * cards, 10 px apart, in a list 300 px wide. The page is not scrolled.
 */
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, useTemplateRef } from 'vue';

import { useListDrag } from './useListDrag';

interface Payload {
  readonly id: string;
  readonly fromToolbox: boolean;
}

function rect(top: number, bottom: number): DOMRect {
  return DOMRect.fromRect({ x: 0, y: top, width: 300, height: bottom - top });
}

function harness(drop: (payload: Payload, gap: number) => void) {
  const made: { api?: ReturnType<typeof useListDrag<Payload>> } = {};
  const Harness = defineComponent({
    setup() {
      const list = useTemplateRef<HTMLOListElement>('list');
      made.api = useListDrag<Payload>({
        list,
        needsColumn: (payload) => payload.fromToolbox,
        drop,
      });
      return () =>
        h('ol', { ref: 'list' }, [
          h('li', { 'data-top': 0 }),
          h('li', { 'data-top': 110 }),
          h('li', { 'data-top': 220 }),
        ]);
    },
  });
  const wrapper = mount(Harness, { attachTo: document.body });
  for (const li of wrapper.findAll('li')) {
    const top = Number(li.attributes('data-top'));
    vi.spyOn(li.element, 'getBoundingClientRect').mockReturnValue(
      rect(top, top + 100),
    );
  }
  vi.spyOn(wrapper.element, 'getBoundingClientRect').mockReturnValue(
    rect(0, 320),
  );
  const { api } = made;
  if (api === undefined) {
    throw new Error('the harness did not set up');
  }
  return { wrapper, api };
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    isPrimary: true,
    cancelable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('useListDrag', () => {
  it('drops a grabbed card into the gap the pointer is over on release', () => {
    const drop = vi.fn();
    const { api } = harness(drop);

    api.press(
      pointer('pointerdown', 20, 20),
      { id: 'q', fromToolbox: false },
      { immediate: true },
    );
    window.dispatchEvent(pointer('pointermove', 20, 200));
    expect(api.active.value?.gap).toBe(2);
    window.dispatchEvent(pointer('pointerup', 20, 200));

    expect(drop).toHaveBeenCalledWith({ id: 'q', fromToolbox: false }, 2);
    expect(api.active.value).toBeNull();
  });

  it('drops nothing when Escape cancels the drag', () => {
    const drop = vi.fn();
    const { api } = harness(drop);

    api.press(
      pointer('pointerdown', 20, 20),
      { id: 'q', fromToolbox: false },
      { immediate: true },
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(pointer('pointerup', 20, 200));

    expect(drop).not.toHaveBeenCalled();
  });

  it('treats a toolbox press that barely moves as a click, not a drag', () => {
    const drop = vi.fn();
    const { api } = harness(drop);

    api.press(
      pointer('pointerdown', 500, 50),
      { id: 'new', fromToolbox: true },
      { immediate: false },
    );
    window.dispatchEvent(pointer('pointermove', 502, 51));
    expect(api.active.value).toBeNull();
    window.dispatchEvent(pointer('pointerup', 502, 51));

    expect(drop).not.toHaveBeenCalled();
    expect(api.isDragClick()).toBe(false);
  });

  it('drops a toolbox entry only when let go over the list’s column', () => {
    const drop = vi.fn();
    const { api } = harness(drop);

    api.press(
      pointer('pointerdown', 500, 50),
      { id: 'new', fromToolbox: true },
      { immediate: false },
    );
    window.dispatchEvent(pointer('pointermove', 500, 120));
    expect(api.active.value?.gap).toBeNull();
    window.dispatchEvent(pointer('pointerup', 500, 120));
    expect(drop).not.toHaveBeenCalled();
    // The click that follows a drag must not also add the entry.
    expect(api.isDragClick()).toBe(true);

    api.press(
      pointer('pointerdown', 500, 50),
      { id: 'new', fromToolbox: true },
      { immediate: false },
    );
    window.dispatchEvent(pointer('pointermove', 150, 120));
    window.dispatchEvent(pointer('pointerup', 150, 120));
    expect(drop).toHaveBeenCalledWith({ id: 'new', fromToolbox: true }, 1);
  });
});
