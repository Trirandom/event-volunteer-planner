// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * How much of the board's scroller the time track can actually show: the
 * scroller's width less the pinned gutter that sits over its left edge.
 *
 * `useAxis` fits its zoom floor to this, so zooming out stops where the track
 * meets the right edge instead of leaving a band of empty board beside it.
 * Measured from the two elements rather than computed from the gutter's
 * `13.5rem`: the rem follows the viewer's text size (docs/14 §2) and the
 * scroller follows the window, and a ResizeObserver hears about both.
 *
 * `null` until both elements exist — the board is behind a `v-if` on its
 * loading state — and wherever ResizeObserver does not (jsdom). The axis
 * reads `null` as "no floor", which is the board as it was.
 */
import {
  onBeforeUnmount,
  readonly,
  ref,
  watch,
  type DeepReadonly,
  type Ref,
} from 'vue';

export function useTrackWidth(
  scroller: Readonly<Ref<HTMLElement | null>>,
  gutter: Readonly<Ref<HTMLElement | null>>,
): DeepReadonly<Ref<number | null>> {
  const width = ref<number | null>(null);

  function measure(): void {
    const scrollerEl = scroller.value;
    const gutterEl = gutter.value;
    width.value =
      scrollerEl === null || gutterEl === null
        ? null
        : scrollerEl.clientWidth - gutterEl.offsetWidth;
  }

  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);

  watch(
    [scroller, gutter],
    ([scrollerEl, gutterEl], _previous, onCleanup) => {
      if (observer === null) {
        return;
      }
      measure();
      for (const element of [scrollerEl, gutterEl]) {
        if (element !== null) {
          observer.observe(element);
        }
      }
      onCleanup(() => {
        observer.disconnect();
      });
    },
    { immediate: true, flush: 'post' },
  );

  onBeforeUnmount(() => {
    observer?.disconnect();
  });

  return readonly(width);
}
