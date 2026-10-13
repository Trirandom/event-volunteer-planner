// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** The admin panel: identity, memberships, sign-out. */
export default {
  title: 'Administration',
  identity: {
    /** Followed by the user’s display name and e-mail, in separate elements. */
    signedInAs: 'Connexion en tant que',
  },
  orgs: {
    heading: 'Vos organisations',
    /** Link to the organisation’s events list. */
    events: 'Événements',
    /** Link to the organisation’s SMS settings. */
    sms: 'Configuration SMS',
    empty:
      'Vous n’êtes membre d’aucune organisation pour le moment. Demandez à l’équipe organisatrice de vous inviter.',
  },
  /** A membership role, shown as a badge. */
  roles: {
    owner: 'Propriétaire',
    coordinator: 'Coordination',
    zoneLead: 'Responsable de zone',
  },
  placeholder: {
    heading: 'Pas encore disponible',
    body: 'Le tableau de planification, les bénévoles, les créneaux et les notifications arriveront avec leurs jalons. Pour l’instant, cette page prouve une seule chose : la session fonctionne de bout en bout.',
  },
  signOut: 'Se déconnecter',
  unavailable:
    'Le serveur est injoignable ; vos organisations n’ont pas pu être chargées.',
  /** Followed by the "sign in again" link, then a full stop. */
  sessionEnded: 'Votre session a pris fin.',
  signInAgain: 'Se reconnecter',
};
