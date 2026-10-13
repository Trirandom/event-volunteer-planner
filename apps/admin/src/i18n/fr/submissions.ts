// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The submissions page: what volunteers answered on the form. Only the page's
 * own words live here — the answers themselves are volunteer data and are
 * shown as written.
 */
export default {
  standalone: {
    title: 'Aucun formulaire pour cet événement',
    body: 'Les bénévoles s’inscrivent à toute une production, pas à une seule date (docs/09) : le formulaire et ses réponses dépendent donc d’un festival. Cet événement est autonome — rattachez-le à un festival pour lui en donner un.',
  },
  loadFailed: 'Les réponses n’ont pas pu être chargées.',
  lede: {
    festival:
      '{total, plural, one {# réponse} other {# réponses}} pour ce festival. Chaque plage de disponibilité déclarée par chaque bénévole, dans le fuseau horaire de son propre jour.',
    /** `day` is the event the page is narrowed to. “Tout le festival” must
     * match the day strip’s own button. */
    day: 'Sur {total, plural, one {# réponse} other {# réponses}}, {shown, plural, =0 {aucune ne propose} one {# propose} other {# proposent}} du temps sur {day} ; seules ces plages sont affichées. Choisissez « Tout le festival » ci-dessus pour voir le reste.',
  },
  empty: {
    none: 'Personne n’a encore répondu au formulaire. Chargez l’exemple complet depuis la page des événements pour voir à quoi ressemble cette page avec tout un festival de bénévoles.',
    day: 'Personne n’a proposé de temps sur ce jour. Les autres jours totalisent encore {total, plural, one {# réponse} other {# réponses}}.',
  },
  card: {
    /** `date` and `time` are already formatted in the festival’s timezone. */
    submitted: 'Envoyée le {date} à {time}',
    /** Fallback when the festival (and so its timezone) is unknown; `when`
     * is the raw timestamp. */
    submittedAt: 'Envoyée : {when}',
    /** `duration` is e.g. “12 h 30”. */
    total:
      '{duration} proposées sur {days, plural, one {# jour} other {# jours}}',
    noAvailability: 'Aucune disponibilité déclarée — une relance s’impose.',
  },
  /** One availability window. Dates and times arrive formatted, in the
   * event’s own timezone. */
  window: {
    range: '{startDate}, {startTime} – {endTime}',
    /** A window lapping midnight: both dates are printed. */
    rangeAcrossDays: '{startDate}, {startTime} – {endDate}, {endTime}',
    /** `zone` is a timezone abbreviation, e.g. “UTC+2”. */
    duration: '{duration} ({zone})',
  },
  /** The submissions table: one row per volunteer, one column per question. */
  table: {
    /** Visually hidden caption, read by screen readers. */
    caption: 'Réponses des bénévoles',
    /** aria-label of the horizontally scrollable region around the table. */
    region: 'Tableau des réponses',
    columns: {
      name: 'Nom',
      submitted: 'Envoyée',
      availability: 'Disponibilités',
    },
    filter: {
      /** aria-label of each column’s filter; `column` is its header. */
      label: 'Filtrer la colonne « {column} »',
      placeholder: 'Filtrer…',
      /** First option of a picker: no filter. */
      any: 'Toutes',
      /** Availability picker: volunteers who declared nothing usable. */
      none: 'Aucune déclarée',
      /** Availability picker, one option per day; `day` is its name. */
      day: 'Sur {day}',
    },
    /** The live counter above the table. */
    count:
      '{shown, plural, =0 {Aucune réponse affichée} one {# réponse affichée} other {# réponses affichées}} sur {total}',
    reset: 'Effacer les filtres',
    noMatch: 'Aucune réponse ne correspond à ces filtres.',
    /** Availability cell. `duration` is e.g. “12 h 30”. */
    availability: '{duration} · {days, plural, one {# jour} other {# jours}}',
    /** The disclosure button beside it; `count` is the number of windows. */
    showWindows: 'Voir {count, plural, one {la plage} other {les # plages}}',
    hideWindows: 'Masquer',
    noAvailability: 'Aucune — à relancer',
    /** Link at the foot of the expanded panel. */
    editOnBoard: 'Ajuster sur la page Disponibilités',
  },
  /** The review sub-page: submissions that could not join the pool on
   * their own (docs/08 §6). `name` is what the volunteer typed. */
  review: {
    /** The callout on the submissions page. */
    link: '{count, plural, =0 {Aucune réponse à vérifier} one {# réponse à vérifier →} other {# réponses à vérifier →}}',
    back: '← Toutes les réponses',
    title: 'Réponses à vérifier',
    loadFailed: 'Les réponses à vérifier n’ont pas pu être chargées.',
    lede: '{count, plural, =0 {Tout est traité.} one {Une réponse n’a pas pu rejoindre le vivier seule : vérifiez-la ci-dessous.} other {# réponses n’ont pas pu rejoindre le vivier seules : vérifiez-les ci-dessous.}}',
    empty:
      'Chaque réponse reçue a trouvé sa place. Celles qui ressemblent trop à un·e bénévole existant·e, ou qui arrivent trop vite pour un humain, s’afficheront ici.',
    unnamed: 'Réponse illisible',
    /** `date` and `time` are already formatted in the festival’s timezone. */
    received: 'Reçue le {date} à {time}',
    why: 'Pourquoi elle attend',
    reasons: {
      tooFast: 'Envoyée en moins de 3 secondes',
      emailInUse: 'Adresse e-mail déjà utilisée par un·e autre bénévole',
      unmappable: 'Les réponses ne peuvent pas être lues',
      similar:
        '{count, plural, one {Nom proche d’un·e bénévole existant·e} other {Nom proche de # bénévoles existant·es}}',
    },
    sent: 'Ce qui a été envoyé',
    email: 'Adresse e-mail',
    phone: 'Téléphone',
    availability: 'Disponibilités',
    noAvailability: 'Aucune disponibilité déclarée.',
    /** `date`, `start` and `end` are already formatted in the day’s zone. */
    window: '{day} — {date}, {start}–{end}',
    candidates: 'Bénévoles existant·es possibles',
    noCandidates: 'Aucun·e bénévole ne ressemble à cette personne.',
    /** Trigram similarity of the names, as a whole percentage. */
    similarity: 'Nom similaire à {percent} %',
    sameLastName: 'Même nom de famille',
    samePhone: 'Même téléphone',
    actions: {
      match: 'C’est cette personne',
      createNew: 'Nouveau·elle bénévole',
      reconcile: 'Relancer la correspondance',
      reject: 'Rejeter',
    },
    rejectDialog: {
      title: 'Rejeter la réponse de {name} ?',
      body: 'Elle reste enregistrée, mais n’est ajoutée à personne : ni bénévole, ni disponibilités.',
      reason: 'Raison (facultatif, pour l’équipe)',
    },
    done: {
      applied: 'La réponse de {name} a rejoint le vivier.',
      appliedWithoutEmail:
        'La réponse de {name} a rejoint le vivier, sans son adresse e-mail : elle appartient déjà à un·e autre bénévole.',
      rejected: 'La réponse de {name} a été rejetée.',
      stillWaiting:
        'La réponse de {name} ressemble encore à un·e bénévole existant·e : choisissez ci-dessous.',
    },
    errors: {
      conflict:
        'Cette réponse a déjà été traitée par quelqu’un d’autre. La liste a été rechargée.',
      unavailable:
        'Le serveur ne répond pas. Rien n’a été modifié ; réessayez dans un instant.',
    },
  },
  /** A length of time: `12 h 30`, `7 h`, `45 min`. Also used by the
   * availability board. */
  duration: {
    minutes: '{minutes} min',
    hours: '{hours} h',
    hoursMinutes: '{hours} h {minutes}',
  },
};
