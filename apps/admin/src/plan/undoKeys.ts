// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Which editor undo, if any, a key press asks for. Shared by the form builder
 * (ADR-0048) and the missions page (ADR-0049), so Ctrl/Cmd+Z means the same
 * thing on both.
 */

/** A field whose own text undo must win: Ctrl+Z while typing a label takes
 * back the last letters, as it does everywhere else (docs/14 §4). */
export function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(
      target.type,
    );
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

/** Ctrl/Cmd+Z is undo; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y are redo. `null` for
 * anything else, and for any of them typed into a text field. */
export function undoKeyOf(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  const command =
    key === 'z' && !event.shiftKey
      ? 'undo'
      : (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)
        ? 'redo'
        : null;
  return command === null || isTextEntry(event.target) ? null : command;
}
