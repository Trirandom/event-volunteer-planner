// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { sharedFr } from '@evp/shared/i18n';

// «tu», as the coordinators' own questions are written (docs/09 §7). A form
// that asks «peux-tu» and then says «Veuillez» reads as two authors.
export default {
  shared: sharedFr,
  productName: 'Event Volunteer Planner',
  form: {
    title: 'Formulaire bénévoles',
    loading: 'Chargement du formulaire…',
    required: 'obligatoire',
    requiredLegend:
      'Les questions marquées « obligatoire » doivent être remplies.',
    yes: 'Oui',
    no: 'Non',
    choose: 'Choisir…',
    noMissions: 'Aucun poste proposé pour l’instant.',
    // Beside a mission's name; the full sentence is the coordinator's to
    // write in the question's help if they want one.
    adultsOnly: '18 ans et +',
    submit: 'Envoyer',
    submitting: 'Envoi en cours…',
    draftRestored:
      'Tes réponses précédentes ont été retrouvées sur cet appareil.',
    draftDiscard: 'Effacer et recommencer',
    // docs/09 §5: a field no human sees. Its label is for the screen reader
    // that does find it, so it says not to fill it.
    honeypot: 'Ne pas remplir ce champ',
    unreachable:
      'Impossible de joindre le serveur. Vérifie ta connexion : tes réponses sont gardées sur cet appareil, tu peux réessayer.',
    retry: 'Réessayer',
  },
  errors: {
    summaryTitle:
      '{count, plural, one {Une réponse est à corriger} other {# réponses sont à corriger}}',
    required: 'Cette question est obligatoire.',
    email:
      'Cette adresse e-mail ne semble pas valide (exemple : prenom@exemple.fr).',
    phone:
      'Ce numéro ne semble pas valide. Chiffres, espaces et « + » acceptés.',
    date: 'Choisis une date.',
    consent: 'Coche cette case pour pouvoir envoyer le formulaire.',
    availabilityRequired: 'Indique au moins un moment où tu es disponible.',
    partialEmpty: 'Choisis au moins un créneau, ou réponds « Non ».',
    stale:
      'Le formulaire a été modifié pendant que tu le remplissais. Il a été rechargé avec tes réponses : vérifie-les puis renvoie.',
    emailTaken:
      'Cette adresse e-mail est déjà utilisée par un·e autre bénévole. Utilise la tienne, ou contacte l’organisation.',
    captcha:
      'La vérification automatique anti-robot n’a pas abouti. Tes réponses sont gardées : recharge la page puis renvoie le formulaire.',
    refused:
      'Le formulaire n’a pas pu être envoyé. Vérifie tes réponses puis réessaie.',
  },
  availability: {
    yes: 'Oui',
    partial: 'En partie',
    no: 'Non',
    // Arguments: the pre-formatted times, docs/16 §6.
    hours: '{start} → {end}',
    nextDay: '(+1)',
    nextDaySpoken: 'le lendemain',
    publicHours: 'Public : {start} → {end}',
    timeZone: 'Horaires en {zone}.',
    allDays: 'Tous les jours de {event} :',
    allDaysSet: '{count, plural, one {# jour} other {# jours}} : {answer}',
    chipsLegend: 'Quand ?',
    part: {
      morning: 'Matin',
      afternoon: 'Après-midi',
      evening: 'Soir',
      night: 'Nuit',
    },
    custom: 'Autre horaire…',
    from: 'De',
    to: 'À',
    timeHint: 'Par exemple 14h30',
    add: 'Ajouter',
    remove: 'Retirer',
    removeSpoken: 'Retirer {start} → {end}',
    selected: 'Disponible :',
    adjusted:
      'Ajusté à {start} → {end} (horaires de l’événement, par tranches de {step} min).',
    unreadable: 'Heure non reconnue. Écris par exemple 14h30 ou 14:30.',
    outside: 'En dehors des horaires ({start} → {end}).',
    status: {
      unset: '{day} : pas de réponse',
      all: '{day} : disponible',
      no: '{day} : pas disponible',
      partial: '{day} : disponible {ranges}',
      partialEmpty: '{day} : en partie, aucun créneau choisi',
    },
    rangeSpoken: 'de {start} à {end}',
  },
  thanks: {
    title: 'Merci !',
    body: 'Tes réponses ont bien été envoyées. L’équipe reviendra vers toi par e-mail.',
    bodyToken:
      'Tes réponses ont bien été enregistrées. Tu peux les modifier à tout moment avec le même lien.',
  },
  unavailable: {
    title: 'Ce lien n’est pas disponible',
    body: 'Ce formulaire n’existe pas, n’est plus ouvert, ou le lien a été révoqué. Contactez l’organisation qui vous l’a envoyé.',
  },
};
