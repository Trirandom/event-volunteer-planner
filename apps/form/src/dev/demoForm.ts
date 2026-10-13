// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The Soundclash 26 worked example (`crates/evp-domain/src/example.json`) as
 * `GET /public/forms/{slug}` would serve it, for `/f/demo` in development
 * only — see `FormView.vue`. The events are the fixture's own periods; the
 * questions are the seeded draft (docs/04) plus the palette's usual extras.
 */
import type { PublicForm } from '../api/publicForm';

const q = (
  id: string,
  kind: PublicForm['version']['questions'][number]['kind'],
  fr: string,
  en: string,
  extra: Partial<PublicForm['version']['questions'][number]> = {},
): PublicForm['version']['questions'][number] => ({
  id,
  kind,
  target_path: null,
  consent_purpose: null,
  label: { fr, en },
  help_text: null,
  options: null,
  is_required: false,
  is_sensitive: false,
  ...extra,
});

type Option = NonNullable<
  PublicForm['version']['questions'][number]['options']
>[number];

const option = (
  value: string,
  fr: string,
  flags: Partial<Pick<Option, 'checked_by_default' | 'adults_only'>> = {},
): Option => ({
  value,
  label: { fr },
  checked_by_default: false,
  adults_only: false,
  ...flags,
});

const event = (
  id: string,
  name: string,
  start: string,
  end: string,
  publicPeriod?: [string, string],
) => ({
  id,
  name,
  timezone: 'Europe/Paris',
  period: { start, end },
  public_period:
    publicPeriod === undefined
      ? null
      : { start: publicPeriod[0], end: publicPeriod[1] },
  availability_step_minutes: 30,
  slot_options: [],
});

export const demoForm: PublicForm = {
  form: { slug: 'demo', name: 'Bénévoles Soundclash 26', default_locale: 'fr' },
  version: {
    id: 'demo-v1',
    version: 1,
    privacy_notice_version: '2026-09',
    questions: [
      q('welcome', 'section', 'Bienvenue !', 'Welcome!', {
        help_text: {
          fr: 'Merci de donner un coup de main au Soundclash. Ça prend deux minutes.',
          en: 'Thanks for helping out at Soundclash. It takes two minutes.',
        },
      }),
      q(
        'first',
        'short_text',
        'Comment veux-tu qu’on t’appelle ?',
        'What should we call you?',
        {
          target_path: 'volunteer.first_name',
          is_required: true,
        },
      ),
      q('last', 'short_text', 'Nom de famille', 'Last name', {
        target_path: 'volunteer.last_name',
      }),
      q('email', 'email', 'E-mail', 'Email', {
        target_path: 'volunteer.email',
        is_required: true,
      }),
      q('phone', 'phone', 'Téléphone', 'Phone', {
        target_path: 'volunteer.phone',
        is_required: true,
      }),
      q(
        'avail',
        'availability',
        'Quand es-tu disponible ?',
        'When are you available?',
        {
          is_required: true,
          help_text: {
            fr: '« Oui » si tu peux sur toute la durée, « En partie » pour préciser.',
            en: '“Yes” if you can do the whole time, “Partly” to be more precise.',
          },
        },
      ),
      q('missions', 'missions', 'Postes possibles', 'Possible missions', {
        options: [
          option('bar', 'Bar', { adults_only: true }),
          option('entrée', 'Entrée', { checked_by_default: true }),
          option('catering', 'Catering', { checked_by_default: true }),
          option('montage', 'Montage'),
          option('rangement', 'Rangement', { checked_by_default: true }),
        ],
      }),
      q('adult', 'boolean', 'J’ai 18 ans ou plus', 'I am 18 or older', {
        is_required: true,
      }),
      q('tshirt', 'single_choice', 'Taille de t-shirt', 'T-shirt size', {
        target_path: 'volunteer.tshirt_size',
        options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'].map((size) =>
          option(size, size),
        ),
      }),
      q('diet', 'long_text', 'Régime alimentaire', 'Dietary requirements', {
        target_path: 'volunteer.dietary',
        is_sensitive: true,
      }),
      q(
        'commitment',
        'consent',
        'Je confirme mon engagement bénévole auprès de Z·est Radio pour cet événement.',
        'I confirm my volunteer commitment to Z·est Radio for this event.',
        {
          consent_purpose: 'commitment',
          is_required: true,
          help_text: {
            fr: 'Je confirme participer bénévolement à l’organisation de cet événement pour le compte de l’association Z·est Radio, dans le cadre des missions qui me sont confiées.',
            en: 'I confirm that I am taking part, unpaid, in organising this event on behalf of the association Z·est Radio, within the missions entrusted to me.',
          },
        },
      ),
      q(
        'consent',
        'consent',
        'J’accepte que mes réponses soient utilisées pour organiser les bénévoles de cet événement.',
        'I agree to my answers being used to organise this event’s volunteers.',
        {
          consent_purpose: 'processing',
          is_required: true,
          help_text: {
            fr: 'Seule l’équipe d’organisation y a accès. Tes réponses sont supprimées à la fin de la saison.',
            en: 'Only the organising team can see them. Your answers are deleted at the end of the season.',
          },
        },
      ),
      q(
        'pool',
        'consent',
        'Vous pouvez me recontacter pour les prochaines éditions.',
        'You may contact me about future editions.',
        {
          consent_purpose: 'pool_retention',
        },
      ),
    ],
  },
  events: [
    event(
      'open-air',
      'Open Air',
      '2026-09-05T10:00:00+02:00',
      '2026-09-06T01:00:00+02:00',
      ['2026-09-05T14:00:00+02:00', '2026-09-06T00:00:00+02:00'],
    ),
    event(
      'montage',
      'Montage Molo',
      '2026-09-10T13:00:00+02:00',
      '2026-09-10T20:00:00+02:00',
    ),
    event(
      'dub',
      'Dub & 2step',
      '2026-09-11T13:00:00+02:00',
      '2026-09-12T08:00:00+02:00',
    ),
    event(
      'dnb',
      'Dnb & Dubstep',
      '2026-09-12T14:00:00+02:00',
      '2026-09-13T09:00:00+02:00',
    ),
    event(
      'after',
      'After',
      '2026-09-13T10:00:00+02:00',
      '2026-09-14T01:00:00+02:00',
    ),
    event(
      'demontage',
      'Démontage Molo',
      '2026-09-14T10:00:00+02:00',
      '2026-09-14T18:00:00+02:00',
    ),
  ],
  prefill: null,
};
