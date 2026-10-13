// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The frame around a festival or event: its section navigation, the day
 * strip, and the words every page of it uses to describe a period or a status.
 */
export default {
  nav: {
    /** aria-label of the section navigation. */
    label: 'Sections',
    details: 'Détails de l’événement',
    missions: 'Missions',
    shifts: 'Créneaux',
    form: 'Formulaire',
    assignments: 'Affectations',
    submissions: 'Réponses au formulaire',
    availability: 'Disponibilités',
    emails: 'E-mails',
  },
  scope: {
    /** aria-label of the strip that switches between the festival and one of its days. */
    label: 'Périmètre du festival',
    wholeFestival: 'Tout le festival',
  },
  /** Under the selected day’s name: its status, then its URL slug. */
  daySummaryMeta: '{status} · /{slug}',
  festivalFailed:
    'Le festival auquel appartient ce jour n’a pas pu être chargé : seul ce jour est affiché.',
  loadFailed: 'Cette page n’a pas pu être chargée.',
  /**
   * An event’s or festival’s status, as stored. Both nouns are masculine in
   * French. `other` shows the raw value for a status added server-side later.
   */
  status:
    '{status, select, draft {brouillon} planning {en préparation} published {publié} running {en cours} archived {archivé} other {{status}}}',
  period: {
    /** Dates and times arrive pre-formatted in the event’s own timezone. */
    sameDay: '{startDate}, {startTime} – {endTime} ({timeZone})',
    /** A period ending on a later date than it starts (a club night past midnight). */
    acrossDays: '{startDate}, {startTime} – {endDate}, {endTime} ({timeZone})',
    /** A festival’s span, dates only. */
    dates: '{startDate} – {endDate}',
  },
};
