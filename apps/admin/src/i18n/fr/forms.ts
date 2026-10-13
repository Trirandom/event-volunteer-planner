// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The form builder (the « Formulaire » page). Only the builder's own chrome:
 * the questions volunteers read are the coordinator's data, stored per
 * locale on the form version, and never pass through here.
 */
export default {
  /** The names of things, shared by the card, the palette, the read-only
   * view and the problem summary (`plan/formLabels.ts`). */
  labels: {
    kind: {
      shortText: 'Texte court',
      longText: 'Texte long',
      email: 'E-mail',
      phone: 'Téléphone',
      date: 'Date',
      singleChoice: 'Choix unique',
      multiChoice: 'Choix multiples',
      boolean: 'Oui / Non',
      availability: 'Disponibilités',
      missions: 'Postes',
      consent: 'Consentement',
      section: 'Section',
    },
    builtin: {
      firstName: 'Prénom',
      lastName: 'Nom de famille',
      email: 'Adresse e-mail',
      phone: 'Téléphone',
      tshirtSize: 'Taille de t-shirt',
      dietary: 'Régime alimentaire',
      notes: 'Remarques',
      availability: 'Disponibilités',
      missions: 'Postes possibles',
      processingConsent: 'Consentement au traitement',
      poolConsent: 'Conservation pour les prochains événements',
      commitment: 'Engagement bénévole',
    },
    /** Where a question's answer goes: the tooltip behind « Intégrée » /
     * « Personnalisée » on each card. */
    destination: {
      firstName:
        'Alimente le prénom de la fiche bénévole, utilisé pour saluer la personne.',
      lastName: 'Alimente le nom de la fiche bénévole.',
      email:
        'Alimente l’adresse de la fiche bénévole ; le lien public reconnaît les bénévoles par elle.',
      phone:
        'Alimente le téléphone de la fiche bénévole, utilisé pour les SMS.',
      tshirtSize: 'Alimente la taille de t-shirt de la fiche bénévole.',
      dietary: 'Alimente le régime alimentaire de la fiche bénévole.',
      notes: 'Alimente les remarques de la fiche bénévole.',
      availability:
        'Devient les plages de disponibilité de chaque événement du périmètre.',
      missions:
        'Devient la liste des postes possibles de chaque participation, consultée pendant les affectations.',
      processingConsent:
        'Enregistré avec la réponse, avec la version de la notice de confidentialité.',
      poolConsent:
        'Enregistré sur la fiche bénévole ; sans lui, la fiche est anonymisée après l’événement.',
      commitment:
        'Enregistré avec la réponse : la personne confirme participer bénévolement, pour le compte de l’association.',
      custom:
        'Question propre à ce formulaire : la réponse est gardée avec la participation, aussi longtemps que les données de l’événement.',
    },
    /** Why the « Obligatoire » toggle is locked, shown under it. */
    requiredReason: {
      firstName:
        'Toujours obligatoire : le prénom sert à saluer la personne et à la reconnaître.',
      email:
        'Toujours obligatoire : sur le lien public, c’est l’adresse qui identifie la personne.',
      processingConsent:
        'Toujours obligatoire : sans ce consentement, les réponses ne peuvent pas être traitées.',
      poolConsent:
        'Jamais obligatoire : refuser la conservation ne doit pas empêcher de s’inscrire.',
      commitment:
        'Toujours obligatoire : c’est ce qui fait de l’aide apportée un engagement bénévole pour le compte de l’association.',
    },
    dietarySensitive:
      'Toujours sensible : un régime alimentaire peut révéler une religion ou un état de santé.',
    sensitiveEffect:
      'Les réponses sensibles sont exclues des exports par défaut et masquées aux responsables de zone.',
  },

  /** What the pre-check finds, on the card concerned and in the summary. */
  problems: {
    duplicateTarget: 'Cette question est déjà posée plus haut.',
    duplicateAvailability:
      'Un formulaire ne demande les disponibilités qu’une fois.',
    duplicateMissions:
      'Un formulaire ne demande les postes possibles qu’une fois.',
    duplicateConsent: 'Ce consentement est déjà demandé plus haut.',
    sectionTitleMissing: 'Donnez un titre à cette section.',
    labelMissing: 'Le libellé en français est obligatoire.',
    helpMissingFr: 'Le texte d’aide existe en anglais mais pas en français.',
    consentPurposeMissing: 'Ce consentement n’a pas d’objet.',
    poolRetentionRequired:
      'La conservation pour les prochains événements ne peut pas être obligatoire : la refuser ne doit pas empêcher de s’inscrire.',
    contactUntargeted:
      'Une adresse e-mail ou un téléphone doit alimenter la fiche bénévole.',
    optionsUnexpected: 'Ce type de question ne prend pas d’options.',
    optionsMissing: 'La liste d’options manque.',
    optionLabelMissing: 'Chaque option a besoin d’un libellé en français.',
    unscoped:
      'Ce formulaire ne couvre aucun événement : il n’y a ni jours ni postes à proposer.',
    processingConsentMissing:
      'Il manque le consentement au traitement des réponses : un formulaire ne peut pas être publié sans lui.',
    commitmentMissing:
      'Il manque la confirmation d’engagement bénévole : un formulaire ne peut pas être publié sans elle.',
    firstNameMissing: 'Il manque la question du prénom.',
    emailMissing: 'Il manque la question de l’adresse e-mail.',
    mustBeRequired: 'Cette question doit être obligatoire.',
    optionsEmpty: 'Ajoutez au moins une option.',
    duplicateOption: 'Deux options ont la même valeur.',
    /** `missions`: the option labels, comma-separated. */
    missionUnresolved: 'Ne correspond plus à aucune mission : {missions}.',
    labelMissingEn:
      'Le formulaire est en anglais par défaut : il manque une traduction.',
  },

  tags: {
    required: 'Obligatoire',
    sensitive: 'Sensible',
  },

  status: {
    creating: 'Création…',
  },

  errors: {
    unavailable:
      'Le serveur est injoignable. Vérifiez votre connexion et réessayez.',
  },

  page: {
    title: 'Formulaire',
    help: {
      intro:
        'Le formulaire est ce que remplissent les bénévoles : leurs coordonnées, leurs disponibilités sur chaque événement et les postes qui les intéressent. Un festival a un seul formulaire, qui couvre tous ses événements.',
      draft:
        'Vous travaillez sur un brouillon, que vous pouvez enregistrer autant de fois que vous le voulez. La publication le fige : chaque réponse reste liée à la version à laquelle elle a répondu. Pour changer un formulaire publié, créez une nouvelle version, modifiez-la, puis publiez-la à son tour.',
      /** Followed by the two keyboard shortcuts. */
      reorder:
        'Pour réordonner, utilisez les boutons Monter et Descendre, ou ces raccourcis depuis une question (hors champ de texte) :',
      /** A key combination, shown in a <kbd>. */
      shortcutUp: 'Alt+↑',
      shortcutDown: 'Alt+↓',
    },
    covered: {
      named:
        '{day} fait partie de {festival} : c’est le formulaire du festival qui couvre ce jour, avec ses disponibilités et ses postes.',
      /** The festival's name failed to load. */
      unnamed:
        '{day} fait partie de son festival : c’est le formulaire du festival qui couvre ce jour, avec ses disponibilités et ses postes.',
      open: 'Ouvrir le formulaire du festival',
    },
    formsFailed: 'Les formulaires n’ont pas pu être chargés.',
    /** Label of the select choosing between several forms. */
    picker: 'Formulaire',
    versions: {
      heading: 'Versions',
      /** A version number, as the list shows it: "v2". */
      number: 'v{version}',
      draft: 'brouillon',
      publishedOn: 'publiée le {date}',
      live: 'en ligne',
      questionCount: '· {count, plural, one {# question} other {# questions}}',
    },
    versionFailed: 'Cette version n’a pas pu être chargée.',
    toolbar: {
      label: 'Brouillon',
      /** Followed by "Unsaved changes" or "Everything is saved". */
      status: 'Brouillon v{version} ·',
      unsaved: 'Modifications non enregistrées',
      allSaved: 'Tout est enregistré',
      discard: 'Annuler les modifications',
      /** Button, verb. */
      publish: 'Publier',
      publishHint:
        'Enregistrez d’abord : c’est la version enregistrée qui est publiée.',
    },
    frozen: {
      title: 'Version {version}, publiée le {date}.',
      live: 'C’est la version que les bénévoles remplissent.',
      explanation:
        'Une version publiée est figée : les réponses déjà reçues restent lisibles telles qu’elles ont été données.',
      createVersion: 'Créer une nouvelle version',
      openDraft: 'Ouvrir le brouillon v{version}',
    },
    summary: {
      heading:
        '{count, plural, one {Un point à corriger} other {# points à corriger}}',
      blocking:
        '— {count, plural, one {un bloque} other {# bloquent}} l’enregistrement',
      /** Link to a question, followed by the problem. */
      question: 'Question {position}',
      /** A problem about the form as a whole, followed by the problem. */
      form: 'Formulaire',
      /** Between "Question 3" and the problem's text. */
      separator: ' :',
    },
    tabs: {
      label: 'Affichage',
      questions: 'Questions',
      preview: 'Aperçu',
    },
    notice: {
      label: 'Version de la notice de confidentialité',
      hint: 'Enregistrée avec chaque réponse, pour savoir quelle notice la personne a acceptée. Facultatif.',
    },
    palette: {
      heading: 'Ajouter une question',
      builtin: 'Questions intégrées',
      allAdded: 'Toutes les questions intégrées sont déjà dans le formulaire.',
      custom: 'Questions personnalisées',
      section: 'Section (titre et texte)',
    },
    publishDialog: {
      title: 'Publier la version {version} ?',
      /** Button, verb. */
      confirm: 'Publier',
      busy: 'Publication…',
      body: 'Une fois publiée, cette version devient celle que remplissent les bénévoles.',
      /** Shown in bold after `body`. */
      frozen:
        'Elle est figée : plus aucune question ne pourra y être modifiée, ajoutée ou retirée.',
      why: 'C’est ce qui garantit que chaque réponse reste lisible telle qu’elle a été donnée. Pour changer le formulaire ensuite, vous créerez une nouvelle version.',
      risk: 'Le serveur risque de refuser la publication :',
    },
    leaveDialog: {
      title: 'Quitter sans enregistrer ?',
      confirm: 'Abandonner les modifications',
      busy: '…',
      stay: 'Rester sur la page',
      body: 'Le brouillon a des modifications non enregistrées. Elles seront perdues si vous quittez cette page maintenant.',
    },
    toast: {
      saved: 'Brouillon enregistré.',
      saveConflict:
        'Ce brouillon a été modifié ailleurs, ou publié, depuis que vous l’avez ouvert : rien n’a été enregistré. Vos modifications sont toujours à l’écran.',
      reload: 'Recharger la version enregistrée (abandonne vos modifications)',
      saveRefused:
        '{count, plural, =0 {Le serveur a refusé d’enregistrer ce brouillon.} one {Le serveur a refusé d’enregistrer ce brouillon : un problème, indiqué ci-dessus et sur la question concernée.} other {Le serveur a refusé d’enregistrer ce brouillon : # problèmes, indiqués ci-dessus et sur les questions concernées.}}',
      publishRefused:
        '{count, plural, =0 {Le serveur a refusé de publier ce brouillon.} one {Le serveur a refusé de publier ce brouillon : un problème, indiqué ci-dessus et sur la question concernée.} other {Le serveur a refusé de publier ce brouillon : # problèmes, indiqués ci-dessus et sur les questions concernées.}}',
      published:
        'Version {version} publiée : c’est elle que les bénévoles remplissent désormais. Elle ne peut plus être modifiée ; pour changer une question, créez une nouvelle version.',
      publishConflict:
        'Ce brouillon a changé depuis son chargement : il a été rechargé. Relisez-le avant de publier.',
      versionCreated:
        'Brouillon v{version} créé à partir de la version en ligne.',
      draftExists: 'Un brouillon existe déjà : il est ouvert ci-dessous.',
      formCreated:
        'Formulaire créé. Voici son premier brouillon : relisez les questions, puis publiez-le.',
    },
    /** Spoken to screen readers after a change to the question list.
     * `named` is `yes` when the question has a label, given as `label`. */
    announce: {
      moved:
        '{named, select, yes {« {label} »} other {La question}} est maintenant en position {position} sur {total}.',
      removed:
        '{named, select, yes {« {label} »} other {La question}} a été retirée du brouillon.',
      added:
        '{named, select, yes {« {label} »} other {La question}} a été ajoutée à la fin du formulaire.',
      discarded: 'Modifications annulées.',
    },
  },

  card: {
    untitled: '(sans libellé)',
    /** Tag: whether the question is built in or the coordinator's own. */
    origin: '{builtin, select, yes {Intégrée} other {Personnalisée}}',
    originLabel:
      '{builtin, select, yes {Intégrée} other {Personnalisée}} : {destination}',
    problemCount: '{count, plural, one {# problème} other {# problèmes}}',
    moveUp: 'Monter « {title} »',
    moveUpHint: 'Monter (Alt+↑)',
    moveDown: 'Descendre « {title} »',
    moveDownHint: 'Descendre (Alt+↓)',
    remove: 'Retirer « {title} »',
    /** A field label; `lang` is a language code, "fr" or "en". */
    field:
      '{field, select, title {Titre} text {Texte} help {Aide} other {Libellé}} ({lang})',
    optional: 'facultatif',
    options: 'Options',
    optionFr: 'Option {number} (fr)',
    optionEn: '(en)',
    valueFixed: 'Valeur enregistrée : elle ne change plus.',
    valueDerived: 'Valeur dérivée du libellé.',
    removeOption: 'Retirer l’option {number}',
    removeOptionNamed: 'Retirer l’option {number} « {label} »',
    addOption: 'Ajouter une option',
    /** `sizes`: the sizes, comma-separated. */
    tshirtSizes: 'Tailles fixes : {sizes}.',
    availabilityHint:
      'Une rubrique par événement du périmètre, avec une ligne par jour : les bénévoles y indiquent leurs plages horaires précises.',
    booleanHint:
      'Obligatoire, elle s’affiche en deux boutons « Oui » / « Non », sans réponse présélectionnée ; facultative, en une case à cocher.',
  },

  missions: {
    legend: 'Postes proposés',
    loadFailed:
      'Les missions du périmètre n’ont pas pu être chargées : seules celles déjà proposées sont affichées.',
    none: 'Aucune mission déclarée pour l’instant. Ajoutez-les sur la page Missions : elles apparaîtront ici, à cocher.',
    notOffered: 'Non proposé',
    unresolved: 'Ne correspond plus à aucune mission',
    labelFr: 'Libellé (fr)',
    labelEn: 'Libellé (en)',
    /** Tags on a mission, mirroring how the volunteer form offers it. */
    adultsOnly: '18 ans et +',
    notPreTicked: 'Non cochée par défaut',
    flagsHint:
      'Les missions sont cochées d’avance pour le bénévole, sauf celles marquées «\u00a0Non cochée par défaut\u00a0» ou «\u00a018 ans et +\u00a0». Ces réglages se font sur la page Missions, dans la carte de chaque zone.',
  },

  settings: {
    title: 'Réglages du formulaire',
    name: 'Nom',
    defaultLocale: 'Langue par défaut',
    /** Followed by the URL. */
    publicLink: 'Lien public :',
    open: 'Lien public ouvert aux nouvelles inscriptions',
    openHint:
      'Fermé, le lien public refuse les nouvelles inscriptions ; les liens personnels envoyés aux bénévoles connus continuent de fonctionner.',
    noLiveVersion:
      'Aucune version n’est encore publiée : le lien n’affichera rien tant qu’il n’y en a pas.',
    saved: 'Réglages enregistrés.',
    conflict:
      'Ces réglages ont été modifiés ailleurs entre-temps. Vérifiez-les puis enregistrez à nouveau.',
    save: 'Enregistrer les réglages',
  },

  newForm: {
    lead: 'Pas encore de formulaire. Créez-le : il commence avec les questions que tout formulaire pose — prénom, nom, e-mail, téléphone, disponibilités, postes possibles et consentement — que vous pourrez ensuite reformuler, compléter et réordonner.',
    name: 'Nom',
    slug: 'Lien public',
    slugHint:
      'Lettres minuscules, chiffres et tirets. C’est l’adresse que les bénévoles taperont : elle se change difficilement une fois diffusée.',
    slugTaken:
      'Ce lien est déjà utilisé par un autre formulaire. Choisissez-en un autre.',
    create: 'Créer le formulaire',
  },

  preview: {
    locale: 'Langue de l’aperçu',
  },
};
