// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/login';

export default {
  title: 'Sign in',
  intro: 'Coordinator access for this deployment.',
  email: 'Email address',
  password: 'Password',
  submit: 'Sign in',
  submitting: 'Signing in…',
  note: 'Accounts are created by invitation. If you have lost your password, ask an organiser — there is no self-service reset in this build.',
  error: {
    unavailable:
      'The server could not be reached. Check your connection and try again.',
    invalidCredentials:
      'That email address and password do not match an account.',
  },
} satisfies typeof fr;
