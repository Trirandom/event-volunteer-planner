// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * vue-i18n's compile-time switches, for every Vite config that bundles it
 * (both applications and Vitest). One definition so the form and the admin
 * cannot drift into shipping different halves of the library.
 *
 * - The legacy (Options API) half and the global components are unused:
 *   `@evp/shared/i18n` is Composition-only and renders no `<i18n-t>`.
 * - Its message compiler is replaced by FormatJS (`compiler.ts`), so its own
 *   is dead weight — and would otherwise be bundled beside ours.
 * - No devtools hook in production builds.
 */
export const vueI18nBuildFlags = {
  __VUE_I18N_LEGACY_API__: 'false',
  __VUE_I18N_FULL_INSTALL__: 'false',
  __INTLIFY_DROP_MESSAGE_COMPILER__: 'true',
  __INTLIFY_PROD_DEVTOOLS__: 'false',
} as const;
