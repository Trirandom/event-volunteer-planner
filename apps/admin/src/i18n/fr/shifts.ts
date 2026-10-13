// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The shift board: missions down, time across, shifts as bars. « Barre » is
 * the bar drawn on the board (a run of adjacent créneaux), « coupure » a
 * join between two créneaux inside it, « série » one bar among several of a
 * mission on the same day.
 */
export default {
  /** The help dialog's title. */
  title: 'Créneaux',
  help: {
    edges:
      'Faites glisser le bord d’une barre pour l’allonger, la raccourcir ou la joindre à une autre, et une coupure à l’intérieur pour déplacer la fin d’un créneau et le début du suivant — poussez une coupure sur sa voisine et ces deux créneaux n’en font plus qu’un.',
    draw: 'Double-cliquez sur une barre pour la diviser en deux séries distinctes, et faites glisser le pointeur sur une ligne vide, à l’intérieur d’un jour, pour en dessiner une nouvelle.',
    hours:
      'Une ligne verticale marque chaque heure, et un glissement s’y aimante quand il passe à proximité.',
    outside:
      'Au-delà des bords du jour — les bandes hachurées —, c’est le jour lui-même qui s’allonge.',
    /** Keyboard key names, shown in `<kbd>`: the labels printed on a French
     * keyboard. */
    keys: {
      shift: 'Maj',
      home: 'Début',
      end: 'Fin',
      ctrl: 'Ctrl',
      /** Follows a `<kbd>Ctrl</kbd>`: "Ctrl + mouse wheel". */
      wheel: '+ molette',
    },
    /** What each key or button does; each follows its key in a list. */
    does: {
      barControls:
        'Chaque barre a ses propres boutons pour découper, diviser et supprimer : une ligne qui couvre tout le festival se modifie toujours un jour à la fois.',
      shift:
        'Maintenue pendant un glissement, place un bord ou une coupure en dehors de l’heure pile.',
      arrows:
        'Déplace le bord ou la coupure sélectionnés de {minutes, plural, one {# minute} other {# minutes}}, ou d’un créneau entier avec Maj.',
      homeEnd:
        'Amène un bord aux extrémités de son jour, ou pousse une coupure sur ses voisines.',
      fold: 'Les heures qu’aucun jour n’atteint sont repliées derrière ce symbole ; appuyez dessus pour rouvrir la plage.',
      wheel: 'Au-dessus du tableau, zoome comme le curseur ci-dessus.',
    },
    doors: 'Rien de tout cela ne modifie les horaires d’ouverture au public.',
    /** A link to the event details page, after `doors`. */
    doorsLink: 'Réglez-les sur la page des détails de l’événement.',
  },
  tools: {
    /** Label of the default slot length input, lower case like the zoom. */
    cutLength: 'durée des créneaux',
    cutUnit: '(minutes)',
    zoom: 'zoom',
    zoomUnit: '(px / heure)',
  },
  empty: {
    lead: 'Aucune mission déclarée pour l’instant : il n’y a rien à découper en créneaux.',
    /** A link to the missions page, after `lead`. */
    link: 'Ajoutez-les d’abord sur la page des missions.',
  },
  /** Column header above the missions' names. */
  columnHead: 'Missions',
  /** Screen-reader text of the folded-night buttons on the ruler. `length`
   * is a duration such as "9 h"; `start` and `end` are clock times. */
  fold: {
    show: 'Afficher la plage de {length} sans aucun jour, de {start} à {end}',
    hide: 'Masquer à nouveau la plage de {length} sans aucun jour, de {start} à {end}',
  },
  row: {
    /** Under a mission's name when the board shows one day of several. */
    alsoAtDays:
      'aussi {count, plural, one {# autre jour} other {# autres jours}}',
    cutLengthLabel: 'Durée des créneaux pour {mission}, en minutes',
  },
  run: {
    /** What a bar is called for screen readers; `start` and `end` are clock
     * times, `day` the event's name. Other labels receive it as `bar`. */
    label: '{mission}, {day}, de {start} à {end}',
    start: 'Début de {bar}',
    end: 'Fin de {bar}',
    /** A join between two créneaux, numbered from the left. */
    break: 'Coupure {index} de {bar}',
    /** Button, verb: cut the bar into slots of the mission's length. */
    cut: 'découper',
    cutLabel:
      'Découper {bar} en créneaux de {minutes, plural, one {# minute} other {# minutes}}',
    /** Button, verb: break the bar in two. */
    split: 'diviser',
    splitLabel: 'Diviser {bar} en deux séries',
    removeLabel: 'Supprimer {bar}',
    /** The remove button once pressed, asking for the second press. */
    removeConfirm: 'confirmer ?',
    removeConfirmLabel:
      'Confirmer la suppression de {count, plural, one {# créneau} other {# créneaux}} de {bar}',
    /** Above a bar whose edit is still being written. */
    saving: 'enregistrement…',
    /** Above a bar nobody has cut into créneaux yet. */
    notCut: 'pas encore découpée',
  },
  unplaced: {
    heading: 'Créneaux sans mission',
    body: 'Prévus sur une zone ou un poste qui n’a pas pu être chargé, ils n’ont aucune ligne où s’afficher. Ils sont montrés plutôt que masqués : il faut quand même les pourvoir.',
    /** `start` and `end` are clock times. */
    item: '{title} — de {start} à {end}',
  },
  failed: {
    locations:
      'Les zones et postes d’au moins un jour n’ont pas pu être chargés : ses missions manquent sur ce tableau.',
    shifts:
      'Les créneaux d’au moins un jour n’ont pas pu être chargés : ce tableau montre moins de travail qu’il n’y en a. Ne modifiez rien ici avant le rechargement.',
  },
  rejection: {
    unavailable:
      'Le serveur est injoignable : cette modification n’a pas été enregistrée.',
    /** After the server's refusal, when part of the plan had landed. */
    partial:
      '{count, plural, one {# modification avait déjà été enregistrée} other {# modifications avaient déjà été enregistrées}} ; le tableau ci-dessous a été relu depuis le serveur.',
  },
  /** Why an edge pulled outwards stopped short. */
  stop: {
    neighbourEnd:
      'Cette barre touche déjà la suivante à ce poste. Deux barres qui se touchent n’en font qu’une : il n’y a plus rien à combler.',
    neighbourStart:
      'Cette barre rejoint déjà la précédente à ce poste. Deux barres qui se touchent n’en font qu’une : il n’y a plus rien à combler.',
    axis: 'Le tableau ne va pas plus loin. Pour allonger un jour de plus de {hours, plural, one {# heure} other {# heures}} à la fois, refaites le même glissement — le tableau ajoute de la place après chaque nouveau bord.',
  },
  /** What the board did with a gesture. `mission` is a mission's name,
   * `day` an event's name, `time` a clock time. */
  notice: {
    widenEnd:
      '{day} se termine désormais à {time} pour laisser la place à cette barre.',
    widenStart:
      '{day} commence désormais à {time} pour laisser la place à cette barre.',
    merged:
      'Deux coupures se sont rejointes : le créneau entre elles a disparu et son voisin couvre désormais toute la plage.',
    splitUncut:
      'La mission {mission} n’est pas encore découpée en créneaux pour {day} : il n’y a rien à diviser. Découpez-la d’abord.',
    splitNoRoom:
      'Une coupure a besoin de travail des deux côtés. Divisez plus à l’intérieur de la barre, ou faites plutôt glisser son bord.',
    split:
      'La mission {mission} forme désormais deux séries distinctes pour {day}, espacées de {minutes, plural, one {# minute} other {# minutes}}. Faites glisser les nouveaux bords là où se trouve vraiment la coupure.',
    noDay:
      'Aucun jour ne couvre cette heure : il n’y a nulle part où placer un créneau. Allongez d’abord un jour en faisant glisser une barre au-delà de son bord.',
    notAPost:
      'La mission {mission} ne fait pas partie des postes de {day} : elle n’a nulle part où être pourvue ce jour-là.',
  },
};
