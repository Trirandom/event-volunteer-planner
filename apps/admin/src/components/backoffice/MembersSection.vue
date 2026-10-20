<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Who belongs to one organisation, and as what — the part of the backoffice
 * that is its reason to exist (ADR-0045: a festival run by an organisation
 * that is not the bootstrap one, with several coordinators to add).
 *
 * Changing a role and adding a member are the same `PUT`, which is idempotent
 * on the server; the row's select and the form below are two ways to send it,
 * kept as two mutations so each reports its outcome beside the control that
 * caused it.
 */
import { computed, ref, useId } from 'vue';

import {
  DEFAULT_MEMBER_ROLE,
  MEMBER_ROLES,
  type BackofficeRejection,
  type BackofficeUser,
  type Member,
  type MemberRole,
  type Organization,
} from '../../api/backoffice';
import {
  useAssignMember,
  useBackofficeMembers,
  useRemoveMember,
} from '../../api/useBackoffice';
import { rejectionMessage, roleLabel } from '../../backoffice/messages';
import { t } from '../../i18n';
import ConfirmDialog from '../ConfirmDialog.vue';

const props = defineProps<{
  readonly organizations: readonly Organization[];
  readonly users: readonly BackofficeUser[];
}>();
const emit = defineEmits<{ rejected: [rejection: BackofficeRejection] }>();

const headingId = useId();

/** `''` is the select's "choose one" option; `null` is what the query and
 * every message below need to mean "none chosen". */
const selectedOrgId = ref('');
const orgId = computed(() =>
  selectedOrgId.value === '' ? null : selectedOrgId.value,
);
const organization = computed(
  () => props.organizations.find((org) => org.id === orgId.value) ?? null,
);

const { data: members, isPending: membersPending } =
  useBackofficeMembers(orgId);

const rows = computed(() =>
  members.value?.ok === true ? members.value.value : [],
);
const loadError = computed(() =>
  members.value === undefined || members.value.ok
    ? null
    : rejectionMessage(members.value.rejection),
);

/** A select's value, as a role — parsed rather than asserted, so a value this
 * page never offered cannot reach the server typed as one. */
function roleOf(value: string): MemberRole | null {
  return MEMBER_ROLES.find((role) => role === value) ?? null;
}

function reportRejection(rejection: BackofficeRejection): void {
  emit('rejected', rejection);
}

// ── Changing a role from its row ─────────────────────────────────────────
const rowWrite = useAssignMember();
const rowMessage = ref<{
  readonly kind: 'status' | 'error';
  readonly text: string;
} | null>(null);

function changeRole(member: Member, event: Event): void {
  const id = orgId.value;
  if (id === null || !(event.target instanceof HTMLSelectElement)) {
    return;
  }
  const role = roleOf(event.target.value);
  if (role === null || role === member.role) {
    return;
  }
  rowMessage.value = null;
  rowWrite.mutate(
    { orgId: id, userId: member.user_id, role },
    {
      onSuccess: (outcome) => {
        if (!outcome.ok) {
          rowMessage.value = {
            kind: 'error',
            text: rejectionMessage(outcome.rejection),
          };
          reportRejection(outcome.rejection);
          return;
        }
        rowMessage.value = {
          kind: 'status',
          text: t('backoffice.members.assign.done', {
            name: memberName(outcome.value),
            role: roleLabel(outcome.value.role),
          }),
        };
      },
    },
  );
}

function memberName(member: Member): string {
  return member.display_name === '' ? member.email : member.display_name;
}

// ── Removing ─────────────────────────────────────────────────────────────
const removal = useRemoveMember();
const removing = ref<Member | null>(null);
const removeError = ref<string | null>(null);

function askRemove(member: Member): void {
  removeError.value = null;
  removing.value = member;
}

function cancelRemove(): void {
  removing.value = null;
}

function confirmRemove(): void {
  const member = removing.value;
  const id = orgId.value;
  if (member === null || id === null) {
    return;
  }
  removal.mutate(
    { orgId: id, userId: member.user_id },
    {
      onSuccess: (outcome) => {
        if (!outcome.ok) {
          // Left open with the reason under the question, as
          // `ConfirmDialog` expects of a refusal.
          removeError.value = rejectionMessage(outcome.rejection);
          reportRejection(outcome.rejection);
          return;
        }
        removing.value = null;
        rowMessage.value = {
          kind: 'status',
          text: t('backoffice.members.removed', { name: memberName(member) }),
        };
      },
    },
  );
}

// ── Adding ───────────────────────────────────────────────────────────────
const assignWrite = useAssignMember();
const assignUserId = ref('');
const assignRole = ref<MemberRole>(DEFAULT_MEMBER_ROLE);

const assignError = computed(() => {
  const outcome = assignWrite.data.value;
  return outcome === undefined || outcome.ok
    ? null
    : rejectionMessage(outcome.rejection);
});
const assignDone = computed(() => {
  const outcome = assignWrite.data.value;
  return outcome?.ok === true
    ? t('backoffice.members.assign.done', {
        name: memberName(outcome.value),
        role: roleLabel(outcome.value.role),
      })
    : null;
});

function assign(): void {
  const id = orgId.value;
  if (id === null || assignUserId.value === '') {
    return;
  }
  assignWrite.reset();
  assignWrite.mutate(
    { orgId: id, userId: assignUserId.value, role: assignRole.value },
    {
      onSuccess: (outcome) => {
        if (!outcome.ok) {
          reportRejection(outcome.rejection);
          return;
        }
        assignUserId.value = '';
        assignRole.value = DEFAULT_MEMBER_ROLE;
      },
    },
  );
}

