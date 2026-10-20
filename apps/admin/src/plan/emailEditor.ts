// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The schedule email's editor: what it can express, and the HTML it writes
 * (ADR-0046).
 *
 * The schema *is* the email-safety guarantee. Anything pasted in is parsed
 * into these nodes and marks or dropped, so a Word document's fonts, a web
 * page's classes or a script never reach the stored template. A sanitiser run
 * afterwards would be a second, weaker statement of the same list.
 *
 * The output is the same HTML-with-`{{placeholders}}` the textarea held, so
 * `renderTemplate` here and `evp_domain::schedule::render` on the server read
 * it unchanged. A placeholder is an atom wrapped around its own literal braces,
 * which is what both of them replace.
 */
import { Node, type Editor, type Extensions } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import DocumentExtension from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Italic from '@tiptap/extension-italic';
import Link from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import TextExtension from '@tiptap/extension-text';
import Underline from '@tiptap/extension-underline';
import { Gapcursor, UndoRedo } from '@tiptap/extensions';
import { DOMSerializer } from '@tiptap/pm/model';

import { escapeHtml, isKnownPlaceholder, textParts } from './emails';

const ATTRIBUTE = 'data-evp-variable';

/** The schedule is a list, and a list inside a paragraph is invalid HTML
 * that every mail client repairs differently. */
const BLOCK_VARIABLE = 'assignations';

/** Mail clients follow these and nothing else that is safe to put in front
 * of four hundred people. A relative URL means nothing in an inbox. */
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function isAllowedLink(url: string): boolean {
  try {
    return LINK_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function braces(inner: string): string {
  return `{{${inner}}}`;
}

const InlineVariable = Node.create({
  name: 'evpVariable',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { name: { default: '', rendered: false } };
  },

  parseHTML() {
    return [
      {
        tag: `span[${ATTRIBUTE}]`,
        // An unknown name falls through to its text, braces and all, so
        // `unknownPlaceholders` still reports it; a chip would make the typo
        // look intended.
        getAttrs: (element) => {
          const name = element.getAttribute(ATTRIBUTE) ?? '';
          return isKnownPlaceholder(name) && name !== BLOCK_VARIABLE
            ? { name }
            : false;
        },
      },
    ];
  },

  renderHTML({ node }) {
    const name = String(node.attrs['name']);
    return ['span', { [ATTRIBUTE]: name }, braces(name)];
  },

  renderText({ node }) {
    return braces(String(node.attrs['name']));
  },
});

const BlockVariable = Node.create({
  name: 'evpSchedule',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: `div[${ATTRIBUTE}="${BLOCK_VARIABLE}"]` }];
  },

  renderHTML() {
    return ['div', { [ATTRIBUTE]: BLOCK_VARIABLE }, braces(BLOCK_VARIABLE)];
  },

  renderText() {
    return braces(BLOCK_VARIABLE);
  },
});

/** Everything the template can contain. Headings, colours, alignment, tables
 * and images are left out on purpose: each renders differently, or not at
 * all, across the mail clients volunteers use. */
export function emailExtensions(): Extensions {
  return [
    DocumentExtension,
    Paragraph,
    TextExtension,
    HardBreak,
    Bold,
    Italic,
    Underline,
    BulletList,
    OrderedList,
    ListItem,
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
      isAllowedUri: isAllowedLink,
      shouldAutoLink: isAllowedLink,
      HTMLAttributes: { class: null },
    }),
    InlineVariable,
    BlockVariable,
    UndoRedo,
    // A caret before or after the schedule block, which is otherwise
    // unreachable when it opens or closes the message.
    Gapcursor,
  ];
}

/** A placeholder as the editor writes it. */
export function variableHtml(inner: string): string {
  return inner === BLOCK_VARIABLE
    ? `<div ${ATTRIBUTE}="${BLOCK_VARIABLE}">${braces(BLOCK_VARIABLE)}</div>`
    : `<span ${ATTRIBUTE}="${escapeHtml(inner)}">${escapeHtml(braces(inner))}</span>`;
}

function variableElement(owner: Document, inner: string): Element {
  const element = owner.createElement(
    inner === BLOCK_VARIABLE ? 'div' : 'span',
  );
  element.setAttribute(ATTRIBUTE, inner);
  element.textContent = braces(inner);
  return element;
}

