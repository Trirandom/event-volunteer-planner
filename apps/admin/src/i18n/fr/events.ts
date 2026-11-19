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
    /** A small label above each card's name, saying which of the two it is. */
    kind: {
      festival: 'Festival',
      event: 'Événement',
    },
  },
  newEvent: {
    /** Button; the page is a standalone event. */
    addAnotherEvent: 'Ajouter un autre événement',
    /** Button; a festival card on the events list. */
    addEventToFestival: 'Ajouter un événement',
    /** Button; the page is a festival or one of its days. */
    addDayButton: 'Ajouter un jour',
    headingEvent: 'Nouvel événement',
    headingDay: 'Nouveau jour',
    /** `production` is the standalone event’s name. */
    hintStandalone:
      'Un deuxième événement à côté de {production}, indépendant comme lui. Ses horaires lui sont propres ; rien n’est recopié.',
    /** `production` is the festival’s name; shown on the events list. */
    hintFestivalEvent:
      'Un nouvel événement dans {production}. Ses horaires lui sont propres, et son planning est géré indépendamment des autres événements du festival.',
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
      'Ce festival n’a encore aucun jour : il n’y a rien à configurer. Ajoutez le premier ci-dessus.',
    /** Deleting the festival itself (ADR-0053), from the bottom of its page. */
    deleteFestival: {
      button: 'Supprimer le festival',
      title: 'Supprimer {name} ?',
      counting: 'Calcul de ce que la suppression emporterait…',
      countFailed:
        'Impossible de savoir ce que la suppression emporterait. Fermez puis réessayez.',
      ungroup:
        '{count, plural, =0 {Le festival n’a aucun événement.} one {Son événement sera conservé : il deviendra un événement indépendant.} other {Ses # événements seront conservés : ils deviendront des événements indépendants.}}',
      individually:
        'Un événement n’est jamais supprimé avec son festival. Pour les supprimer aussi, il faudra ensuite les supprimer un par un, chacun depuis sa ligne.',
      forms:
        '{count, plural, =0 {Aucun formulaire n’est rattaché au festival.} one {Son formulaire sera supprimé.} other {Ses # formulaires seront supprimés.}}',
      submissions:
        '{count, plural, one {La réponse qu’il a reçue sera supprimée, avec les disponibilités qu’elle donnait. Ce sera définitif.} other {Les # réponses reçues seront supprimées, avec les disponibilités qu’elles donnaient. Ce sera définitif.}}',
      typeName: 'Pour confirmer, tapez le nom du festival : {name}',
      confirm: 'Supprimer le festival',
      deleting: 'Suppression…',
      keep: 'Garder le festival',
      conflict:
        'Le festival a changé depuis l’ouverture de cette page. Rechargez-la puis réessayez.',
      forbidden: 'Seul un propriétaire peut supprimer un festival.',
      unavailable: 'Le serveur est injoignable : rien n’a été supprimé.',
    },
  },
  /** An event's row in the details list. */
  card: {
    /** Closed row: the published opening hours; `open` and `close` are times. */
    doors: 'Ouverture {open}–{close}',
    noDoors: 'Aucun horaire d’ouverture publié',
    /** Closed row: an edit that cannot be saved is still in the open form. */
    unsaved: 'Non enregistré',
    /** Delete icon's label. */
    remove: 'Supprimer {name}',
    deleteTitle: 'Supprimer {name}\u00a0?',
  },
  /** The page's save status and undo, above the list. */
  toolbar: {
    label: 'Enregistrement et annulation',
    allSaved: 'Tout est enregistré',
    blocked:
      '{count, plural, one {Un événement n’est pas enregistré\u00a0: voir sa ligne} other {# événements ne sont pas enregistrés\u00a0: voir leurs lignes}}',
    undo: 'Annuler la dernière modification',
    undoHint: 'Annuler (Ctrl+Z)',
    redo: 'Rétablir la modification',
    redoHint: 'Rétablir (Ctrl+Maj+Z)',
  },
  /** Announced after an undo or a redo, or why one did not happen. */
  history: {
    undone: 'Modification annulée.',
    redone: 'Modification rétablie.',
    gone: 'Cet événement n’est plus sur la page\u00a0: rien à annuler.',
  },
  /** Asked when leaving with an event that cannot be saved. */
  leave: {
    title: 'Quitter sans enregistrer\u00a0?',
    body: 'Au moins un événement a une modification qui ne peut pas être enregistrée — sa ligne dit pourquoi. En quittant, cette modification est perdue.',
    confirm: 'Quitter quand même',
    stay: 'Rester sur la page',
  },
};
