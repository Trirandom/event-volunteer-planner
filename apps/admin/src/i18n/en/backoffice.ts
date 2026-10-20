// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/backoffice';

export default {
  title: 'Backoffice',
  intro:
    'Organisations, accounts and memberships across this whole deployment. For the operator only: access is by the EVP_BACKOFFICE_KEY key, not by a session.',
  lock: {
    heading: 'Unlock',
    key: 'Backoffice key',
    keyHint:
      'The key is kept in memory in this tab only; reloading the page forgets it.',
    unlock: 'Unlock',
    unlocking: 'Checking…',
    lock: 'Lock',
    badKey: 'That key is not the right one.',
    disabled:
      'The backoffice is not enabled on this deployment (EVP_BACKOFFICE_KEY is not set).',
    rateLimited: 'Too many attempts. Wait a moment before trying again.',
  },
  roles: {
    owner: 'Owner',
    coordinator: 'Coordinator',
    zone_lead: 'Zone lead',
  },
  organizations: {
    heading: 'Organisations',
    empty: 'No organisations yet.',
    columns: {
      name: 'Name',
      slug: 'Slug',
      timezone: 'Time zone',
      members: 'Members',
    },
    create: {
      heading: 'New organisation',
      name: 'Name',
      slug: 'Slug (used in addresses)',
      slugHint:
        'Lowercase letters, digits and hyphens, 3 to 40 characters; suggested from the name.',
      timezone: 'Time zone',
      submit: 'Create organisation',
      submitting: 'Creating…',
      created: 'Organisation “{name}” created.',
    },
  },
  users: {
    heading: 'Accounts',
    empty: 'No accounts yet.',
    columns: {
      email: 'Email address',
      displayName: 'Display name',
      lastLogin: 'Last sign-in',
      memberships: 'Organisations',
    },
    neverSignedIn: 'never',
    lastLoginAt: '{date} at {time} UTC',
    membership: '{name} ({role})',
    noMembership: 'none',
    create: {
      heading: 'New account',
      email: 'Email address',
      displayName: 'Display name',
      password: 'Password',
      passwordHint:
        'At least 12 characters. Pass it on to the person over a safe channel.',
      submit: 'Create account',
      submitting: 'Creating…',
      created: 'Account {email} created.',
    },
  },
  members: {
    heading: 'Members of an organisation',
    organization: 'Organisation',
    chooseOrganization: 'Choose an organisation…',
    pick: 'Choose an organisation to see its members.',
    empty: 'This organisation has no members yet.',
    columns: {
      member: 'Member',
      role: 'Role',
      actions: 'Actions',
    },
    roleOf: 'Role of {name}',
    remove: 'Remove',
    removeLabel: 'Remove {name}',
    confirm: {
      title: 'Remove {name} from {organization}?',
      body: 'They lose access to this organisation immediately. Their account is kept.',
      action: 'Remove {name}',
      busy: 'Removing…',
    },
    assign: {
      heading: 'Add an account',
      user: 'Account',
      chooseUser: 'Choose an account…',
      role: 'Role',
      submit: 'Add',
      submitting: 'Adding…',
      done: '{name} is now {role}.',
    },
    removed: '{name} is no longer a member.',
  },
  error: {
    unavailable:
      'The server could not be reached. Check your connection and try again.',
    loadFailed: 'Loading failed.',
    rateLimited: 'Too many requests. Wait a moment before trying again.',
    notFound: 'Not found: {detail}',
  },
} satisfies typeof fr;
