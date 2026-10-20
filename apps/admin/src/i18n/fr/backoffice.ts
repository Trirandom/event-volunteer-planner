// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** The deployment operator’s backoffice (ADR-0045): organisations, accounts
 * and memberships across every tenant, behind a key rather than a session. */
export default {
  title: 'Backoffice',
  intro:
    'Organisations, comptes et rattachements de toute l’instance. Réservé à l’exploitant : l’accès se fait par la clé EVP_BACKOFFICE_KEY, pas par une session.',
  lock: {
    heading: 'Déverrouiller',
    key: 'Clé du backoffice',
    /** Under the key field: why the key has to be typed again after a reload. */
    keyHint:
      'La clé reste en mémoire dans cet onglet uniquement ; recharger la page l’oublie.',
    unlock: 'Déverrouiller',
    unlocking: 'Vérification…',
    lock: 'Verrouiller',
    badKey: 'Cette clé n’est pas la bonne.',
    disabled:
      'Le backoffice n’est pas activé sur cette instance (EVP_BACKOFFICE_KEY n’est pas définie).',
    rateLimited: 'Trop de tentatives. Patientez un moment avant de réessayer.',
  },
  roles: {
    owner: 'Propriétaire',
    coordinator: 'Coordination',
    zone_lead: 'Responsable de zone',
  },
  organizations: {
    heading: 'Organisations',
    empty: 'Aucune organisation pour le moment.',
    columns: {
      name: 'Nom',
      slug: 'Identifiant',
      timezone: 'Fuseau horaire',
      members: 'Membres',
    },
    create: {
      heading: 'Nouvelle organisation',
      name: 'Nom',
      slug: 'Identifiant (dans les adresses)',
      /** `organizations_slug_format`, in words. */
      slugHint:
        'Minuscules, chiffres et tirets, de 3 à 40 caractères ; proposé à partir du nom.',
      timezone: 'Fuseau horaire',
      submit: 'Créer l’organisation',
      submitting: 'Création…',
      created: 'Organisation « {name} » créée.',
    },
  },
  users: {
    heading: 'Comptes',
    empty: 'Aucun compte pour le moment.',
    columns: {
      email: 'Adresse e-mail',
      displayName: 'Nom affiché',
      lastLogin: 'Dernière connexion',
      memberships: 'Organisations',
    },
    neverSignedIn: 'jamais',
    /** A last-login instant; both arguments are pre-formatted, in UTC. */
    lastLoginAt: '{date} à {time} UTC',
    /** One membership in the accounts table: organisation, then role. */
    membership: '{name} ({role})',
    noMembership: 'aucune',
    create: {
      heading: 'Nouveau compte',
      email: 'Adresse e-mail',
      displayName: 'Nom affiché',
      password: 'Mot de passe',
      passwordHint:
        'Au moins 12 caractères. Transmettez-le à la personne par un canal sûr.',
      submit: 'Créer le compte',
      submitting: 'Création…',
      created: 'Compte {email} créé.',
    },
  },
  members: {
    heading: 'Membres d’une organisation',
    organization: 'Organisation',
    chooseOrganization: 'Choisir une organisation…',
    pick: 'Choisissez une organisation pour voir ses membres.',
    empty: 'Cette organisation n’a encore aucun membre.',
    columns: {
      member: 'Membre',
      role: 'Rôle',
      actions: 'Actions',
    },
    /** Accessible name of a member row’s role select. */
    roleOf: 'Rôle de {name}',
    remove: 'Retirer',
    /** Accessible name of a member row’s remove button. */
    removeLabel: 'Retirer {name}',
    confirm: {
      title: 'Retirer {name} de {organization} ?',
      body: 'Cette personne perd immédiatement l’accès à cette organisation. Son compte est conservé.',
      action: 'Retirer {name}',
      busy: 'Retrait…',
    },
    assign: {
      heading: 'Rattacher un compte',
      user: 'Compte',
      chooseUser: 'Choisir un compte…',
      role: 'Rôle',
      submit: 'Rattacher',
      submitting: 'Rattachement…',
      /** The assign call both adds and changes a role, so one message fits. */
      done: 'Rôle de {name} : {role}.',
    },
    removed: '{name} n’est plus membre.',
  },
  error: {
    unavailable:
      'Le serveur est injoignable. Vérifiez votre connexion et réessayez.',
    loadFailed: 'Le chargement a échoué.',
    rateLimited: 'Trop de requêtes. Patientez un moment avant de réessayer.',
    /** A member call naming an organisation, account or membership that does
     * not exist; followed by the server’s detail. */
    notFound: 'Introuvable : {detail}',
  },
};
