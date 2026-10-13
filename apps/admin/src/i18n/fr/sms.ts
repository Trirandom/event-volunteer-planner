// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** An organisation’s OVH SMS credentials. */
export default {
  title: 'Configuration SMS',
  intro:
    'Identifiants OVH SMS de cette organisation. Une fois enregistrées ici, ces clés servent à prévenir les bénévoles par SMS.',
  loadFailed:
    'Le serveur est injoignable ; les paramètres actuels n’ont pas pu être chargés.',
  saved: 'Enregistré.',
  fields: {
    serviceName: 'Nom du service OVH SMS',
    /** Example of OVH’s service-name format; not translated. */
    serviceNamePlaceholder: 'sms-xxxxx-1',
    /** The SMS sender ID. */
    sender: 'Expéditeur',
    senderPlaceholder: 'Nom affiché sur le téléphone des bénévoles',
    applicationKey: 'Clé d’application',
    applicationSecret: 'Secret d’application',
    consumerKey: 'Clé consommateur',
    /** After a secret field’s label, when a value is already stored. */
    alreadySet: 'valeur déjà enregistrée, laissez vide pour la conserver',
  },
  error: {
    unavailable:
      'Le serveur est injoignable. Vérifiez votre connexion et réessayez.',
    forbidden: 'Votre rôle dans cette organisation ne permet pas cette action.',
  },
};
