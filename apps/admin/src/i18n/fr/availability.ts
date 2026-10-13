// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The availability board: one row per volunteer, one chip per stretch they
 * can work. « Bloc » is the chip, « plage » the stretch of time it covers.
 */
export default {
  /** Page heading and the help dialog's title. */
  title: 'Disponibilités',
  help: {
    intro:
      'Une ligne par bénévole, un bloc par plage où la personne peut travailler. Faites glisser le bord d’un bloc pour l’allonger ou le raccourcir — poussez un bord sur son voisin et les deux n’en font plus qu’un — et faites glisser sur un espace vide de la ligne pour déclarer une nouvelle plage.',
    /** Keyboard key names, shown in `<kbd>`: the labels printed on a French
     * keyboard. */
    keys: {
      home: 'Début',
      end: 'Fin',
      ctrl: 'Ctrl',
      /** Follows a `<kbd>Ctrl</kbd>`: "Ctrl + mouse wheel". */
      wheel: '+ molette',
    },
    /** What each key or button does; each follows its key in a list. */
    does: {
      split: 'Coupe un bloc en deux.',
      remove: 'Supprime un bloc.',
      arrows:
        'Avec un bord sélectionné, le déplace de {minutes, plural, one {# minute} other {# minutes}}.',
      homeEnd: 'Amène le bord sélectionné au début ou à la fin du jour.',
      wheel: 'Au-dessus du tableau, zoome comme le curseur ci-dessus.',
    },
    outro:
      'Chaque modification est enregistrée dès qu’elle est faite. Un bloc hachuré est une plage proposée par la personne bénévole et que personne n’a touchée ; un bloc plein a été modifié ici — et dans les deux cas, ce qu’elle a rempli dans le formulaire est conservé exactement tel quel.',
  },
  zoom: {
    label: 'zoom',
    unit: '(px / heure)',
  },
  rosterFailed:
    'Le planning n’a pas pu être chargé : des bénévoles manqueraient sur ce tableau.',
  empty: {
    /** Followed by a link to the submissions page (`empty.link`). */
    lead: 'Aucune personne n’est encore inscrite sur les jours affichés. Les disponibilités arrivent avec le formulaire bénévole —',
    link: 'voir ce qui est arrivé',
  },
  /** Column header above the volunteers' names. */
  columnHead: 'Bénévoles',
  /** Screen-reader text of the folded-night buttons on the ruler. `length`
   * is a duration such as "9 h"; `start` and `end` are clock times. */
  fold: {
    show: 'Afficher les {length} sans aucun jour, de {start} à {end}',
    hide: 'Masquer à nouveau les {length} sans aucun jour, de {start} à {end}',
  },
  row: {
    /** Under a volunteer's name, where the total time would be. */
    nothingDeclared: 'rien de déclaré',
    resetLabel: 'Revenir aux disponibilités envoyées par {name}',
    resetTitle: 'Revenir aux disponibilités envoyées',
  },
  /** `start` and `end` are clock times; `day` is the event's name. */
  chip: {
    label: '{name}, {day}, de {start} à {end}',
    startHandle: 'Début de {name}, {day}, de {start} à {end}',
    endHandle: 'Fin de {name}, {day}, de {start} à {end}',
    /** The time range printed on the chip itself. */
    hours: '{start}–{end}',
    /** Button, verb: cut the chip in two. Also named in the help. */
    split: 'couper',
    splitLabel: 'Couper en deux : {name}, {day}, de {start} à {end}',
    removeLabel: 'Supprimer : {name}, {day}, de {start} à {end}',
  },
  notice: {
    merged: 'Ces deux plages se touchaient : elles n’en font plus qu’une.',
    notEnrolled:
      '{name} n’a pas d’inscription sur {day}, il n’y a donc rien à y déclarer.',
    tooShort:
      'Cette plage est trop courte pour être coupée — faites plutôt glisser un bord.',
    split:
      'Coupée en deux plages, à {minutes, plural, one {# minute} other {# minutes}} d’intervalle. Faites glisser les nouveaux bords là où se trouve vraiment la pause.',
    removed: 'Plage de {start} à {end} supprimée sur {day}.',
    reset:
      'Les disponibilités de {name} sont revenues à ce que la personne avait envoyé.',
  },
  rejection: {
    unavailable:
      'Le serveur est injoignable : cette modification n’a pas été enregistrée.',
  },
};
