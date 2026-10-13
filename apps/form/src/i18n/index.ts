// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The volunteer form's translations (docs/09 §7, docs/16 §6, ADR-0038).
 *
 * Only the interface is here. Question labels, help text and option labels
 * are the coordinator's words, stored per locale on the form version and
 * served with it; this catalogue never holds them.
 *
 * The English catalogue is its own chunk: most volunteers read French, and
 * they should not download English against the 1.5 s cold-load budget
 * (docs/01 §5).
 */
import { createEvpI18n, type MessageKey } from '@evp/shared/i18n';

import fr from './fr';

export type Messages = typeof fr;
export type FormMessageKey = MessageKey<Messages>;

export const i18n = createEvpI18n({
  fr,
  others: { en: async () => (await import('./en')).default },
});

export const { t, locale, setLocale } = i18n;
