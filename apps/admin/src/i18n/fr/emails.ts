// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The schedule email page: a template, its preview, and what each volunteer
 * would receive. The strings under `message` are written *to volunteers*, in
 * the register the default template uses; everything else is the page.
 */
export default {
  lede: 'Rédigez le message que chaque bénévole recevra avec ses créneaux, puis vérifiez-le personne par personne dans le tableau ci-dessous.',
  /** Shown until publishing (docs/04 §Publishing) is served by the API. */
  notSent:
    'Rien n’est envoyé depuis cette page pour l’instant : l’envoi arrivera avec la publication du planning. Elle sert à vérifier qui recevra quoi.',
  loadFailed:
    'Une partie du planning n’a pas pu être chargée : certains messages ci-dessous peuvent être incomplets.',
  template: {
    heading: 'Modèle',
    label: 'Modèle du message',
    reset: 'Rétablir le modèle par défaut',
    /** Heading of the row of buttons that insert a placeholder. */
    variables: 'Variables',
    /** aria-label of one insert button; `name` is e.g. “{{firstName}}”. */
    insert: 'Insérer {name} dans le modèle',
    hint: '« {example} » utilise la première valeur non vide : le nom du jour pour un jour, celui du festival sinon.',
    /** `names` is a comma-separated list of placeholders as typed. */
    unknown:
      '{count, plural, one {Variable inconnue, laissée telle quelle} other {Variables inconnues, laissées telles quelles}} : {names}',
    /**
     * The template a new page starts from, as the editor writes it
     * (ADR-0046): paragraphs, no `<br>` between them. Every argument is a
     * placeholder chip passed in by the page, so the braces need no ICU
     * quoting here.
     */
    default:
      '<p>Bonjour {firstName},</p><p>Merci pour ton engagement bénévole au {eventOrFestival} !</p><p><strong>Voici tes créneaux bénévoles :</strong></p>{assignations}<p>Si tu as le moindre souci avec l’un des créneaux qui t’a été attribué, merci de nous prévenir en répondant à cet e-mail.</p><p>À bientôt</p><p><strong>L’équipe {organizationName}</strong></p>',
  },
  preview: {
    heading: 'Aperçu',
    recipient: 'Bénévole',
    /** Title of the preview frame, read by screen readers. */
    frame: 'Aperçu du message pour {name}',
    empty:
      'Aucun bénévole inscrit sur cette période : il n’y a personne à qui écrire.',
  },
  table: {
    heading: 'Messages par bénévole',
    caption: 'Message que recevra chaque bénévole',
    region: 'Tableau des messages',
    count:
      '{shown, plural, one {# bénévole affiché} other {# bénévoles affichés}} sur {total}',
    filter: 'Filtrer par nom',
    onlyEmpty: 'Seulement les bénévoles sans créneau',
    columns: {
      name: 'Bénévole',
      shifts: 'Créneaux',
      message: 'Message',
    },
    shiftCount:
      '{count, plural, =0 {Aucun créneau} one {# créneau} other {# créneaux}}',
    /** Button that shows this volunteer's message in the preview. */
    show: 'Aperçu',
    showLabel: 'Afficher le message de {name} dans l’aperçu',
    noMatch: 'Aucun bénévole ne correspond à ce filtre.',
  },
  /** Written to the volunteer. Dates and times arrive formatted in the
   * event’s own timezone. */
  message: {
    line: '{day}, {start}–{end} : {mission}',
    /** A shift lapping midnight: both days are printed. */
    lineAcrossDays: '{day}, {start} – {endDay}, {end} : {mission}',
    none: 'Aucun créneau ne t’a encore été attribué.',
  },
};
