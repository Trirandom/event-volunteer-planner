// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The missions page: the zone/post tree, each mission's card, and the two
 * forms that add to it.
 */
export default {
  view: {
    help: {
      /** Title of the page's help dialog. */
      title: 'Missions',
      intro:
        'Une mission est une tâche confiée à des bénévoles\u00a0: une zone est l’espace physique — un bar, une entrée, un stand de prévention — et un poste est une tâche précise au sein de cette zone. Ce que vous écrivez ici est ce qui sera communiqué aux bénévoles\u00a0; les horaires se découpent sur la page des créneaux.',
      /** `count` is the number of days of the festival, always 2 or more. */
      festival:
        'Ce festival dure {count, plural, one {# jour} other {# jours}}, et une mission est déclarée sur chacun d’eux\u00a0: en ajouter ou en modifier une ici change tous les jours où elle a lieu. Choisissez un jour dans le bandeau ci-dessus pour travailler sur celui-ci seulement.',
    },
    locationsFailed:
      'Les missions d’au moins un jour n’ont pas pu être chargées, cette liste est donc incomplète. N’ajoutez ni ne supprimez rien avant qu’elle se recharge\u00a0: un jour absent de la liste n’est pas forcément un jour sans la mission.',
    noDays:
      'Ce festival n’a pas encore de jours, il n’y a donc rien à pourvoir.',
    empty:
      'Pas encore de missions. Ajoutez les postes sur lesquels cette production a besoin de bénévoles — un bar, une entrée, un stand de prévention — puis découpez-les en créneaux sur le tableau.',
    /** Accessible name of the group of posts under a zone; `zone` is its name. */
    postsInZone: 'Postes de la zone {zone}',
  },
  /** A tag on each card saying which level of the tree it is. */
  kind: {
    zone: 'Zone',
    post: 'Poste',
  },
  fields: {
    name: 'Nom',
    description: 'En quoi consiste la mission',
    descriptionHelp:
      'Les consignes pour les bénévoles de cette mission — ce qu’il y aura à faire, et ce qu’il faut apporter ou savoir.',
    descriptionHelpNew:
      'Facultatif pour l’instant, mais c’est ce que les bénévoles liront plus tard.',
    address: 'Où se placer',
    addressHelp:
      'Comme vous le diriez à une personne perdue — un hall, une porte, un point de repère. Pas une adresse postale.',
    /** Legend of the min/max volunteer pair. */
    volunteers: 'Bénévoles',
    volunteersHelp:
      'Combien de bénévoles cette mission peut accueillir en même temps. En dessous du minimum, elle est en sous-effectif\u00a0; au-delà du maximum, plus aucune affectation n’est faite. Laissez l’un ou l’autre vide pour ne fixer aucune limite.',
    minimum: 'Minimum',
    maximum: 'Maximum',
    noMinimum: 'Pas de minimum',
    noMaximum: 'Pas de maximum',
    exactAddress: 'Adresse exacte',
    exactAddressHelp:
      'Une adresse postale qu’une carte ou un coursier peut trouver — pas les indications ci-dessus. Laissez vide pour un terrain sans adresse propre.',
    coordinates: 'Coordonnées GPS',
    coordinatesHelp:
      'Pour un site sans aucune adresse, comme un champ pendant le montage ou le démontage\u00a0: latitude, longitude en degrés décimaux, par exemple «\u00a048.8566, 2.3522\u00a0».',
    /** An example value; the field only accepts a dot as decimal separator. */
    coordinatesPlaceholder: '48.8566, 2.3522',
    /** How the volunteer form's missions question offers this zone. */
    checkedByDefault: 'Cochée par défaut dans le formulaire bénévole',
    checkedByDefaultHint:
      'Décochez pour une mission technique\u00a0: le bénévole devra la cocher lui-même.',
    adultsOnly: 'Réservée aux 18 ans et +',
    adultsOnlyHint:
      'Signalée dans le formulaire\u00a0; jamais cochée par défaut.',
  },
  /** Why a form refuses to send. */
  problem: {
    nameMissingMission: 'Donnez un nom à la mission.',
    nameMissingPost: 'Donnez un nom au poste.',
    nameTakenOnPage: 'Une autre mission de cette page porte déjà ce nom.',
    nameTakenInProduction:
      'Cette production a déjà une mission de ce nom. Modifiez plutôt celle-ci — une seconde ligne du même nom y serait de toute façon regroupée.',
    coordinatesInvalid:
      'Les coordonnées GPS doivent ressembler à «\u00a048.8566, 2.3522\u00a0» — la latitude puis la longitude, en degrés décimaux.',
    coordinatesInvalidShort: 'Les coordonnées GPS ne sont pas valides.',
    volunteersInvalid:
      'Le nombre de bénévoles est un nombre entier\u00a0: un minimum de 0 ou plus, un maximum de 1 ou plus.',
    volunteersOrder: 'Le maximum ne peut pas être inférieur au minimum.',
  },
  /** A write that did not reach every day, with the days named. */
  refusal: {
    /** One refused day; `detail` is the server’s own explanation. */
    day: '{day} ({detail})',
    dayUnreachable: '{day} (le serveur est injoignable)',
    /** Between two refused days in a list. */
    separator: '\u00a0; ',
    /** `days` is the list of refused days. */
    nothingSaved: 'Rien n’a été enregistré. {days}',
    savedPartly:
      'Enregistrement effectué sur {applied, plural, one {# jour} other {# jours}} sur {total}, pas sur les autres. {days}',
    nothingRemoved: 'Rien n’a été supprimé. {days}',
    removedPartly:
      'Suppression effectuée sur {applied, plural, one {# jour} other {# jours}} sur {total}, pas sur les autres. {days}',
    missionNotCreated: 'La mission n’a pas été créée. {days}',
    postNotCreated: 'Le poste n’a pas été créé. {days}',
    createdPartly:
      'Création effectuée sur {applied, plural, one {# jour} other {# jours}} sur {total}, refusée sur les autres. {days}',
  },
  /** Volunteer bounds as the collapsed card states them. */
  bounds: {
    varies: 'Le nombre de bénévoles varie selon le jour',
    exactly: '{count, plural, one {# bénévole} other {# bénévoles}}',
    range: '{min}–{max, plural, one {# bénévole} other {# bénévoles}}',
    atLeast: 'Au moins {min, plural, one {# bénévole} other {# bénévoles}}',
    upTo: 'Jusqu’à {max, plural, one {# bénévole} other {# bénévoles}}',
  },
  card: {
    /** Accessible name of the day-count tooltip; `days` is the list of names. */
    runsOnDays:
      'Déclarée sur {count, plural, one {# jour} other {# jours}}\u00a0: {days}',
    dayCount: '{count, plural, one {# jour} other {# jours}}',
    unsaved: 'Modifications non enregistrées',
    /** Icon button label and tooltip; `name` is the mission’s name. */
    remove: 'Supprimer {name}',
    summary: {
      briefingVaries: 'Les consignes varient selon le jour',
      noBriefing: 'Pas encore de consignes',
      addressVaries: 'Le lieu varie selon le jour',
      /** Shown only for a zone open to adults only. */
      adultsOnly: '18 ans et +',
      adultsOnlyVaries: '18 ans et + selon le jour',
      /** A zone the volunteer form does not pre-tick. */
      optIn: 'Non cochée par défaut',
      optInVaries: 'Cochée par défaut selon le jour',
    },
    /** `missing` and `days` are lists of day names. */
    notDeclaredOn:
      'Aucune déclaration sur {missing}. L’enregistrement modifie {days} sans toucher à ces jours-là.',
    /** Shown for a day that has no value for a field the days disagree on. */
    nothingSaid: 'rien d’indiqué',
    /** Same, for a volunteer bound. */
    noBound: 'aucun',
    unifyDescription: 'Utiliser la même description pour tous les jours',
    unifyAddress: 'Utiliser la même adresse pour tous les jours',
    unifyMinimum: 'Utiliser le même minimum pour tous les jours',
    unifyMaximum: 'Utiliser le même maximum pour tous les jours',
    unifyExactAddress: 'Utiliser la même adresse exacte pour tous les jours',
    unifyCoordinates: 'Utiliser le même point GPS pour tous les jours',
    /** A checkbox's value on one day, when the days disagree. */
    flagOn: 'oui',
    flagOff: 'non',
    unifyFlag:
      'Cochez ou décochez la case pour appliquer le même choix à tous les jours.',
    saved: 'Enregistré.',
    savedOnDays:
      'Enregistré sur {count, plural, one {# jour} other {# jours}}.',
    /** Submit button, verb. */
    saveChanges: 'Enregistrer les modifications',
    deleteConfirm: {
      /** `name` is the mission’s name. */
      title: 'Supprimer {name}\u00a0?',
      confirmZone: 'Supprimer la zone',
      confirmPost: 'Supprimer le poste',
      busy: 'Suppression…',
      /** `kind` is `zone` or `post`; `days` is the list of day names. */
      body: 'Supprimer {kind, select, zone {la zone} other {le poste}} {name} sur {days}, ainsi que tous les créneaux déjà créés dessus\u00a0?',
      /** `names` lists the posts under the zone. */
      bodyWithPosts:
        'Supprimer {kind, select, zone {la zone} other {le poste}} {name} sur {days}, ainsi que {count, plural, one {le poste qui y est rattaché} other {les # postes qui y sont rattachés}} ({names}) et tous les créneaux déjà créés sur l’un ou l’autre\u00a0?',
      irreversible: 'Cette action est irréversible.',
    },
  },
  newZone: {
    /** Button opening the form. */
    open: 'Ajouter une zone',
    heading: 'Nouvelle zone',
    headingHelp:
      'Une zone est un espace physique où interviennent des bénévoles — un bar, une entrée, un stand de prévention. Une fois créée, vous pourrez la diviser en postes depuis sa propre carte, si une tâche doit être distinguée d’une autre.',
    /** `count` is the number of days of the festival, always 2 or more. */
    allDays:
      'Elle sera déclarée sur {count, plural, one {le seul jour} other {les # jours}} de ce festival\u00a0; vous pourrez ensuite la modifier ou la supprimer pour un seul jour.',
    added: '{name}\u00a0: zone ajoutée.',
    addedToAllDays:
      '{name}\u00a0: zone ajoutée {count, plural, one {au seul jour} other {aux # jours}}.',
    adding: 'Ajout…',
    /** Submit button. */
    submit: 'Ajouter la mission',
    /** Closes the form. */
    done: 'Terminé',
  },
  newPost: {
    /** `zone` is the zone’s name. */
    open: 'Ajouter un poste dans {zone}',
    heading: 'Nouveau poste dans {zone}',
    headingHelp:
      'Un poste est une tâche précise au sein de cette zone — une caisse, une porte, une table.',
    allDays:
      'Il sera déclaré sur {count, plural, one {le seul jour} other {les # jours}} où cette zone a lieu.',
    added: '{name}\u00a0: poste ajouté.',
    addedToAllDays:
      '{name}\u00a0: poste ajouté {count, plural, one {au seul jour} other {aux # jours}}.',
    adding: 'Ajout…',
    submit: 'Ajouter le poste',
    done: 'Terminé',
  },
};
