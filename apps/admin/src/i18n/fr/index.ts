// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { sharedFr } from '@evp/shared/i18n';

import common from './common';
import shell from './shell';
import forms from './forms';
import shifts from './shifts';
import board from './board';
import assignments from './assignments';
import availability from './availability';
import submissions from './submissions';
import missions from './missions';
import events from './events';
import plan from './plan';
import home from './home';
import login from './login';
import admin from './admin';
import notFound from './notFound';
import sms from './sms';
import emails from './emails';
import ui from './ui';

/** One file per area of the application; see `../index.ts`. */
export default {
  shared: sharedFr,
  common,
  shell,
  forms,
  shifts,
  board,
  assignments,
  availability,
  submissions,
  missions,
  events,
  plan,
  home,
  login,
  admin,
  notFound,
  sms,
  emails,
  ui,
};
