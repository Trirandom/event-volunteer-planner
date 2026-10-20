// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Backoffice wording that is a function of data rather than a fixed key —
 * one place, so the three sections cannot each phrase a refusal their own
 * way.
 */
import { eventTimeZone, formatDateShort, formatTime } from '@evp/shared/intl';
import { Temporal } from '@evp/shared/time';

import type { BackofficeRejection, MemberRole } from '../api/backoffice';
import { locale, t } from '../i18n';

export function roleLabel(role: MemberRole): string {
  return t(`backoffice.roles.${role}`);
}

/** A rejection as the sentence shown under the control that caused it. */
export function rejectionMessage(rejection: BackofficeRejection): string {
  switch (rejection.reason) {
    case 'bad-key':
      return t('backoffice.lock.badKey');
    case 'disabled':
      return t('backoffice.lock.disabled');
    case 'rate-limited':
      return t('backoffice.error.rateLimited');
    case 'unavailable':
      return t('backoffice.error.unavailable');
    case 'not-found':
      return t('backoffice.error.notFound', { detail: rejection.detail });
    case 'conflict':
    case 'validation-failed':
    case 'refused':
      // The server names the slug or e-mail it refused and why, which no
      // message of ours could; it stays the answer until refusals carry
      // per-field codes (as `sms.ts` does for the same reason).
      return rejection.detail;
  }
}

/**
 * A last sign-in, in UTC and saying so.
 *
 * UTC because an account belongs to no event and so has no event zone to
 * borrow, and the viewer's own zone is the one `@evp/shared/intl` exists to
 * keep out (docs/16 §4). The label is in the message, per docs/16 §5.
 */
export function lastLoginLabel(iso: string | null): string {
  if (iso === null) {
    return t('backoffice.users.neverSignedIn');
  }
  const epoch = Temporal.Instant.from(iso).epochMilliseconds;
  const options = { locale: locale.value, timeZone: eventTimeZone('UTC') };
  return t('backoffice.users.lastLoginAt', {
    date: formatDateShort(epoch, options),
    time: formatTime(epoch, options),
  });
}
