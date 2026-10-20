// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The backoffice as server state, on `useSmsSettings.ts`'s footing: one
 * cache, invalidated rather than hand-patched after a write.
 *
 * **The key is never part of a query key.** Query keys are what the vue-query
 * devtools list and what a cache dump prints; the key is read inside the query
 * function instead, and a different key cannot see rows cached under the old
 * one because locking removes them all (`useBackofficeLock`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

import {
  backofficeKey,
  clearBackofficeKey,
  setBackofficeKey,
} from '../backoffice/key';
import {
  assignMember,
  createOrganization,
  createUser,
  listMembers,
  listOrganizations,
  listUsers,
  removeMember,
  type BackofficeResult,
  type CreateOrganizationInput,
  type CreateUserInput,
  type Member,
  type MemberRole,
} from './backoffice';

const ROOT = ['backoffice'] as const;

export const backofficeQueryKeys = {
  all: ROOT,
  organizations: [...ROOT, 'organizations'] as const,
  users: [...ROOT, 'users'] as const,
  members: (orgId: string) =>
    [...ROOT, 'organizations', orgId, 'members'] as const,
};

/** What a call made while locked answers. Only reachable by a mutation fired
 * after a lock raced it — the queries are disabled without a key — and
 * `bad-key` sends the view back to the lock form, which is the right place. */
const LOCKED = { ok: false, rejection: { reason: 'bad-key' } } as const;

async function withKey<T>(
  call: (key: string) => Promise<BackofficeResult<T>>,
): Promise<BackofficeResult<T>> {
  const key = backofficeKey.value;
  return key === null ? LOCKED : call(key);
}

const unlocked = computed(() => backofficeKey.value !== null);

/** Unlock, lock, and whether the page is unlocked. */
export function useBackofficeLock() {
  const queryClient = useQueryClient();

  return {
    unlocked,
    unlock: (key: string) => {
      setBackofficeKey(key);
    },
    /** Forgets the key and every row it fetched: a locked page that could
     * still render the account list from cache is not locked. */
    lock: () => {
      clearBackofficeKey();
      queryClient.removeQueries({ queryKey: backofficeQueryKeys.all });
    },
  };
}

export function useBackofficeOrganizations() {
  return useQuery({
    queryKey: backofficeQueryKeys.organizations,
    queryFn: async ({ signal }) =>
      withKey(async (key) => listOrganizations(key, signal)),
    enabled: unlocked,
  });
}

export function useBackofficeUsers() {
  return useQuery({
    queryKey: backofficeQueryKeys.users,
    queryFn: async ({ signal }) =>
      withKey(async (key) => listUsers(key, signal)),
    enabled: unlocked,
  });
}

/** Unreachable while the query is disabled without an organisation; typed
 * so the function still has an honest answer for that case. */
const NO_MEMBERS: BackofficeResult<readonly Member[]> = { ok: true, value: [] };

/** Members of `orgId`, or nothing while no organisation is chosen. */
export function useBackofficeMembers(orgId: MaybeRefOrGetter<string | null>) {
  return useQuery({
    queryKey: computed(() => backofficeQueryKeys.members(toValue(orgId) ?? '')),
    queryFn: async ({ signal }) => {
      const id = toValue(orgId);
      return id === null
        ? NO_MEMBERS
        : withKey(async (key) => listMembers(key, id, signal));
    },
    enabled: computed(() => unlocked.value && toValue(orgId) !== null),
  });
}

/**
 * Every write invalidates the whole backoffice rather than the one list it
 * obviously touches: a membership change moves an organisation's
 * `member_count` and a user's `memberships` as well as the member list, and
 * three lists of a few dozen rows are cheaper to refetch than to keep in
 * step by hand.
 */
function useBackofficeWrite<TInput, TValue>(
  call: (key: string, input: TInput) => Promise<BackofficeResult<TValue>>,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: TInput) =>
      withKey(async (key) => call(key, input)),
    onSuccess: async (result) => {
      if (!result.ok) {
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: backofficeQueryKeys.all,
      });
    },
  });
}

export function useCreateOrganization() {
  return useBackofficeWrite(async (key, input: CreateOrganizationInput) =>
    createOrganization(key, input),
  );
}

export function useCreateUser() {
  return useBackofficeWrite(async (key, input: CreateUserInput) =>
    createUser(key, input),
  );
}

export interface AssignMemberInput {
  readonly orgId: string;
  readonly userId: string;
  readonly role: MemberRole;
}

export function useAssignMember() {
  return useBackofficeWrite(async (key, input: AssignMemberInput) =>
    assignMember(key, input.orgId, input.userId, input.role),
  );
}

export interface RemoveMemberInput {
  readonly orgId: string;
  readonly userId: string;
}

export function useRemoveMember() {
  return useBackofficeWrite(async (key, input: RemoveMemberInput) =>
    removeMember(key, input.orgId, input.userId),
  );
}
