// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type { HtmlTagDescriptor, Plugin } from 'vite';

/**
 * Puts the two requests that decide when the form appears in the HTML itself,
 * instead of leaving each to be discovered by the code before it (docs/01 §5).
 *
 * - `src/early.ts` is a second entry that sends the form request while the
 *   application is still downloading (`src/api/early.ts`). `async`, because a
 *   plain module script runs in document order and would wait for the
 *   application's; async, it runs as soon as its own few hundred bytes arrive.
 * - The `FormView` chunk is otherwise only requested once the router has run.
 *   Nearly every visit is to a form, so it is preloaded here, styles included.
 *
 * Server-side rendering was the alternative and stays rejected (ADR-0004,
 * docs/09 §6): this gets the request started as early as SSR would, without a
 * Node process in production.
 */

/**
 * The part of a Rollup output entry this reads. Narrower than `OutputChunk`
 * so the test can build one without a bundle; the real type satisfies it.
 */
export interface BuiltChunk {
  readonly type: string;
  readonly fileName: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly facadeModuleId?: string | null;
  readonly viteMetadata?:
    { readonly importedCss: ReadonlySet<string> } | undefined;
}

const EARLY = /[\\/]src[\\/]early\.ts$/;
const FORM_VIEW = /[\\/]src[\\/]views[\\/]FormView\.vue$/;

function find(
  chunks: Iterable<BuiltChunk>,
  module: RegExp,
  what: string,
): BuiltChunk {
  for (const chunk of chunks) {
    if (chunk.type === 'chunk' && module.test(chunk.facadeModuleId ?? '')) {
      return chunk;
    }
  }
  // Renaming either file must fail the build, not ship the waterfall again.
  throw new Error(`firstPaint: no chunk for ${what} in the form bundle`);
}

export function firstPaintTags(
  chunks: Iterable<BuiltChunk>,
  base: string,
): HtmlTagDescriptor[] {
  const list = [...chunks];
  const early = find(list, EARLY, 'src/early.ts');
  const formView = find(list, FORM_VIEW, 'src/views/FormView.vue');
  return [
    {
      tag: 'script',
      attrs: {
        type: 'module',
        async: true,
        crossorigin: true,
        src: base + early.fileName,
      },
      injectTo: 'head',
    },
    {
      tag: 'link',
      attrs: {
        rel: 'modulepreload',
        crossorigin: true,
        href: base + formView.fileName,
      },
      injectTo: 'head',
    },
    // `preload`, not a stylesheet: as a stylesheet it would block the first
    // paint the shell in index.html exists to make early.
    ...[...(formView.viteMetadata?.importedCss ?? [])].map(
      (css): HtmlTagDescriptor => ({
        tag: 'link',
        attrs: { rel: 'preload', as: 'style', href: base + css },
        injectTo: 'head',
      }),
    ),
  ];
}

export function firstPaint(): Plugin {
  let base = '/';
  return {
    name: 'evp-form-first-paint',
    // The dev server has no chunks; `main.ts` imports the early entry there.
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        return context.bundle === undefined
          ? []
          : firstPaintTags(Object.values(context.bundle), base);
      },
    },
  };
}
