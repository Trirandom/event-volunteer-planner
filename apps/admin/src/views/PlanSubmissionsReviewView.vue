<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->

<script setup lang="ts">
/**
 * The review queue: form submissions that could not join the pool on their
 * own (docs/08 §6, ADR-0042), each beside the volunteers it could be.
 *
 * A sub-page of the submissions, reached from the callout there: what is
 * listed here is in nobody's row on that page until a coordinator decides.
 * Four decisions, and the server is the one that applies them —
 *
 * * **C'est cette personne**: apply it to that volunteer (`match`).
 * * **Nouveau bénévole**: nobody in the pool; create them (`create_new`).
 * * **Relancer la correspondance**: for one held only because it was sent
 *   too fast, and so never compared with the pool (`reconcile`).
 * * **Rejeter**: spam or a test; kept, applied to nobody (`reject`).
 *
 * The side-by-side is the whole point (docs/08 §6): a coordinator merging two
 * people should see both, never a score alone.
 */
import { eventTimeZone, formatDate, formatTime } from '@evp/shared/intl';
import { Temporal } from '@evp/shared/time';
import { computed, ref } from 'vue';

import type {
  ResolveRejection,
  Resolution,
  ReviewCandidate,
  ReviewItem,
} from '../api/intakeReview';
import { usePlanScope } from '../api/usePlan';
import { useResolveSubmission, useReviewQueue } from '../api/useReviewQueue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ToastMessage from '../components/ToastMessage.vue';
import ToastStack from '../components/ToastStack.vue';
import { formatPeriod } from '../format/period';
import { locale, t } from '../i18n';
import { useRouteParam } from '../router/params';

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const { scope, isPending: scopeIsPending } = usePlanScope(
  orgId,
  festivalId,
  eventId,
);

const { data: queueResult } = useReviewQueue(orgId);
const items = computed(() =>
  queueResult.value?.ok === true ? queueResult.value.value : [],
);
const queueFailed = computed(() => queueResult.value?.ok === false);
const isPending = computed(
  () => scopeIsPending.value || queueResult.value === undefined,
);

const listRoute = computed(() =>
  eventId.value === '' ? 'org-festival-submissions' : 'org-event-submissions',
);
const scopeParams = computed(() =>
  eventId.value === ''
    ? { orgId: orgId.value, festivalId: festivalId.value }
    : { orgId: orgId.value, eventId: eventId.value },
);

// ── Reading an item ────────────────────────────────────────────────────────

/** When it arrived, in the festival's zone (as the submissions page does). */
function receivedLabel(instant: string): string {
  const festival = scope.value?.festival;
  if (festival === undefined || festival === null) {
    return t('submissions.review.received', { date: instant, time: '' });
  }
  const epochMilliseconds = Temporal.Instant.from(instant).epochMilliseconds;
  const options = {
    locale: locale.value,
    timeZone: eventTimeZone(festival.timezone),
  };
  return t('submissions.review.received', {
    date: formatDate(epochMilliseconds, options),
    time: formatTime(epochMilliseconds, options),
  });
}

/** Why it is here, in words. An unknown code is shown as itself rather than
 * dropped: it is still a reason somebody wrote down. */
function reasonLabel(code: string): string {
  switch (code) {
    case 'too_fast':
      return t('submissions.review.reasons.tooFast');
    case 'email_in_use':
      return t('submissions.review.reasons.emailInUse');
    case 'unmappable':
      return t('submissions.review.reasons.unmappable');
    default:
      return code;
  }
}

/** The windows it offered, each on its own day's clock. */
function windowsOf(item: ReviewItem): readonly string[] {
  const days = scope.value?.days ?? [];
  return item.availability.map((window) => {
    const day = days.find((candidate) => candidate.id === window.event_id);
    if (day === undefined) {
      return `${window.start} – ${window.end}`;
    }
    const display = formatPeriod(window, day.timezone, locale.value);
    return t('submissions.review.window', {
      day: day.name,
      date: display.startDate,
      start: display.startTime,
      end: display.endTime,
    });
  });
}

/** The evidence for a candidate, plainest first. */
function evidenceOf(candidate: ReviewCandidate): readonly string[] {
  const evidence = [
    t('submissions.review.similarity', {
      percent: Math.round(candidate.score * 100),
    }),
  ];
  if (candidate.last_name_agrees) {
    evidence.push(t('submissions.review.sameLastName'));
  }
  if (candidate.phone_agrees) {
    evidence.push(t('submissions.review.samePhone'));
  }
  return evidence;
}

/** `reconcile` only makes sense for something never compared with the pool:
 * one with candidates already has its answer on screen. */
function canReconcile(item: ReviewItem): boolean {
  return (
    item.claimed !== null &&
    item.claimed !== undefined &&
    item.candidates.length === 0
  );
}

// ── Deciding ───────────────────────────────────────────────────────────────

const resolve = useResolveSubmission(orgId);
/** The submission a request is in flight for, so only its buttons wait. */
const busyId = ref<string | null>(null);
const notice = ref<string | null>(null);
const rejection = ref<string | null>(null);

