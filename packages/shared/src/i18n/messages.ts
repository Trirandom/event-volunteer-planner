// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The strings of the shared components. Each application mounts these under
 * `shared` in its own catalogue, so both bundles carry them and neither has
 * to know which component needs which.
 */
export const sharedFr = {
  sourceNotice: {
    version: '{product} v{version} ({commit})',
    source: 'code source (AGPL-3.0-or-later)',
    loading: 'Chargement des informations de version…',
    unavailable:
      'Les informations de version sont indisponibles pour le moment.',
  },
  localeSwitcher: {
    label: 'Langue',
  },
  /**
   * The volunteer form's own chrome. Shared because the admin form builder
   * previews it in the *previewed* language, whatever the builder's own is,
   * and must read exactly what a volunteer will.
   */
  volunteerForm: {
    required: 'obligatoire',
    yes: 'Oui',
    no: 'Non',
    choose: 'Choisir…',
    ranges: 'plages horaires à renseigner',
    submit: 'Envoyer',
    noMissions: 'Aucun poste proposé.',
  },
};

export const sharedEn: typeof sharedFr = {
  sourceNotice: {
    version: '{product} v{version} ({commit})',
    source: 'source code (AGPL-3.0-or-later)',
    loading: 'Loading version information…',
    unavailable: 'Version information is currently unavailable.',
  },
  localeSwitcher: {
    label: 'Language',
  },
  volunteerForm: {
    required: 'required',
    yes: 'Yes',
    no: 'No',
    choose: 'Choose…',
    ranges: 'time ranges to fill in',
    submit: 'Send',
    noMissions: 'No missions offered.',
  },
};