/** A new organisation chosen: the last one's outcomes are about rows no
 * longer on screen. */
function onOrganizationChange(): void {
  rowMessage.value = null;
  assignWrite.reset();
  assignUserId.value = '';
}
</script>

<template>
  <section class="evp-section" :aria-labelledby="headingId">
    <h2 :id="headingId">{{ t('backoffice.members.heading') }}</h2>

    <p class="evp-field evp-org-picker">
      <label for="backoffice-members-org">
        <span>{{ t('backoffice.members.organization') }}</span>
        <select
          id="backoffice-members-org"
          v-model="selectedOrgId"
          @change="onOrganizationChange"
        >
          <option value="">
            {{ t('backoffice.members.chooseOrganization') }}
          </option>
          <option v-for="org in organizations" :key="org.id" :value="org.id">
            {{ org.name }}
          </option>
        </select>
      </label>
    </p>

    <p v-if="orgId === null" class="evp-muted">
      {{ t('backoffice.members.pick') }}
    </p>

    <template v-else>
      <p v-if="rowMessage?.kind === 'error'" role="alert" class="evp-error">
        {{ rowMessage.text }}
      </p>
      <p
        v-else-if="rowMessage?.kind === 'status'"
        role="status"
        class="evp-status"
      >
        {{ rowMessage.text }}
      </p>

      <p v-if="membersPending">{{ t('common.status.loading') }}</p>
      <p v-else-if="loadError !== null" role="alert" class="evp-error">
        {{ loadError }}
      </p>
      <p v-else-if="rows.length === 0" class="evp-muted">
        {{ t('backoffice.members.empty') }}
      </p>
      <div v-else class="evp-table-scroll">
        <table class="evp-table" :aria-labelledby="headingId">
          <thead>
            <tr>
              <th scope="col">{{ t('backoffice.members.columns.member') }}</th>
              <th scope="col">{{ t('backoffice.members.columns.role') }}</th>
              <th scope="col" class="evp-row-actions">
                {{ t('backoffice.members.columns.actions') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in rows" :key="member.user_id">
              <th scope="row">
                {{ memberName(member) }}
                <span class="evp-muted evp-email">{{ member.email }}</span>
              </th>
              <td>
                <select
                  :value="member.role"
                  :aria-label="
                    t('backoffice.members.roleOf', { name: memberName(member) })
                  "
                  :disabled="rowWrite.isPending.value"
                  @change="changeRole(member, $event)"
                >
                  <option
                    v-for="role in MEMBER_ROLES"
                    :key="role"
                    :value="role"
                  >
                    {{ roleLabel(role) }}
                  </option>
                </select>
              </td>
              <td class="evp-row-actions">
                <button
                  type="button"
                  class="evp-button"
                  :aria-label="
                    t('backoffice.members.removeLabel', {
                      name: memberName(member),
                    })
                  "
                  @click="askRemove(member)"
                >
                  {{ t('backoffice.members.remove') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <form class="evp-panel evp-create" @submit.prevent="assign">
        <h3>{{ t('backoffice.members.assign.heading') }}</h3>

        <p v-if="assignError !== null" role="alert" class="evp-error">
          {{ assignError }}
        </p>
        <p v-else-if="assignDone !== null" role="status" class="evp-status">
          {{ assignDone }}
        </p>

        <p class="evp-field">
          <label for="backoffice-assign-user">
            <span>{{ t('backoffice.members.assign.user') }}</span>
            <select id="backoffice-assign-user" v-model="assignUserId" required>
              <option value="">
                {{ t('backoffice.members.assign.chooseUser') }}
              </option>
              <option v-for="user in users" :key="user.id" :value="user.id">
                {{ user.display_name }} — {{ user.email }}
              </option>
            </select>
          </label>
        </p>

        <p class="evp-field">
          <label for="backoffice-assign-role">
            <span>{{ t('backoffice.members.assign.role') }}</span>
            <select id="backoffice-assign-role" v-model="assignRole">
              <option v-for="role in MEMBER_ROLES" :key="role" :value="role">
                {{ roleLabel(role) }}
              </option>
            </select>
          </label>
        </p>

        <button
          class="evp-button evp-button--primary"
          type="submit"
          :disabled="assignWrite.isPending.value"
        >
          {{
            assignWrite.isPending.value
              ? t('backoffice.members.assign.submitting')
              : t('backoffice.members.assign.submit')
          }}
        </button>
      </form>
    </template>

    <ConfirmDialog
      :open="removing !== null"
      :title="
        t('backoffice.members.confirm.title', {
          name: removing === null ? '' : memberName(removing),
          organization: organization?.name ?? '',
        })
      "
      :confirm-label="
        t('backoffice.members.confirm.action', {
          name: removing === null ? '' : memberName(removing),
        })
      "
      :busy-label="t('backoffice.members.confirm.busy')"
      :busy="removal.isPending.value"
      :error="removeError"
      @confirm="confirmRemove"
      @cancel="cancelRemove"
    >
      <p>{{ t('backoffice.members.confirm.body') }}</p>
    </ConfirmDialog>
  </section>
</template>

<style scoped src="./section.css"></style>

<style scoped>
.evp-org-picker {
  max-width: 32rem;
}

.evp-email {
  display: block;
  font-weight: 400;
}
</style>