/** A schedule found mid-sentence splits its paragraph in two, either half
 * dropped when nothing is left of it. Left to ProseMirror, the split keeps
 * the space beside the braces and adds an empty paragraph after. */
function liftOutOfParagraph(block: Element): void {
  const paragraph = block.parentElement;
  if (paragraph?.tagName !== 'P') {
    return;
  }
  const after = block.ownerDocument.createElement('p');
  while (block.nextSibling !== null) {
    after.append(block.nextSibling);
  }
  paragraph.after(block, after);
  if (paragraph.lastChild instanceof Text) {
    paragraph.lastChild.data = paragraph.lastChild.data.trimEnd();
  }
  if (after.firstChild instanceof Text) {
    after.firstChild.data = after.firstChild.data.trimStart();
  }
  for (const half of [paragraph, after]) {
    if (half.textContent === '' && half.children.length === 0) {
      half.remove();
    }
  }
}

/**
 * A stored template made ready to load.
 *
 * Drafts written in the textarea before the editor hold their placeholders
 * as plain braces, and the schedule as `<div>{{assignations}}</div>`, which
 * the editor would otherwise fold into a paragraph and send as a list inside
 * a `<p>`. Known braces become atoms here; a schedule in the middle of a
 * sentence becomes a block, and the editor splits the paragraph around it.
 *
 * Parsed with `DOMParser`, which builds an inert document, and rebuilt with
 * `createElement`: no string from the template is ever assigned as markup.
 */
export function templateForEditor(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (
      node instanceof Text &&
      node.parentElement?.closest(`[${ATTRIBUTE}]`) == null
    ) {
      texts.push(node);
    }
  }
  for (const text of texts) {
    const parts = textParts(text.data);
    if (!parts.some((part) => part.kind === 'placeholder')) {
      continue;
    }
    text.replaceWith(
      ...parts.map((part) =>
        part.kind === 'placeholder' && isKnownPlaceholder(part.inner)
          ? variableElement(parsed, part.inner)
          : part.kind === 'placeholder'
            ? part.whole
            : part.text,
      ),
    );
  }
  for (const block of parsed.body.querySelectorAll(
    `div[${ATTRIBUTE}="${BLOCK_VARIABLE}"]`,
  )) {
    liftOutOfParagraph(block);
  }
  // The break `emailHtml` writes into an empty line is not content: read
  // back as a hard break, the line would grow by one each time it is loaded.
  for (const paragraph of parsed.body.querySelectorAll('p')) {
    const only = paragraph.firstChild;
    if (
      paragraph.childNodes.length === 1 &&
      only instanceof Element &&
      only.tagName === 'BR'
    ) {
      only.remove();
    }
  }
  return parsed.body.innerHTML;
}

/** Puts a placeholder at the caret, replacing any selection. */
export function insertVariable(editor: Editor, inner: string): void {
  editor
    .chain()
    .insertContent(
      inner === BLOCK_VARIABLE
        ? { type: BlockVariable.name }
        : { type: InlineVariable.name, attrs: { name: inner } },
    )
    .run();
}

/**
 * The template as stored.
 *
 * ProseMirror keeps a paragraph inside every list item, and Outlook and Gmail
 * give that paragraph its margins, so a three-line list arrives spaced like
 * three paragraphs. The item's first paragraph is unwrapped on the way out;
 * reading `<li>text</li>` back wraps it again, so the round trip is stable.
 */
export function emailHtml(editor: Editor): string {
  const fragment = DOMSerializer.fromSchema(editor.schema).serializeFragment(
    editor.state.doc.content,
  );
  const container = document.createElement('div');
  container.append(fragment);
  for (const paragraph of container.querySelectorAll('li > p:first-child')) {
    paragraph.replaceWith(...paragraph.childNodes);
  }
  // An empty paragraph has no height in Gmail or Outlook, so the blank line
  // a coordinator made with Enter would vanish in the inbox.
  for (const paragraph of container.querySelectorAll('p:empty')) {
    paragraph.append(document.createElement('br'));
  }
  return container.innerHTML;
}
