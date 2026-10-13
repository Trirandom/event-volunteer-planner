// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** The public landing page. */
export default {
  hero: {
    lead: 'Planifiez qui est où, et quand — sans aucune double affectation.',
    body: 'L’outil de coordination des événements portés par des bénévoles : les disponibilités entrent, les créneaux sortent, et chaque personne reçoit un planning sur lequel elle peut vraiment compter.',
    /** Button, shown when signed in. */
    openAdmin: 'Ouvrir l’administration',
    /** Button, shown when signed out. */
    signIn: 'Se connecter',
  },
  features: {
    heading: 'Ce que fait l’outil',
    availability: {
      title: 'Recueille les disponibilités',
      body: 'Sous forme de vraies plages horaires, pas de cases à cocher — une personne libre de 14 h à 19 h 30 peut le dire.',
    },
    refusal: {
      title: 'Refuse les doubles affectations',
      body: 'Dans la base de données plutôt que dans l’interface, si bien que deux membres de l’équipe de coordination travaillant en même temps ne peuvent pas en créer une.',
    },
    notify: {
      title: 'Envoie à chaque personne son propre planning',
      body: 'Par e-mail, SMS ou abonnement à un calendrier, dans le fuseau horaire de l’événement.',
    },
  },
  statusNote:
    'Ce déploiement est une version préliminaire : la connexion fonctionne, le planificateur lui-même est encore en construction.',
  about: {
    heading: 'À propos de ce déploiement',
  },
};
