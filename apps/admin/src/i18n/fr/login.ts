// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** The sign-in page. */
export default {
  /** Page heading. */
  title: 'Connexion',
  intro: 'Accès réservé à l’équipe de coordination de ce déploiement.',
  email: 'Adresse e-mail',
  password: 'Mot de passe',
  /** Submit button, verb. */
  submit: 'Se connecter',
  /** Submit button while the request is in flight. */
  submitting: 'Connexion…',
  note: 'Les comptes sont créés sur invitation. Si vous avez perdu votre mot de passe, adressez-vous à l’équipe organisatrice — cette version ne permet pas de le réinitialiser vous-même.',
  error: {
    unavailable:
      'Le serveur est injoignable. Vérifiez votre connexion et réessayez.',
    /**
     * Must stay as non-committal as the English: it may not hint whether the
     * address has an account (docs/12).
     */
    invalidCredentials:
      'Cette adresse e-mail et ce mot de passe ne correspondent à aucun compte.',
  },
};
