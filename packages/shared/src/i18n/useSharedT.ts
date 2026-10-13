// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { useI18n } from 'vue-i18n';

import type { MessageKey, MessageValues, Translate } from './index.js';
import type { sharedFr } from './messages.js';

/**
 * The shared components' translator. They cannot import an application's
 * `t`, so they reach the application's vue-i18n instance by injection and
 * read the `shared` subtree it mounted (`messages.ts`).
 *
 * Keys are typed against `sharedFr` the same way the applications' are, so a
 * shared component cannot ask for a string the catalogue does not have.
 */
export function useSharedT(): Translate<MessageKey<typeof sharedFr>> {
  const { t } = useI18n({ useScope: 'global' });
  return (key, values?: MessageValues) => t(`shared.${key}`, values ?? {});
}
