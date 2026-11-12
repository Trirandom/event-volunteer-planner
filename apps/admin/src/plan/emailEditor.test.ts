// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * What the schedule email's editor lets into a template (ADR-0046).
 *
 * The editor runs headless here, without a view: what is being tested is the
 * schema and the serialiser, which decide what reaches an inbox, not how the
 * toolbar looks.
 */
import { Editor } from '@tiptap/core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { i18n, t } from '../i18n';
import {
  emailExtensions,
  emailHtml,
  insertVariable,
  templateForEditor,
  variableHtml,
} from './emailEditor';
import { TEMPLATE_VARIABLES, unknownPlaceholders } from './emails';

let editors: Editor[] = [];

function load(html: string): Editor {
  const editor = new Editor({
    extensions: emailExtensions(),
    content: templateForEditor(html),
  });
  editors.push(editor);
  return editor;
}

function normalised(html: string): string {
  return emailHtml(load(html));
}

afterEach(() => {
  for (const editor of editors) {
    editor.destroy();
  }
  editors = [];
});

describe('what the editor keeps', () => {
  it('keeps paragraphs, line breaks and the inline formatting mail clients render', () => {
    expect(
      normalised('<p><strong>a</strong> <em>b</em> <u>c</u><br>d</p><p>e</p>'),
    ).toBe('<p><strong>a</strong> <em>b</em> <u>c</u><br>d</p><p>e</p>');
  });

  it('reads the spreadsheet-era tags as their equivalents', () => {
    expect(normalised('<p><b>a</b> <i>b</i></p>')).toBe(
      '<p><strong>a</strong> <em>b</em></p>',
    );
  });

  it('writes an empty line as a paragraph holding a break, which mail clients would otherwise collapse', () => {
    expect(normalised('<p>a</p><p></p><p>b</p>')).toBe(
      '<p>a</p><p><br></p><p>b</p>',
    );
  });

  it('reads that break back as an empty line, not as a line holding a break', () => {
    const editor = load('<p>a</p><p><br></p><p>b</p>');
    expect(editor.state.doc.child(1).childCount).toBe(0);
  });

  it('writes list items without a paragraph inside, which mail clients space out', () => {
    expect(normalised('<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>')).toBe(
      '<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>',
    );
  });

  it('keeps an https link, with no class and nothing that reaches back to this page', () => {
    const html = normalised('<p><a href="https://example.org/plan">x</a></p>');
    expect(html).toContain('href="https://example.org/plan"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toContain('class=');
  });

  it('keeps a mailto link', () => {
    expect(
      normalised('<p><a href="mailto:team@example.org">x</a></p>'),
    ).toContain('href="mailto:team@example.org"');
  });
});

describe('what the editor drops', () => {
  it('drops styles, classes, fonts and colours pasted from elsewhere, keeping the words', () => {
    expect(
      normalised(
        '<p style="color:red" class="MsoNormal"><font face="Comic Sans">Hi</font> <span style="background:yellow">there</span></p>',
      ),
    ).toBe('<p>Hi there</p>');
  });

  it('drops scripts, images and iframes entirely', () => {
    const html = normalised(
      '<p>a</p><script>alert(1)</script><img src="x" onerror="alert(1)"><iframe src="https://example.org"></iframe><p>b</p>',
    );
    expect(html).toBe('<p>a</p><p>b</p>');
  });

  it('keeps a table’s words but not the table, which Outlook lays out its own way', () => {
    const html = normalised('<table><tr><td>cell</td></tr></table>');
    expect(html).not.toContain('<t');
    expect(html).toContain('cell');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
  ])('drops a %s link and keeps its text', (href) => {
    expect(normalised(`<p><a href="${href}">x</a></p>`)).toBe('<p>x</p>');
  });
});

describe('placeholders', () => {
  it('round-trips an inline placeholder as an atom', () => {
    const html = `<p>Bonjour ${variableHtml('firstName')},</p>`;
    expect(normalised(html)).toBe(html);
  });

  it('writes the literal braces inside the span, which both renderers replace', () => {
    expect(variableHtml('organizationName')).toBe(
      '<span data-evp-variable="organizationName">{{organizationName}}</span>',
    );
  });

  it('writes the schedule as a block, since a list cannot sit inside a paragraph', () => {
    expect(variableHtml('assignations')).toBe(
      '<div data-evp-variable="assignations">{{assignations}}</div>',
    );
    const html = `<p>Voici :</p>${variableHtml('assignations')}<p>À bientôt</p>`;
    expect(normalised(html)).toBe(html);
  });

  it('round-trips a fallback as one atom, since its halves mean nothing apart', () => {
    const html = `<p>Merci au ${variableHtml('eventName|festivalName')} !</p>`;
    expect(normalised(html)).toBe(html);
  });

  it('keeps an unknown name as text, so it is still reported rather than hidden in a chip', () => {
    const html = normalised(
      '<p><span data-evp-variable="firstname">{{firstname}}</span></p>',
    );
    expect(html).toBe('<p>{{firstname}}</p>');
    expect(unknownPlaceholders(html)).toEqual(['firstname']);
  });

  it('reads braces written as text, in a draft from the textarea, as atoms', () => {
    expect(normalised('<p>Merci au {{eventName|festivalName}} !</p>')).toBe(
      `<p>Merci au ${variableHtml('eventName|festivalName')} !</p>`,
    );
  });

  it('leaves unknown braces written as text alone', () => {
    expect(normalised('<p>{{firstname}} {{}} {{first{Name}}</p>')).toBe(
      '<p>{{firstname}} {{}} {{first{Name}}</p>',
    );
  });

  it('lifts a schedule written as text out of its paragraph', () => {
    expect(normalised('<p>Voici : {{assignations}} Merci</p>')).toBe(
      `<p>Voici :</p>${variableHtml('assignations')}<p>Merci</p>`,
    );
  });

  it('reads the textarea’s default template, so a draft saved before the editor keeps its schedule block', () => {
    expect(
      normalised(
        '<div dir="ltr">\nBonjour {{firstName}},<br>\n<br>\n<b>Voici tes créneaux bénévoles :</b><br>\n<div>\n{{assignations}}\n</div><br>\nÀ bientôt<br>\n</div>',
      ),
    ).toBe(
      `<p>Bonjour ${variableHtml('firstName')},<br><br><strong>Voici tes créneaux bénévoles :</strong><br></p>${variableHtml('assignations')}<p><br>À bientôt<br></p>`,
    );
  });

  it('inserts at the caret, not at the end', () => {
    const editor = load('<p>Bonjour !</p>');
    // Position 1 is the paragraph's start; "Bonjour" is 7 characters.
    editor.commands.setTextSelection(8);
    insertVariable(editor, 'firstName');
    expect(emailHtml(editor)).toBe(
      `<p>Bonjour${variableHtml('firstName')} !</p>`,
    );
  });

  it('inserts the schedule as its own block, splitting the paragraph it lands in', () => {
    const editor = load('<p>avantaprès</p>');
    editor.commands.setTextSelection(6);
    insertVariable(editor, 'assignations');
    expect(emailHtml(editor)).toBe(
      `<p>avant</p>${variableHtml('assignations')}<p>après</p>`,
    );
  });

  it.each(TEMPLATE_VARIABLES)('inserts %s as a known placeholder', (name) => {
    const editor = load('<p></p>');
    insertVariable(editor, name);
    const html = emailHtml(editor);
    expect(html).toContain(`data-evp-variable="${name}"`);
    expect(unknownPlaceholders(html)).toEqual([]);
  });
});

describe('the default template', () => {
  afterAll(async () => {
    await i18n.setLocale('en');
  });

  it.each(['fr', 'en'] as const)(
    'is already in the editor’s own form in %s, so loading it changes nothing',
    async (locale) => {
      await i18n.setLocale(locale);
      const template = t('emails.template.default', {
        firstName: variableHtml('firstName'),
        eventOrFestival: variableHtml('eventName|festivalName'),
        assignations: variableHtml('assignations'),
        organizationName: variableHtml('organizationName'),
      });
      expect(normalised(template)).toBe(template);
      expect(unknownPlaceholders(template)).toEqual([]);
    },
  );
});
