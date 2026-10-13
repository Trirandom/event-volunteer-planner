// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { sharedEn } from '@evp/shared/i18n';

import type fr from '../fr';
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

// `satisfies` rather than an annotation: a key missing here, or one French
// does not have, is a type error naming the key (docs/16 §7).
export default {
  shared: sharedEn,
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
} satisfies typeof fr;
