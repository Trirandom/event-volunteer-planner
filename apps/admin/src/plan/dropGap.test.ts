// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { dropGap } from './dropGap';

/** Three cards, 100 px tall, 10 px apart: midlines at 50, 160 and 270. */
const CARDS = [
  { top: 0, bottom: 100 },
  { top: 110, bottom: 210 },
  { top: 220, bottom: 320 },
] as const;

describe('dropGap', () => {
  it('is the gap above the first card when the pointer is above its midline', () => {
    expect(dropGap(CARDS, -40)).toBe(0);
    expect(dropGap(CARDS, 49)).toBe(0);
  });

  it('is the gap after a card once the pointer passes its midline', () => {
    expect(dropGap(CARDS, 50)).toBe(1);
    expect(dropGap(CARDS, 159)).toBe(1);
    expect(dropGap(CARDS, 160)).toBe(2);
  });

  it('is the last gap below the last midline, however far below', () => {
    expect(dropGap(CARDS, 270)).toBe(3);
    expect(dropGap(CARDS, 5000)).toBe(3);
  });

  it('is the only gap there is in an empty list', () => {
    expect(dropGap([], 120)).toBe(0);
  });
});
