// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * docs/14 §5: the form drafts to `localStorage` as it is filled, so a dropped
 * connection at a venue does not discard ten minutes of work.
 *
 * Keyed on the *version*: answers typed against version 3 are not offered
 * to version 4's questions, which may mean something else (docs/09 §2). The
 * token is never stored — it is a credential, and the draft is not.
 *
 * Storage is parsed on the way back in like any other boundary: another tab,
 * an older build or a curious volunteer may have written anything there.
 */
import * as v from 'valibot';

import type { DayAnswer } from '../availability/model';
import type { Answers } from './answers';

const rangeSchema = v.object({ start: v.number(), end: v.number() });

const draftSchema = v.object({
  answers: v.record(
    v.string(),
    v.union([v.string(), v.boolean(), v.array(v.string()), v.null()]),
  ),
  availability: v.record(
    v.string(),
    v.object({
      status: v.picklist(['unset', 'all', 'partial', 'no']),
      ranges: v.array(rangeSchema),
    }),
  ),
});

export interface Draft {
  readonly answers: Answers;
  readonly availability: Readonly<Record<string, DayAnswer>>;
}

function key(slug: string, versionId: string): string {
  return `evp-form:${slug}:${versionId}`;
}

// Private browsing and a full quota both throw; a form that cannot draft is
// still a form that can be submitted.
function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function loadDraft(slug: string, versionId: string): Draft | null {
  const raw = storage()?.getItem(key(slug, versionId));
  if (raw == null) {
    return null;
  }
  try {
    const parsed = v.safeParse(draftSchema, JSON.parse(raw));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

export function saveDraft(slug: string, versionId: string, draft: Draft): void {
  try {
    storage()?.setItem(key(slug, versionId), JSON.stringify(draft));
  } catch {
    // Quota exceeded: carry on without a draft rather than interrupt.
  }
}

/** After a successful send, and on «Effacer et recommencer». Every version
 * of this form goes, so a stale draft cannot resurface later. */
export function clearDrafts(slug: string): void {
  const store = storage();
  if (store === null) {
    return;
  }
  const prefix = `evp-form:${slug}:`;
  for (let i = store.length - 1; i >= 0; i -= 1) {
    const name = store.key(i);
    if (name?.startsWith(prefix) === true) {
      store.removeItem(name);
    }
  }
}
