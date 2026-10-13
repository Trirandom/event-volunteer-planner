// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The help dialog, which is the only copy of instructions that used to be
 * printed on the page.
 *
 * Worth a test because moving text behind a button is exactly the change that
 * can lose it: the words must still be in the document, the trigger must be
 * the thing that reveals them, and both closing paths have to work — a modal
 * with no way out over a board is worse than the paragraph it replaced.
 *
 * jsdom does not implement `showModal`/`close`, so they are stubbed here; what
 * is being asserted is this component's wiring to them, not the platform's
 * behaviour behind them.
 */
import { mount } from '@vue/test-utils';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { setLocale } from '../i18n';

import HelpModal from './HelpModal.vue';

let open: boolean;

beforeEach(() => {
  open = false;
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(
    this: HTMLDialogElement,
  ) {
    open = true;
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function close(
    this: HTMLDialogElement,
  ) {
    open = false;
    this.removeAttribute('open');
  });
});

function mountHelp(): ReturnType<typeof mount> {
  return mount(HelpModal, {
    props: { title: 'Shifts' },
    slots: { default: '<p>Drag a bar edge to lengthen it.</p>' },
    attachTo: document.body,
  });
}

describe('HelpModal', () => {
  it('names what it explains on its trigger', () => {
    const wrapper = mountHelp();

    expect(wrapper.get('.evp-help-trigger').attributes('aria-label')).toContain(
      'Shifts',
    );
  });

  it('keeps the instructions in the document and opens them on press', async () => {
    const wrapper = mountHelp();

    expect(wrapper.text()).toContain('Drag a bar edge to lengthen it.');
    expect(open).toBe(false);

    await wrapper.get('.evp-help-trigger').trigger('click');

    expect(open).toBe(true);
  });

  it('closes on the close button and on a click outside the panel', async () => {
    const wrapper = mountHelp();
    await wrapper.get('.evp-help-trigger').trigger('click');

    await wrapper.get('.evp-help-close').trigger('click');
    expect(open).toBe(false);

    await wrapper.get('.evp-help-trigger').trigger('click');
    // A click on the panel is a click on the instructions, not a dismissal.
    await wrapper.get('.evp-help-panel').trigger('click');
    expect(open).toBe(true);

    await wrapper.get('.evp-help-dialog').trigger('click');
    expect(open).toBe(false);
  });
});

describe('HelpModal in French', () => {
  beforeAll(async () => {
    await setLocale('fr');
  });
  afterAll(async () => {
    await setLocale('en');
  });

  // The labels are the component's own, not the caller's, so they are the
  // ones that would stay English if they were frozen at import.
  it('labels its buttons in the interface language', () => {
    const wrapper = mountHelp();

    expect(wrapper.get('.evp-help-trigger').attributes('aria-label')).toBe(
      'Fonctionnement de cette page\u00a0: Shifts',
    );
    expect(wrapper.get('.evp-help-close').attributes('aria-label')).toBe(
      'Fermer',
    );
  });
});
