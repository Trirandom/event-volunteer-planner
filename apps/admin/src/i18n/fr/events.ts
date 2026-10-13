// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The events list and its create form, the "add a day" form, and the event
 * details section with one settings card per event.
 */
export default {
  list: {
    title: 'Événements',
    create: {
      heading: 'Ajouter au planning',
      /** Button that opens the creation form. */
      newEvent: 'Nouvel événement',
      newFestival: 'Nouveau festival',
      name: 'Nom',
      slug: 'Identifiant d’URL (slug)',
      timezone: 'Fuseau horaire (nom IANA, p. ex. Europe/Paris)',
      starts: 'Début',
      ends: 'Fin',
      festival: 'Festival',
      /** First option of the festival picker. */
      noFestival: 'Aucun festival — événement indépendant',
      creating: 'Création…',
      createEvent: 'Créer l’événement',
      createFestival: 'Créer le festival',
    },
    example: {
      loading: 'Chargement de l’exemple…',
      loadFestival: 'Charger le festival d’exemple',
      loadEvent: 'Charger l’événement d’exemple',
      /** Toast after the worked example was loaded; `name` is the loaded festival or event. */
      loaded:
        '{kind, select, festival {Festival d’exemple « {name} » chargé.} other {Événement d’exemple « {name} » chargé.}}',
      /** Toast when someone else loaded the example first (HTTP 409); not an error. */
      conflict:
        '{kind, select, festival {Une autre personne de l’équipe de coordination a déjà chargé un festival pour cette organisation — il est affiché ci-dessous.} other {Une autre personne de l’équipe de coordination a déjà chargé un événement pour cette organisation — il est affiché ci-dessous.}}',
    },
    unavailable:
      'Le serveur est injoignable. Vérifiez votre connexion et réessayez.',
    loadFailed: 'Le serveur est injoignable : rien n’a pu être chargé.',
    festivalsFailed:
      'Les festivals n’ont pas pu être chargés : les événements sont listés sans leur festival.',
    empty: {
      heading: 'Rien de prévu pour l’instant',
      body: 'Un événement est ce sur quoi les bénévoles reçoivent des créneaux ; un festival regroupe plusieurs événements sous une même bannière. Utilisez le formulaire ci-dessus — ou l’un de ses boutons « charger l’exemple » — pour voir comment le planificateur est censé être utilisé.',
    },
    upcoming: 'À venir',
    past: 'Passés',
    /** Appended to a finished event’s row, after its status. */
    finished: '· terminé',
    noEventsYet: 'Aucun événement pour l’instant.',
    noEvents: 'Aucun événement.',
  },
  newEvent: {
    /** Button; the page is a standalone event. */
    addAnotherEvent: 'Ajouter un autre événement',
    /** Button; the page is a festival or one of its days. */
    addDayButton: 'Ajouter un jour',
    headingEvent: 'Nouvel événement',
    headingDay: 'Nouveau jour',
    /** `production` is the standalone event’s name. */
    hintStandalone:
      'Un deuxième événement à côté de {production}, indépendant comme lui. Ses horaires lui sont propres ; rien n’est recopié.',
    /** `production` is the festival’s name. */
    hintDay:
      'Un jour de plus pour {production}. Il rejoint la barre ci-dessus, reçoit sa propre couleur, et son planning est géré indépendamment des autres jours.',
    name: 'Nom',
    slug: 'Identifiant d’URL (slug)',
    slugHint:
      'Le nom du jour dans une URL. Rempli à partir du nom tant que vous ne le modifiez pas.',
    timezone: 'Fuseau horaire',
    /** `production` is the festival or event the zone was taken from. */
    timezoneHint:
      'L’horloge propre au jour, dans laquelle les deux heures ci-dessous sont lues. Repris de {production} ; changez-le pour un jour qui se déroule ailleurs.',
    starts: 'Début',
    ends: 'Fin',
    periodHint:
      'Tout ce que couvre le jour, montage et démontage compris — les mêmes horaires de travail que ceux des cartes ci-dessous. Les heures d’ouverture au public se règlent ensuite, sur la carte du jour.',
    problem: {
      nameMissing:
        'Donnez un nom au jour — « Samedi », « Open Air », « Nuit 2 ».',
      slugMissing:
        'Le jour a besoin d’un identifiant pour son URL. Il est rempli à partir du nom ; saisissez-en un si le nom ne permet pas d’en tirer un.',
      slugTaken:
        'Cette production a déjà un jour avec cet identifiant. L’identifiant forme l’URL : il doit être différent même quand deux jours portent le même nom.',
      timezoneUnknown:
        'Ce n’est pas un nom de fuseau horaire IANA. Utilisez la forme Europe/Paris.',
      startMissing: 'Indiquez quand le jour commence.',
      endMissing: 'Indiquez quand le jour se termine.',
      periodInverted:
        'Le jour doit se terminer après son début. Une nuit qui dépasse minuit se termine à la date suivante — c’est normal.',
    },
    unavailable: 'Le serveur est injoignable : rien n’a été créé.',
    /** `name` is the day or event just created. */
    created: '{name} ajouté.',
    adding: 'Ajout…',
    addEvent: 'Ajouter l’événement',
    addDay: 'Ajouter le jour',
    /** Button that closes the form. */
    done: 'Terminé',
  },
  details: {
    /** `timeZone` is the event’s zone label, e.g. "CEST". */
    zone: '{timeZone} · les heures ci-dessous suivent l’horloge locale de cet événement',
    workingHours: 'Horaires de travail',
    starts: 'Début',
    ends: 'Fin',
    doors: 'Ouverture au public',
    doorsOpen: 'Ouverture',
    doorsClose: 'Fermeture',
    clearDoors: 'Ne publier aucun horaire d’ouverture',
    colour: 'Couleur',
    /** Screen-reader name of a colour swatch; `retained` is "yes" for a colour only this event still holds. */
    swatch:
      '{retained, select, yes {Couleur {index} (couleur actuelle de cet événement)} other {Couleur {index}}}',
    problem: {
      startMissing: 'Indiquez la date et l’heure de début de l’événement.',
      endMissing: 'Indiquez la date et l’heure de fin de l’événement.',
      periodInverted: 'L’événement doit se terminer après son début.',
      doorsHalfStated:
        'Les horaires d’ouverture vont par paire. Remplissez les deux, ou videz les deux pour n’en publier aucun.',
      doorsInverted: 'La fermeture doit avoir lieu après l’ouverture.',
      doorsOutsidePeriod:
        'L’ouverture au public a lieu pendant l’événement : elle ne peut pas commencer avant son début ni finir après sa fin. Élargissez d’abord l’événement.',
    },
    /** `detail` is the server’s own sentence about the edit that won. */
    conflict:
      '{detail} Rechargez la page pour récupérer la dernière version avant de modifier à nouveau.',
    saveUnavailable: 'Le serveur est injoignable : rien n’a été enregistré.',
    deleteUnavailable: 'Le serveur est injoignable : rien n’a été supprimé.',
    saved: 'Enregistré.',
    saveChanges: 'Enregistrer les modifications',
    /** Button: throw away unsaved edits. */
    discard: 'Abandonner',
    delete: 'Supprimer cet événement',
    deleteHint:
      'L’archivage garde lisible un planning publié ; la suppression, non. Réservez ceci à un événement qui n’aurait jamais dû exister.',
    deleteConfirm:
      'Supprimer {name} et tout ce qui y est planifié ? Cette action est irréversible.',
    deleting: 'Suppression…',
    confirmDelete: 'Oui, supprimer',
    keep: 'Conserver',
  },
  detailsPage: {
    helpTitle: 'Détails de l’événement',
    allDays:
      'Tous les jours de ce festival. Choisissez-en un dans la barre ci-dessus pour travailler sur lui seul.',
    /** Help entries: a bold term, then its explanation after a dash. */
    help: {
      workingHoursTerm: 'Horaires de travail',
      workingHours:
        'tout ce que couvre l’événement, montage et démontage compris. Chaque créneau doit y tenir.',
      doorsTerm: 'Ouverture au public',
      doors:
        'quand l’événement est ouvert au public, si c’est décidé. Facultatif et jamais deviné : laissez les deux champs vides pour n’en publier aucun.',
      colourTerm: 'Couleur',
      colour:
        'la façon dont un événement est dessiné partout où il apparaît à côté d’un autre : la barre des jours ci-dessus, et chaque pastille qui le nomme. Chaque couleur proposée reste lisible avec un texte noir comme blanc.',
    },
    noDays:
      'Ce festival n’a encore aucun jour : il n’y a rien à configurer. Ajoutez le premier ci-dessous.',
  },
};