function rejectionText(value: ResolveRejection): string {
  switch (value.reason) {
    case 'conflict':
      return t('submissions.review.errors.conflict');
    case 'unavailable':
      return t('submissions.review.errors.unavailable');
    case 'invalid':
    case 'forbidden':
    case 'refused':
      return value.detail;
  }
}

async function decide(
  item: ReviewItem,
  resolution: Resolution,
): Promise<boolean> {
  busyId.value = item.id;
  notice.value = null;
  rejection.value = null;
  try {
    const result = await resolve.mutateAsync({
      submissionId: item.id,
      resolution,
    });
    if (!result.ok) {
      rejection.value = rejectionText(result.rejection);
      return false;
    }
    const name = item.claimed?.display_name ?? '';
    const { state, email_withheld: emailWithheld } = result.resolved;
    notice.value =
      state === 'rejected'
        ? t('submissions.review.done.rejected', { name })
        : state === 'needs_review'
          ? t('submissions.review.done.stillWaiting', { name })
          : emailWithheld
            ? t('submissions.review.done.appliedWithoutEmail', { name })
            : t('submissions.review.done.applied', { name });
    return true;
  } finally {
    busyId.value = null;
  }
}

// Rejecting is the one decision that throws a volunteer's answers away from
// the plan, so it asks first — and asks why, for whoever looks at it next.
const rejecting = ref<ReviewItem | null>(null);
const rejectReason = ref('');

function askReject(item: ReviewItem): void {
  rejecting.value = item;
  rejectReason.value = '';
}

async function confirmReject(): Promise<void> {
  const item = rejecting.value;
  if (item === null) {
    return;
  }
  await decide(item, { action: 'reject', reason: rejectReason.value });
  rejecting.value = null;
}

function reasonInput(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement) {
    rejectReason.value = target.value;
  }
}
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else>
    <p class="evp-back">
      <RouterLink :to="{ name: listRoute, params: scopeParams }">
        {{ t('submissions.review.back') }}
      </RouterLink>
    </p>
    <h2 class="evp-review-title">{{ t('submissions.review.title') }}</h2>

    <p v-if="queueFailed" role="alert" class="evp-error">
      {{ t('submissions.review.loadFailed') }}
    </p>

    <template v-else>
      <p class="evp-lede">
        {{ t('submissions.review.lede', { count: items.length }) }}
      </p>
      <p v-if="items.length === 0" class="evp-muted">
        {{ t('submissions.review.empty') }}
      </p>

      <ol class="evp-review-list">
        <li
          v-for="item in items"
          :key="item.id"
          class="evp-review-item"
          :aria-labelledby="`review-${item.id}`"
        >
          <header class="evp-review-head">
            <h3 :id="`review-${item.id}`">
              {{
                item.claimed?.display_name ?? t('submissions.review.unnamed')
              }}
            </h3>
            <p class="evp-muted">{{ receivedLabel(item.received_at) }}</p>
            <ul class="evp-reasons" :aria-label="t('submissions.review.why')">
              <li
                v-for="reason in item.reasons"
                :key="`${reason.field}:${reason.code}`"
                class="evp-reason"
              >
                {{ reasonLabel(reason.code) }}
              </li>
              <li v-if="item.candidates.length > 0" class="evp-reason">
                {{
                  t('submissions.review.reasons.similar', {
                    count: item.candidates.length,
                  })
                }}
              </li>
            </ul>
          </header>

          <div class="evp-review-sides">
            <section
              class="evp-side"
              :aria-label="t('submissions.review.sent')"
            >
              <h4>{{ t('submissions.review.sent') }}</h4>
              <dl v-if="item.claimed" class="evp-facts">
                <template v-if="item.claimed.email">
                  <dt>{{ t('submissions.review.email') }}</dt>
                  <dd>{{ item.claimed.email }}</dd>
                </template>
                <template v-if="item.claimed.phone">
                  <dt>{{ t('submissions.review.phone') }}</dt>
                  <dd>{{ item.claimed.phone }}</dd>
                </template>
                <template v-for="answer in item.answers" :key="answer.question">
                  <dt>{{ answer.question }}</dt>
                  <dd>{{ answer.value }}</dd>
                </template>
              </dl>
              <p v-else class="evp-muted">
                {{ t('submissions.review.reasons.unmappable') }}
              </p>
              <h5>{{ t('submissions.review.availability') }}</h5>
              <ul v-if="item.availability.length > 0" class="evp-windows">
                <li v-for="window in windowsOf(item)" :key="window">
                  {{ window }}
                </li>
              </ul>
              <p v-else class="evp-muted">
                {{ t('submissions.review.noAvailability') }}
              </p>
            </section>

            <section
              class="evp-side"
              :aria-label="t('submissions.review.candidates')"
            >
              <h4>{{ t('submissions.review.candidates') }}</h4>
              <p v-if="item.candidates.length === 0" class="evp-muted">
                {{ t('submissions.review.noCandidates') }}
              </p>
              <ul v-else class="evp-candidates">
                <li
                  v-for="candidate in item.candidates"
                  :key="candidate.volunteer_id"
                  class="evp-candidate"
                >
                  <p class="evp-candidate-name">{{ candidate.display_name }}</p>
                  <p v-if="candidate.email" class="evp-muted">
                    {{ candidate.email }}
                  </p>
                  <p v-if="candidate.phone" class="evp-muted">
                    {{ candidate.phone }}
                  </p>
                  <p class="evp-evidence">
                    {{ evidenceOf(candidate).join(' · ') }}
                  </p>
                  <button
                    type="button"
                    class="evp-button evp-button--small"
                    :disabled="busyId !== null || !item.claimed"
                    @click="
                      decide(item, {
                        action: 'match',
                        volunteer_id: candidate.volunteer_id,
                      })
                    "
                  >
                    {{ t('submissions.review.actions.match') }}
                  </button>
                </li>
              </ul>
            </section>
          </div>

          <div class="evp-review-actions">
            <button
              v-if="canReconcile(item)"
              type="button"
              class="evp-button evp-button--primary"
              :disabled="busyId !== null"
              @click="decide(item, { action: 'reconcile' })"
            >
              {{ t('submissions.review.actions.reconcile') }}
            </button>
            <button
              v-if="item.claimed"
              type="button"
              class="evp-button"
              :disabled="busyId !== null"
              @click="decide(item, { action: 'create_new' })"
            >
              {{ t('submissions.review.actions.createNew') }}
            </button>
            <button
              type="button"
              class="evp-button evp-button--danger"
              :disabled="busyId !== null"
              @click="askReject(item)"
            >
              {{ t('submissions.review.actions.reject') }}
            </button>
          </div>
        </li>
      </ol>
    </template>
  </template>

  <ConfirmDialog
    :open="rejecting !== null"
    :title="
      t('submissions.review.rejectDialog.title', {
        name: rejecting?.claimed?.display_name ?? '',
      })
    "
    :confirm-label="t('submissions.review.actions.reject')"
    :busy-label="t('common.status.saving')"
    :busy="busyId !== null"
    :error="rejection"
    @confirm="confirmReject"
    @cancel="rejecting = null"
  >
    <p>{{ t('submissions.review.rejectDialog.body') }}</p>
    <label class="evp-field" for="review-reject-reason">
      <span>{{ t('submissions.review.rejectDialog.reason') }}</span>
      <textarea
        id="review-reject-reason"
        :value="rejectReason"
        maxlength="500"
        rows="3"
        @input="reasonInput"
      />
    </label>
  </ConfirmDialog>

  <ToastStack>
    <ToastMessage
      v-if="rejection !== null && rejecting === null"
      tone="danger"
      dismissible
      @dismiss="rejection = null"
    >
      {{ rejection }}
    </ToastMessage>
    <ToastMessage v-if="notice !== null" dismissible @dismiss="notice = null">
      {{ notice }}
    </ToastMessage>
  </ToastStack>
