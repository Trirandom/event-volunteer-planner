// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The schedule email page: a template, its preview, and what each volunteer
 * would receive. The strings under `message` are written *to volunteers*, in
 * the register the default template uses; everything else is the page.
 */
export default {
  lede: 'Rédigez le message que chaque bénévole recevra avec ses créneaux, puis vérifiez-le personne par personne dans le tableau ci-dessous.',
  /** Shown until publishing (docs/04 §Publishing) is served by the API;
   * only the test send is (ADR-0054). */
  notSent:
    'Aucun bénévole ne reçoit rien depuis cette page pour l’instant : l’envoi réel arrivera avec la publication du planning. L’envoi de test, lui, fait partir chaque message vers votre adresse.',
  loadFailed:
    'Une partie du planning n’a pas pu être chargée : certains messages ci-dessous peuvent être incomplets.',
  template: {
    heading: 'Modèle',
    /** The subject line field. Placeholders work in it as in the body. */
    subject: 'Objet',
    /** `eventOrFestival` is the placeholder as typed, with its braces. */
    subjectDefault: 'Tes créneaux bénévoles – {eventOrFestival}',
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
  /** Sending the whole run to one address of the coordinator's choosing
   * (ADR-0054). */
  test: {
    heading: 'Envoi de test',
    address: 'Adresse de test',
    placeholder: 'vous@exemple.fr',
    send: 'Envoyer le test',
    sending: 'Envoi en cours…',
    hint: '{count, plural, one {Le message de # bénévole part} other {Les messages des # bénévoles partent}} vers cette adresse et nulle part ailleurs, rendus par le serveur exactement comme ils le seront à l’envoi. Leur objet commence par « [Test: nom] ».',
    invalidAddress: 'Saisissez une seule adresse e-mail.',
    sent: '{sent, plural, =0 {Aucun message envoyé} one {# message envoyé} other {# messages envoyés}} à {address}.',
    optedOut:
      '{count, plural, one {# bénévole a refusé les e-mails : il n’en recevra pas} other {# bénévoles ont refusé les e-mails : ils n’en recevront pas}}.',
    noAddress:
      '{count, plural, one {Sans adresse e-mail, à prévenir autrement} other {Sans adresse e-mail, à prévenir autrement}} : {names}',
    /** The run stopped at the first failure; `name` is whose message it was. */
    stopped: {
      refused: 'Le serveur d’e-mail a refusé le message de {name} : {detail}',
      relay_unavailable:
        'Le serveur d’e-mail est injoignable : l’envoi s’est arrêté au message de {name}. Réessayez plus tard.',
      render_failed: 'Le message de {name} n’a pas pu être composé : {detail}',
    },
    failed: {
      invalid: 'L’envoi a été refusé : {detail}',
      forbidden: 'Seuls les coordinateurs peuvent envoyer un test.',
      refused: 'L’envoi a été refusé : {detail}',
      unavailable: 'Le serveur ne répond pas. Réessayez dans un instant.',
    },
  },
  /** The formatting buttons above the template, and the link form. */
  editor: {
    toolbar: 'Mise en forme',
    bold: 'Gras',
    italic: 'Italique',
    underline: 'Souligné',
    bulletList: 'Liste à puces',
    orderedList: 'Liste numérotée',
    link: 'Lien',
    undo: 'Annuler',
    redo: 'Rétablir',
    linkUrl: 'Adresse du lien',
    linkPlaceholder: 'https://',
    linkApply: 'Appliquer',
    linkRemove: 'Retirer le lien',
    linkCancel: 'Fermer',
    linkInvalid:
      'Seules les adresses web (https://…) et e-mail (mailto:…) peuvent être liées dans un message.',
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
    /** Heads one event's shifts on one night (ADR-0055): the event's
     * name, then the day the night belongs to. */
    heading: '{event} – {weekday} {date}',
    /** A shift under its heading. One lapping midnight names no second
     * day: the heading already says which night it is. */
    hours: '{start}–{end} : {mission}',
    /** A shift read on its own, outside any heading. */
    line: '{heading}, {hours}',
    none: 'Aucun créneau ne t’a encore été attribué.',
  },
};
