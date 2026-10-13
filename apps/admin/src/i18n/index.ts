// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The coordinator application's translations (docs/16 §6, ADR-0038).
 *
 * `t` is the only way a string reaches the screen: in a template, in a
 * `computed`, or in a plain module under `plan/` or `board/`. It reads the
 * current locale, so everything built with it follows a language switch
 * without being told. Keys are typed against the French catalogue, which is
 * the default and the fallback; the English one is declared with the same type
 * and loaded on first use.
 *
 * Catalogues are split by area (`fr/<area>.ts`, `en/<area>.ts`) so a screen's
 * strings are reviewed beside each other, and so two changes to two screens
 * never touch the same file.
 */
import { createEvpI18n, type MessageKey } from '@evp/shared/i18n';

import fr from './fr';

export type Messages = typeof fr;
export type AdminMessageKey = MessageKey<Messages>;

export const i18n = createEvpI18n({
  fr,
  others: { en: async () => (await import('./en')).default },
});

export const { t, locale, setLocale } = i18n;
