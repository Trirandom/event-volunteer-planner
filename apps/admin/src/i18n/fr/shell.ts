// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** The application frame: header, navigation, skip link. */
export default {
  skipToContent: 'Aller au contenu',
  nav: {
    label: 'Navigation principale',
    events: 'Événements',
    sms: 'Configuration SMS',
    /** Shown only to a user with no organisation to name in the header. */
    admin: 'Administration',
    signIn: 'Se connecter',
  },
  /** The organisation being worked in, at the left of the header. */
  org: {
    /** A small label above the organisation’s name. */
    label: 'Organisation',
  },
};
