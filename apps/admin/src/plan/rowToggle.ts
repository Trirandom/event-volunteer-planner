// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Whether a click on a list row should open or close it.
 *
 * Shared by the mission and event rows, where the whole closed line is a
 * target: coordinators aim at the summary or the days as often as at the
 * name, and a row that only answered on its name read as broken. The name
 * stays the real disclosure button, with `aria-expanded`, and the keyboard
 * path. This only widens where a pointer may land.
 *
 * Everything that is a control of its own is left alone, which also covers
 * the name's button: counting it here as well would open and close the row
 * in one click.
 */
const CONTROLS = 'button, a, input, select, textarea, label, [role="button"]';

export function togglesRow(event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element) || target.closest(CONTROLS) !== null) {
    return false;
  }
  // A drag to select the summary ends in a click; copying is not opening.
  const selection = window.getSelection();
  return selection === null || selection.isCollapsed;
}
