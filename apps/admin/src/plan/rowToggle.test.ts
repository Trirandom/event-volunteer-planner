// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterEach, describe, expect, it } from 'vitest';

import { togglesRow } from './rowToggle';

function row(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

function clickOn(target: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('togglesRow', () => {
  it('toggles on a click anywhere in the row that is not a control', () => {
    const element = row('<p class="summary"><span>Doors 18:00</span></p>');
    const span = element.querySelector('span');

    expect(span !== null && togglesRow(clickOn(span))).toBe(true);
    expect(togglesRow(clickOn(element))).toBe(true);
  });

  /** The name is the disclosure button and toggles on its own; counting it
   * here as well would open and close the row in one click. */
  it('leaves the row’s own buttons to themselves, down to their icons', () => {
    const element = row(
      '<button type="button"><svg><path></path></svg></button>',
    );
    const path = element.querySelector('path');

    expect(path !== null && togglesRow(clickOn(path))).toBe(false);
  });

  it.each(['a', 'input', 'select', 'textarea', 'label'])(
    'leaves a %s alone',
    (tag) => {
      const element = row(`<${tag}></${tag}>`);
      const control = element.firstElementChild;

      expect(control !== null && togglesRow(clickOn(control))).toBe(false);
    },
  );

  /** Selecting a summary to copy it ends in a click; that is not a request to
   * open the row. */
  it('does not toggle at the end of a text selection', () => {
    const element = row('<p>Doors 18:00–02:00</p>');
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()?.addRange(range);

    expect(togglesRow(clickOn(element))).toBe(false);
  });
});