</template>

<style scoped>
.evp-back {
  margin: 0 0 0.5rem;
}

.evp-review-title {
  font-size: 1.25rem;
  margin: 0 0 0.5rem;
}

.evp-lede {
  color: var(--evp-text-muted);
  margin: 0 0 1rem;
  max-width: 60ch;
}

.evp-muted {
  color: var(--evp-text-muted);
  margin: 0;
}

.evp-error {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  color: var(--evp-danger);
  margin: 0 0 1rem;
  padding: 0.75rem;
}

.evp-review-list {
  display: grid;
  gap: 1rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-review-item {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  padding: 1rem;
}

.evp-review-head h3 {
  font-size: 1.0625rem;
  margin: 0;
}

.evp-reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
}

/* Text, a border and a fill — never colour alone (docs/14 §2). */
.evp-reason {
  background: color-mix(in srgb, var(--evp-warning) 12%, var(--evp-surface));
  border: 1px solid var(--evp-warning);
  border-radius: 999px;
  font-size: 0.8125rem;
  padding: 0.125rem 0.625rem;
}

.evp-review-sides {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  margin: 1rem 0;
}

.evp-side h4 {
  font-size: 0.9375rem;
  margin: 0 0 0.5rem;
}

.evp-side h5 {
  font-size: 0.875rem;
  margin: 0.75rem 0 0.25rem;
}

.evp-facts {
  display: grid;
  gap: 0.25rem 0.75rem;
  grid-template-columns: minmax(8rem, auto) 1fr;
  margin: 0;
}

.evp-facts dt {
  color: var(--evp-text-muted);
}

.evp-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.evp-windows,
.evp-candidates {
  display: grid;
  gap: 0.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-candidate {
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  padding: 0.625rem;
}

.evp-candidate p {
  margin: 0 0 0.25rem;
}

.evp-candidate-name {
  font-weight: 600;
}

.evp-evidence {
  font-size: 0.875rem;
}

.evp-review-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.evp-button--small {
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
}

.evp-button--danger {
  border-color: var(--evp-danger);
  color: var(--evp-danger);
}
</style>
