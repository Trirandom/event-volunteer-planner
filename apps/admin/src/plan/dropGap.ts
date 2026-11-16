// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Which gap of a vertical list a pointer at `y` is aiming at: the number of
 * cards whose midline it has passed.
 *
 * Midlines rather than edges, so a card swaps places as soon as the dragged
 * one covers half of it — the threshold every list a coordinator has used
 * before behaves by. The rectangles are measured once when the drag starts,
 * before anything moves, which is what lets the answer be fed straight to
 * `placeQuestion`: both count gaps in the list as it was.
 */
export function dropGap(
  cards: readonly { readonly top: number; readonly bottom: number }[],
  y: number,
): number {
  return cards.filter((card) => y >= (card.top + card.bottom) / 2).length;
}
