// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { undoKeyOf } from './undoKeys';

function press(
  key: string,
  modifiers: KeyboardEventInit,
  target: HTMLElement = document.body,
): 'undo' | 'redo' | null {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    ...modifiers,
  });
  let command: 'undo' | 'redo' | null = null;
  target.addEventListener('keydown', (received) => {
    command = undoKeyOf(received);
  });
  target.dispatchEvent(event);
  return command;
}

describe('undoKeyOf', () => {
  it.each([
    ['z', { ctrlKey: true }, 'undo'],
    ['z', { metaKey: true }, 'undo'],
    ['Z', { ctrlKey: true, shiftKey: true }, 'redo'],
    ['z', { metaKey: true, shiftKey: true }, 'redo'],
    ['y', { ctrlKey: true }, 'redo'],
    ['z', {}, null],
    ['z', { ctrlKey: true, altKey: true }, null],
    ['y', { ctrlKey: true, shiftKey: true }, null],
    ['s', { ctrlKey: true }, null],
  ] as const)('%s with %o is %s', (key, modifiers, expected) => {
    expect(press(key, modifiers)).toBe(expected);
  });

  it('leaves Ctrl+Z to a text field’s own undo', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.append(input);

    expect(press('z', { ctrlKey: true }, input)).toBeNull();
    input.remove();
  });

  it('takes Ctrl+Z on a checkbox, which has no text to undo', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    document.body.append(box);

    expect(press('z', { ctrlKey: true }, box)).toBe('undo');
    box.remove();
  });
});
