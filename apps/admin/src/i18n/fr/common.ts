// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Words used identically on many screens. Only what is *genuinely* the same
 * message belongs here: "Enregistrer" on a form and "Enregistrer" as a noun
 * in a table header are two keys, because another language may need two
 * words for them.
 */
export default {
  /** A name, not translated; a key so templates hold no bare text. */
  productName: 'Event Volunteer Planner',
  actions: {
    save: 'Enregistrer',
    cancel: 'Annuler',
    close: 'Fermer',
    delete: 'Supprimer',
    edit: 'Modifier',
    retry: 'Réessayer',
    undo: 'Annuler',
  },
  status: {
    loading: 'Chargement…',
    saving: 'Enregistrement…',
    loadFailed: 'Le chargement a échoué.',
  },
};
