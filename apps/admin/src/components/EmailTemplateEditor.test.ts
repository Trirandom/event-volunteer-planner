// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The editor's wiring: a labelled textbox, placeholders inserted from
 * outside, the parent's value taking over when it changes, and a link the
 * schema refuses being refused out loud.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { t } from '../i18n';
import { variableHtml } from '../plan/emailEditor';
import EmailTemplateEditor from './EmailTemplateEditor.vue';

let wrapper: VueWrapper | null = null;

// jsdom does no layout, so `Range` has no geometry, and ProseMirror asks for
// it to scroll the caret into view after an insert. Nothing here is about
// layout; an empty answer is the honest one.
const rangeHadRects = 'getClientRects' in Range.prototype;
beforeAll(() => {
  if (!rangeHadRects) {
    Range.prototype.getClientRects = () =>
      document.createElement('div').getClientRects();
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
});
afterAll(() => {
  if (!rangeHadRects) {
    Reflect.deleteProperty(Range.prototype, 'getClientRects');
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  }
});

function mountEditor(modelValue: string): VueWrapper {
  wrapper = mount(EmailTemplateEditor, {
    attachTo: document.body,
    props: {
      modelValue,
      id: 'editor',
      labelledby: 'editor-label',
      describedby: 'editor-hint',
      'onUpdate:modelValue': (value: string) => {
        void wrapper?.setProps({ modelValue: value });
      },
    },
  });
  return wrapper;
}

function emitted(view: VueWrapper): readonly string[] {
  return (view.emitted('update:modelValue') ?? []).map((args) =>
    String(args[0]),
  );
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('EmailTemplateEditor', () => {
  it('is a multi-line textbox named by the page’s label and described by its hint', async () => {
    const view = mountEditor('<p>Bonjour</p>');
    await flushPromises();
    const box = view.get('#editor');
    expect(box.attributes('role')).toBe('textbox');
    expect(box.attributes('aria-multiline')).toBe('true');
    expect(box.attributes('aria-labelledby')).toBe('editor-label');
    expect(box.attributes('aria-describedby')).toBe('editor-hint');
    expect(box.attributes('contenteditable')).toBe('true');
  });

  it('follows a change of description, such as the unknown-variable warning appearing', async () => {
    const view = mountEditor('<p>Bonjour</p>');
    await flushPromises();
    await view.setProps({ describedby: 'editor-hint editor-unknown' });
    expect(view.get('#editor').attributes('aria-describedby')).toBe(
      'editor-hint editor-unknown',
    );
  });

  it('shows placeholders as chips, not as markup', async () => {
    const view = mountEditor(`<p>Bonjour ${variableHtml('firstName')}</p>`);
    await flushPromises();
    const chip = view.get('#editor [data-evp-variable="firstName"]');
    expect(chip.text()).toBe('{{firstName}}');
    expect(view.get('#editor').text()).not.toContain('<span');
  });

  it('writes the template back when a placeholder is inserted', async () => {
    const view = mountEditor('<p>Bonjour</p>');
    await flushPromises();
    const exposed: unknown = view.vm;
    if (
      typeof exposed !== 'object' ||
      exposed === null ||
      !('insert' in exposed) ||
      typeof exposed.insert !== 'function'
    ) {
      throw new Error('the editor does not expose insert()');
    }
    exposed.insert('organizationName');
    await flushPromises();
    expect(emitted(view).at(-1)).toContain(variableHtml('organizationName'));
  });

  it('takes the parent’s value when it changes, as the reset button does', async () => {
    const view = mountEditor('<p>Mon brouillon</p>');
    await flushPromises();
    await view.setProps({ modelValue: '<p>Le modèle par défaut</p>' });
    expect(view.get('#editor').text()).toBe('Le modèle par défaut');
    // Loading is not an edit: echoing it back would store the default as a
    // draft the coordinator never wrote.
    expect(emitted(view)).toEqual([]);
  });

  it('refuses a link the schema does not allow, and says why', async () => {
    const view = mountEditor('<p>Lien</p>');
    await flushPromises();
    await view
      .get(`button[aria-label="${t('emails.editor.link')}"]`)
      .trigger('click');
    await view.get('#emails-link-url').setValue('javascript:alert(1)');
    await view.get('form').trigger('submit');
    expect(view.get('[role="alert"]').text()).toBe(
      t('emails.editor.linkInvalid'),
    );
    expect(view.get('#emails-link-url').attributes('aria-invalid')).toBe(
      'true',
    );
  });

  it('closes the link form on Escape', async () => {
    const view = mountEditor('<p>Lien</p>');
    await flushPromises();
    await view
      .get(`button[aria-label="${t('emails.editor.link')}"]`)
      .trigger('click');
    await view.get('#emails-link-url').trigger('keydown', { key: 'Escape' });
    expect(view.find('#emails-link-form').exists()).toBe(false);
  });
});
