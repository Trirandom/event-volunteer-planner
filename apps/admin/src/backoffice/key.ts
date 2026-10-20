// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The backoffice key, for as long as this tab is open and no longer.
 *
 * Module state rather than a Pinia store: a store would put the key in the
 * devtools' state inspector, and there is only ever one per tab. Components
 * should go through `useBackofficeLock` (`api/useBackoffice.ts`), which also
 * drops the rows the key fetched when it is cleared.
 */
import { readonly, ref } from 'vue';

// In memory only — never localStorage/sessionStorage: a deployment-wide
// credential at rest in a browser profile costs more than retyping it after a
// reload (ADR-0045 "The interface").
const current = ref<string | null>(null);

/** The key, or `null` while the backoffice is locked. */
export const backofficeKey = readonly(current);

export function setBackofficeKey(key: string): void {
  current.value = key;
}

export function clearBackofficeKey(): void {
  current.value = null;
}
