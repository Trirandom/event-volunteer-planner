// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** The assignation board: who is placed on which shift. */
export default {
  help: {
    /** Heading of the "how this page works" dialog: the section's name. */
    title: 'Affectations',
    seats:
      'Chaque créneau est une pile de listes déroulantes, une par bénévole dont la mission a besoin au minimum — un créneau à qui il manque encore du monde est entouré et l’indique. Une fois celles-ci remplies, une liste de plus apparaît pour un coup de main supplémentaire.',
    /** `removeOption` receives the seat’s own removal choice (`seat.remove`). */
    pick: 'Choisissez un nom pour affecter une personne, « {removeOption} » pour la retirer, ou un autre nom pour la remplacer.',
    ranking:
      'La liste suit ce que chaque bénévole a répondu au formulaire : d’abord les personnes disponibles sur ces horaires, puis celles qui n’ont rien indiqué, puis celles qui ne peuvent pas — toute personne déjà affectée ailleurs à ce moment est affichée mais ne peut pas être choisie, car la base de données refuse une double affectation.',
    /** ⋯ is the marker drawn over folded hours on the time axis. */
    folds:
      'Les heures qu’aucun jour ne couvre sont repliées derrière un ⋯ ; appuyez dessus pour rouvrir cette plage.',
    drag: 'Pour déplacer une personne, faites glisser sa place sur une autre ; maintenez Ctrl ou Alt en la déposant pour la copier à la place.',
    keyboard:
      'Ctrl+C et Ctrl+V sur la place qui a le focus font de même sans souris.',
    zoom: 'Ctrl + molette sur le tableau le zoome, comme le curseur ci-dessus.',
    /** The whole sentence is the link to the shifts page. */
    shiftsLink: 'Les créneaux eux-mêmes se découpent sur la page des créneaux.',
  },
  toolbar: {
    /** How many required places across the board are filled. */
    coverage:
      '{filled, number} {filled, plural, one {place pourvue} other {places pourvues}} sur {required, number}',
    /** Label of the zoom slider; its unit follows in a separate element. */
    zoom: 'zoom',
    zoomUnit: '(px / heure)',
    onlyGaps: 'seulement les missions avec des places libres',
  },
  empty: {
    noMissions:
      'Aucune mission déclarée pour l’instant, il n’y a donc personne à placer.',
    /** The whole sentence is the link to the missions page. */
    noMissionsLink: 'Ajoutez-les d’abord sur la page des missions.',
    noShifts:
      'Ces missions ne sont pas encore découpées en créneaux, il n’y a donc aucune place à pourvoir.',
    /** The whole sentence is the link to the shifts page. */
    noShiftsLink: 'Découpez-les d’abord sur la page des créneaux.',
    allStaffed: 'Toutes les missions affichées sont entièrement pourvues.',
  },
  board: {
    /** Column header above the mission names. */
    missionsHeader: 'Missions',
    /** A symbol, not a word: the marker over folded hours. Keep as is. */
    foldGlyph: '⋯',
    /** Screen-reader text of a folded stretch. `length` is e.g. « 11 h »;
     * `start`/`end` are clock times. */
    showFold: 'Afficher les {length} sans aucun jour, de {start} à {end}',
    hideFold:
      'Masquer à nouveau les {length} sans aucun jour, de {start} à {end}',
    /** Beside a mission name: it also runs on other days not in view. */
    alsoAtDays:
      'aussi {count, plural, one {# autre jour} other {# autres jours}}',
    /** Per mission: places filled / places required. */
    missionCount: '{filled, number}/{required, number} en place',
  },
  seat: {
    /** The empty choice on a filled seat: picking it takes the person off. */
    remove: '— retirer —',
    /** The empty choice on a seat beyond what the slot requires. */
    addExtra: '+ ajouter une personne (en plus)',
    /** The empty choice on a required seat nobody holds. */
    nobodyYet: '— personne pour l’instant —',
    /** A name whose placement is being written. */
    saving: '{name} — enregistrement…',
    /** Screen-reader name of a seat. `hours` is e.g. « 10:00–12:00 »,
     * `timezone` an IANA zone name. */
    label:
      '{mission}, {event}, {hours} ({timezone}), bénévole {position, number} sur {total, number}',
    /** Tooltip on a filled seat. */
    dragHint: 'Glisser pour déplacer {name}, Ctrl/Alt + glisser pour copier',
    /** A dropdown option: the volunteer’s name, then what they declared for
     * these hours. `other` is someone who declined or withdrew. */
    candidate:
      '{name} — {state, select, available {disponible} partial {disponible en partie} unknown {pas de réponse} unavailable {a dit non} busy {déjà en poste} other {ne vient pas}}',
  },
  loadFailed: {
    locations:
      'Les zones et postes d’au moins un jour n’ont pas pu être chargés, ses missions manquent donc sur ce tableau.',
    shifts:
      'Les créneaux d’au moins un jour n’ont pas pu être chargés, ce tableau affiche donc moins de places qu’il n’y en a.',
    participants:
      'La liste des bénévoles d’au moins un jour n’a pas pu être chargée. Ses listes déroulantes sont vides — c’est cette page qui n’a pas réussi à la demander, pas une absence d’inscriptions.',
    assignments:
      'Le planning d’au moins un jour n’a pas pu être chargé, les créneaux ci-dessous peuvent donc sembler plus vides qu’ils ne le sont. Ne modifiez rien ici avant qu’il ne se recharge.',
  },
  rejection: {
    unavailable:
      'Le serveur est injoignable, cette modification n’a donc pas été enregistrée.',
    /** A swap whose second half was refused. `reason` is the refusal
     * sentence (often the server’s own). */
    placeEmptied:
      '{reason} La personne qui occupait cette place en a déjà été retirée, la place est donc vide maintenant.',
  },
  clipboard: {
    /** Followed by the copied volunteer’s name, in bold. */
    copied: 'Personne copiée :',
    pasteHint: 'Sélectionnez une place et appuyez sur Ctrl+V pour l’y placer.',
    /** Button that forgets the copied volunteer. */
    clear: 'Oublier la personne copiée',
  },
};
