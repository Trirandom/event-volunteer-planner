// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { firstPaintTags, type BuiltChunk } from './firstPaint';

const earlyEntry: BuiltChunk = {
  type: 'chunk',
  fileName: 'assets/early-abc.js',
  isEntry: true,
  isDynamicEntry: false,
  facadeModuleId: '/repo/apps/form/src/early.ts',
};

const formView: BuiltChunk = {
  type: 'chunk',
  fileName: 'assets/FormView-def.js',
  isEntry: false,
  isDynamicEntry: true,
  facadeModuleId: '/repo/apps/form/src/views/FormView.vue',
  viteMetadata: { importedCss: new Set(['assets/FormView-ghi.css']) },
};

const appEntry: BuiltChunk = {
  type: 'chunk',
  fileName: 'assets/index-jkl.js',
  isEntry: true,
  isDynamicEntry: false,
  facadeModuleId: '/repo/apps/form/index.html',
};

const stylesheet: BuiltChunk = {
  type: 'asset',
  fileName: 'assets/FormView-ghi.css',
};

describe('the tags that put the form on screen sooner (docs/01 §5)', () => {
  it('runs the early entry without waiting for the application’s', () => {
    const tags = firstPaintTags([appEntry, formView, earlyEntry], '/f/');

    expect(tags[0]).toEqual({
      tag: 'script',
      attrs: {
        type: 'module',
        async: true,
        crossorigin: true,
        src: '/f/assets/early-abc.js',
      },
      injectTo: 'head',
    });
  });

  it('fetches the form view and its styles while the application loads', () => {
    const tags = firstPaintTags(
      [appEntry, formView, earlyEntry, stylesheet],
      '/f/',
    );

    expect(tags.slice(1)).toEqual([
      {
        tag: 'link',
        attrs: {
          rel: 'modulepreload',
          crossorigin: true,
          href: '/f/assets/FormView-def.js',
        },
        injectTo: 'head',
      },
      {
        tag: 'link',
        attrs: {
          rel: 'preload',
          as: 'style',
          href: '/f/assets/FormView-ghi.css',
        },
        injectTo: 'head',
      },
    ]);
  });

  it('recognises the modules by a Windows path too', () => {
    const tags = firstPaintTags(
      [
        {
          ...earlyEntry,
          facadeModuleId: 'C:\\repo\\apps\\form\\src\\early.ts',
        },
        {
          ...formView,
          facadeModuleId: 'C:\\repo\\apps\\form\\src\\views\\FormView.vue',
        },
      ],
      '/f/',
    );

    expect(tags).toHaveLength(3);
  });

  // A rename must break the build, not quietly put the waterfall back.
  it.each([
    ['the early entry', [appEntry, formView]],
    ['the form view', [appEntry, earlyEntry]],
  ])('refuses a bundle without %s', (_, chunks) => {
    expect(() => firstPaintTags(chunks, '/f/')).toThrow();
  });
});
