// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { Temporal } from '@evp/shared/time';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FormVersion, MissionOption, Question } from '../api/forms';
import { setLocale, t } from '../i18n';
import {
  addOption,
  appendQuestion,
  availableBuiltins,
  builtinOf,
  builtinQuestion,
  customQuestion,
  draftOf,
  eventDays,
  hasEditableOptions,
  isDirty,
  isRemovable,
  locateServerProblems,
  missionChoices,
  moveQuestion,
  offerMission,
  patchQuestion,
  positionBase,
  publishProblems,
  removeOption,
  removeQuestion,
  renameOption,
  requiredRule,
  saveProblems,
  sensitiveRule,
  slugify,
  toInput,
  uniqueValue,
  withdrawMission,
  type DraftQuestion,
  type FormDraft,
} from './formDraft';

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    position: 0,
    kind: 'short_text',
    target_path: null,
    consent_purpose: null,
    label: { fr: 'Question' },
    help_text: null,
    options: null,
    is_required: false,
    is_sensitive: false,
    builtin: false,
    ...overrides,
  };
}

/** The seeded draft docs/04 describes, for a scoped form. */
const SEEDED: readonly Question[] = [
  question({
    id: 'welcome',
    position: 0,
    kind: 'section',
    label: { fr: 'Bienvenue' },
  }),
  question({
    id: 'first',
    position: 1,
    target_path: 'volunteer.first_name',
    label: { fr: 'Prénom', en: 'First name' },
    is_required: true,
    builtin: true,
  }),
  question({
    id: 'last',
    position: 2,
    target_path: 'volunteer.last_name',
    label: { fr: 'Nom' },
    builtin: true,
  }),
  question({
    id: 'email',
    position: 3,
    kind: 'email',
    target_path: 'volunteer.email',
    label: { fr: 'E-mail' },
    is_required: true,
    builtin: true,
  }),
  question({
    id: 'phone',
    position: 4,
    kind: 'phone',
    target_path: 'volunteer.phone',
    label: { fr: 'Téléphone' },
    builtin: true,
  }),
  question({
    id: 'availability',
    position: 5,
    kind: 'availability',
    label: { fr: 'Disponibilités' },
    builtin: true,
  }),
  question({
    id: 'missions',
    position: 6,
    kind: 'missions',
    label: { fr: 'Postes possibles' },
    options: [
      {
        value: 'bar',
        label: { fr: 'Bar' },
        checked_by_default: false,
        adults_only: false,
      },
      {
        value: 'entrées',
        label: { fr: 'Entrées' },
        checked_by_default: false,
        adults_only: false,
      },
    ],
    builtin: true,
  }),
  question({
    id: 'commitment',
    position: 7,
    kind: 'consent',
    consent_purpose: 'commitment',
    label: { fr: 'Je confirme mon engagement bénévole' },
    is_required: true,
    builtin: true,
  }),
  question({
    id: 'consent',
    position: 8,
    kind: 'consent',
    consent_purpose: 'processing',
    label: { fr: 'J’accepte' },
    is_required: true,
    builtin: true,
  }),
];

function version(
  questions: readonly Question[] = SEEDED,
  overrides: Partial<FormVersion> = {},
): FormVersion {
  return {
    id: 'v-1',
    form_id: 'form-1',
    version: 1,
    published_at: null,
    privacy_notice_version: null,
    questions: [...questions],
    etag_version: 1,
    ...overrides,
  };
}

const BAR: MissionOption = {
  value: 'bar',
  label: 'Bar',
  event_ids: ['e1', 'e2'],
  checked_by_default: true,
  adults_only: false,
};
const ENTREES: MissionOption = {
  value: 'entrées',
  label: 'Entrées',
  event_ids: ['e1'],
  checked_by_default: true,
  adults_only: false,
};
const DJ: MissionOption = {
  value: 'dj',
  label: 'DJ',
  event_ids: ['e2'],
  checked_by_default: true,
  adults_only: false,
};

const ORG = 'Z·est Radio';

function counter(prefix = 'k'): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${String(n)}`;
  };
}

function keyOf(draft: FormDraft, index: number): string {
  return draft.questions[index]?.key ?? '';
}

function codes(problems: readonly { readonly code: string }[]): string[] {
  return problems.map((p) => p.code);
}

describe('draftOf / toInput', () => {
  it('orders by position, not by array order', () => {
    const draft = draftOf(
      version([
        question({ id: 'b', position: 2 }),
        question({ id: 'a', position: 1 }),
      ]),
    );
    expect(draft.questions.map((q) => q.key)).toEqual(['a', 'b']);
  });

  it('round-trips the seeded draft to the same wire shape', () => {
    const input = toInput(draftOf(version()));
    expect(input).toHaveLength(SEEDED.length);
    expect(input[1]).toEqual({
      kind: 'short_text',
      target_path: 'volunteer.first_name',
      consent_purpose: null,
      label: { fr: 'Prénom', en: 'First name' },
      help_text: null,
      options: null,
      is_required: true,
      is_sensitive: false,
    });
    expect(input[6]?.options).toEqual([
      { value: 'bar', label: { fr: 'Bar' } },
      { value: 'entrées', label: { fr: 'Entrées' } },
    ]);
  });

  it('omits an empty English label and trims both', () => {
    const draft = draftOf(version([question()]));
    const edited = patchQuestion(draft, 'q-1', {
      labelFr: '  Taille  ',
      labelEn: '   ',
    });
    expect(toInput(edited)[0]?.label).toEqual({ fr: 'Taille' });
  });

  it('sends help text only when some was written', () => {
    const draft = draftOf(version([question()]));
    expect(toInput(draft)[0]?.help_text).toBeNull();
    const helped = patchQuestion(draft, 'q-1', { helpFr: 'Une précision' });
    expect(toInput(helped)[0]?.help_text).toEqual({ fr: 'Une précision' });
  });

  it('reads a null English label the same as a missing one', () => {
    const draft = draftOf(
      version([question({ label: { fr: 'Oui', en: null } })]),
    );
    expect(draft.questions[0]?.labelEn).toBe('');
  });

  it('keeps an option skill id through the round trip', () => {
    const draft = draftOf(
      version([
        question({
          kind: 'multi_choice',
          options: [
            {
              value: 'psc1',
              label: { fr: 'PSC1' },
              skill_id: 's-1',
              checked_by_default: false,
              adults_only: false,
            },
          ],
        }),
      ]),
    );
    expect(toInput(draft)[0]?.options).toEqual([
      { value: 'psc1', label: { fr: 'PSC1' }, skill_id: 's-1' },
    ]);
  });

  it('gives a choice question with null options an empty list to edit', () => {
    const draft = draftOf(version([question({ kind: 'single_choice' })]));
    expect(draft.questions[0]?.options).toEqual([]);
  });
});

describe('isDirty', () => {
  it('is clean straight after loading', () => {
    expect(isDirty(version(), draftOf(version()))).toBe(false);
  });

  it('ignores whitespace the save would trim anyway', () => {
    const draft = patchQuestion(draftOf(version()), 'last', {
      labelFr: 'Nom ',
    });
    expect(isDirty(version(), draft)).toBe(false);
  });

  it('sees a reword, a toggle, a move and a privacy notice change', () => {
    const base = draftOf(version());
    expect(
      isDirty(
        version(),
        patchQuestion(base, 'last', { labelFr: 'Nom de famille' }),
      ),
    ).toBe(true);
    expect(
      isDirty(version(), patchQuestion(base, 'last', { isRequired: true })),
    ).toBe(true);
    const moved = moveQuestion(base, 'phone', -1);
    expect(moved).not.toBeNull();
    if (moved !== null) {
      expect(isDirty(version(), moved.draft)).toBe(true);
    }
    expect(
      isDirty(version(), { ...base, privacyNoticeVersion: '2026-09' }),
    ).toBe(true);
  });
});

describe('built-in identity and rules', () => {
  const draft = draftOf(version());
  const byKey = (key: string): DraftQuestion => {
    const found = draft.questions.find((q) => q.key === key);
    if (found === undefined) {
      throw new Error(key);
    }
    return found;
  };

  it('identifies built-ins by target, kind and consent purpose', () => {
    expect(builtinOf(byKey('first'))).toBe('first_name');
    expect(builtinOf(byKey('availability'))).toBe('availability');
    expect(builtinOf(byKey('missions'))).toBe('missions');
    expect(builtinOf(byKey('consent'))).toBe('processing_consent');
    expect(builtinOf(byKey('commitment'))).toBe('commitment');
    expect(builtinOf(byKey('welcome'))).toBeNull();
    expect(
      builtinOf({
        kind: 'consent',
        targetPath: null,
        consentPurpose: 'pool_retention',
      }),
    ).toBe('pool_consent');
    expect(builtinOf(customQuestion('boolean', 'x'))).toBeNull();
  });

  it('locks first name, email and processing consent as required', () => {
    expect(requiredRule(byKey('first'))).toBe('always');
    expect(requiredRule(byKey('email'))).toBe('always');
    expect(requiredRule(byKey('consent'))).toBe('always');
    expect(requiredRule(byKey('commitment'))).toBe('always');
    expect(requiredRule(byKey('last'))).toBe('choice');
    expect(requiredRule(byKey('availability'))).toBe('choice');
    expect(requiredRule(byKey('welcome'))).toBe('never');
    expect(
      requiredRule({
        kind: 'consent',
        targetPath: null,
        consentPurpose: 'pool_retention',
      }),
    ).toBe('never');
  });

  it('only lets the three locked built-ins stay put', () => {
    expect(isRemovable(byKey('first'))).toBe(false);
    expect(isRemovable(byKey('email'))).toBe(false);
    expect(isRemovable(byKey('consent'))).toBe(false);
    expect(isRemovable(byKey('phone'))).toBe(true);
    expect(isRemovable(byKey('missions'))).toBe(true);
    expect(isRemovable(byKey('welcome'))).toBe(true);
  });

  it('offers sensitivity on custom questions, forces it on dietary', () => {
    expect(sensitiveRule(customQuestion('short_text', 'x'))).toBe('choice');
    expect(sensitiveRule(customQuestion('section', 'x'))).toBe('fixed');
    expect(sensitiveRule(byKey('phone'))).toBe('fixed');
    expect(
      sensitiveRule(builtinQuestion('dietary', 'd', [], counter(), ORG)),
    ).toBe('always');
  });

  it('pins requiredness and sensitivity whatever the patch says', () => {
    let edited = patchQuestion(draft, 'first', { isRequired: false });
    expect(edited.questions.find((q) => q.key === 'first')?.isRequired).toBe(
      true,
    );

    edited = appendQuestion(
      draft,
      builtinQuestion('pool_consent', 'pool', [], counter(), ORG),
    );
    edited = patchQuestion(edited, 'pool', { isRequired: true });
    expect(edited.questions.find((q) => q.key === 'pool')?.isRequired).toBe(
      false,
    );

    edited = appendQuestion(
      draft,
      builtinQuestion('dietary', 'diet', [], counter(), ORG),
    );
    edited = patchQuestion(edited, 'diet', { isSensitive: false });
    expect(edited.questions.find((q) => q.key === 'diet')?.isSensitive).toBe(
      true,
    );

    edited = patchQuestion(draft, 'phone', { isSensitive: true });
    expect(edited.questions.find((q) => q.key === 'phone')?.isSensitive).toBe(
      false,
    );

    edited = appendQuestion(draft, customQuestion('long_text', 'c'));
    edited = patchQuestion(edited, 'c', {
      isSensitive: true,
      isRequired: true,
    });
    const custom = edited.questions.find((q) => q.key === 'c');
    expect(custom?.isSensitive).toBe(true);
    expect(custom?.isRequired).toBe(true);
  });
});

describe('moveQuestion', () => {
  const draft = draftOf(version());

  it('moves one step and says where it landed', () => {
    const moved = moveQuestion(draft, 'phone', -1);
    expect(moved?.index).toBe(3);
    expect(moved?.draft.questions.map((q) => q.key).slice(2, 5)).toEqual([
      'last',
      'phone',
      'email',
    ]);
  });

  it('moves down', () => {
    const moved = moveQuestion(draft, 'welcome', 1);
    expect(moved?.index).toBe(1);
    expect(
      moved === null ? [] : [keyOf(moved.draft, 0), keyOf(moved.draft, 1)],
    ).toEqual(['first', 'welcome']);
  });

  it('is a no-op at either end and for an unknown key', () => {
    expect(moveQuestion(draft, 'welcome', -1)).toBeNull();
    expect(moveQuestion(draft, 'consent', 1)).toBeNull();
    expect(moveQuestion(draft, 'nope', 1)).toBeNull();
  });
});

describe('removeQuestion', () => {
  const draft = draftOf(version());

  it('removes what may be removed', () => {
    expect(removeQuestion(draft, 'phone').questions).toHaveLength(
      SEEDED.length - 1,
    );
  });

  it('refuses the locked built-ins', () => {
    expect(removeQuestion(draft, 'first').questions).toHaveLength(
      SEEDED.length,
    );
    expect(removeQuestion(draft, 'email').questions).toHaveLength(
      SEEDED.length,
    );
    expect(removeQuestion(draft, 'commitment').questions).toHaveLength(
      SEEDED.length,
    );
    expect(removeQuestion(draft, 'consent').questions).toHaveLength(
      SEEDED.length,
    );
  });
});

describe('palette', () => {
  it('offers what the seeded draft lacks, in docs/09 order', () => {
    expect(availableBuiltins(draftOf(version()), true)).toEqual([
      'tshirt_size',
      'dietary',
      'notes',
      'pool_consent',
    ]);
  });

  it('offers a removed built-in again', () => {
    const draft = removeQuestion(draftOf(version()), 'phone');
    expect(availableBuiltins(draft, true)).toContain('phone');
  });

  it('never offers availability or missions on an unscoped form', () => {
    const empty: FormDraft = { privacyNoticeVersion: '', questions: [] };
    const offered = availableBuiltins(empty, false);
    expect(offered).not.toContain('availability');
    expect(offered).not.toContain('missions');
    expect(offered.slice(0, 4)).toEqual([
      'first_name',
      'email',
      'processing_consent',
      'commitment',
    ]);
  });

  it('builds the t-shirt question with the fixed sizes', () => {
    const tshirt = builtinQuestion('tshirt_size', 't', [], counter(), ORG);
    expect(tshirt.kind).toBe('single_choice');
    expect(tshirt.targetPath).toBe('volunteer.tshirt_size');
    expect(tshirt.options?.map((o) => o.value)).toEqual([
      'xs',
      's',
      'm',
      'l',
      'xl',
      'xxl',
      '3xl',
    ]);
    expect(tshirt.options?.every((o) => o.valueFixed)).toBe(true);
    expect(hasEditableOptions(tshirt)).toBe(false);
  });

  it('offers every scope mission on a new missions question', () => {
    const missions = builtinQuestion(
      'missions',
      'm',
      [BAR, DJ],
      counter(),
      ORG,
    );
    expect(missions.options?.map((o) => [o.value, o.labelFr])).toEqual([
      ['bar', 'Bar'],
      ['dj', 'DJ'],
    ]);
  });

  it('starts the consents as the rules say', () => {
    expect(
      builtinQuestion('processing_consent', 'c', [], counter(), ORG).isRequired,
    ).toBe(true);
    expect(
      builtinQuestion('pool_consent', 'p', [], counter(), ORG).isRequired,
    ).toBe(false);
    expect(
      builtinQuestion('dietary', 'd', [], counter(), ORG).isSensitive,
    ).toBe(true);
  });

  it('builds the commitment required, naming the organisation in both languages', () => {
    const commitment = builtinQuestion('commitment', 'c', [], counter(), ORG);
    expect(commitment.kind).toBe('consent');
    expect(commitment.consentPurpose).toBe('commitment');
    expect(commitment.isRequired).toBe(true);
    expect(isRemovable(commitment)).toBe(false);
    expect(commitment.labelFr).toBe(
      'Je confirme mon engagement bénévole auprès de Z·est Radio pour cet événement.',
    );
    expect(commitment.labelEn).toBe(
      'I confirm my volunteer commitment to Z·est Radio for this event.',
    );
    expect(commitment.helpFr).toBe(
      'Je confirme participer bénévolement à l’organisation de cet événement pour le compte de l’association Z·est Radio, dans le cadre des missions qui me sont confiées.',
    );
    expect(commitment.helpEn).toContain(
      'on behalf of the association Z·est Radio',
    );
  });

  it('gives custom choice kinds an empty option list and the rest none', () => {
    expect(customQuestion('single_choice', 'a').options).toEqual([]);
    expect(customQuestion('multi_choice', 'a').options).toEqual([]);
    expect(customQuestion('boolean', 'a').options).toBeNull();
    expect(customQuestion('section', 'a').options).toBeNull();
    expect(hasEditableOptions(customQuestion('multi_choice', 'a'))).toBe(true);
  });
});

describe('option values', () => {
  it('slugs labels, folding accents rather than dropping letters', () => {
    expect(slugify('Débutant')).toBe('debutant');
    expect(slugify('  Bar & grill ')).toBe('bar-grill');
    expect(slugify('Été 2026 — équipe fly')).toBe('ete-2026-equipe-fly');
    expect(slugify('!!!')).toBe('');
  });

  it('suffixes a taken value and never returns an empty one', () => {
    expect(uniqueValue('Oui', new Set(['oui']))).toBe('oui-2');
    expect(uniqueValue('Oui', new Set(['oui', 'oui-2']))).toBe('oui-3');
    expect(uniqueValue('?', new Set())).toBe('option');
  });

  it('lets a new option follow its label, and freezes a saved one', () => {
    let options = addOption([], 'o1');
    options = renameOption(options, 'o1', { fr: 'Confirmé·e' });
    expect(options[0]?.value).toBe('confirme-e');

    const saved =
      draftOf(
        version([
          question({
            kind: 'single_choice',
            options: [
              {
                value: 'debutant',
                label: { fr: 'Débutant' },
                checked_by_default: false,
                adults_only: false,
              },
            ],
          }),
        ]),
      ).questions[0]?.options ?? [];
    const renamed = renameOption(saved, 'q-1#0', { fr: 'Novice' });
    expect(renamed[0]?.value).toBe('debutant');
    expect(renamed[0]?.labelFr).toBe('Novice');
  });

  it('keeps a renamed new option unique among its siblings', () => {
    let options = addOption([], 'o1', 'Oui');
    options = addOption(options, 'o2');
    options = renameOption(options, 'o2', { fr: 'oui' });
    expect(options.map((o) => o.value)).toEqual(['oui', 'oui-2']);
  });

  it('renames English without touching the value', () => {
    const options = renameOption(addOption([], 'o1', 'Oui'), 'o1', {
      en: 'Yes',
    });
    expect(options[0]).toMatchObject({
      value: 'oui',
      labelFr: 'Oui',
      labelEn: 'Yes',
    });
  });

  it('removes by key', () => {
    const options = addOption(addOption([], 'o1', 'A'), 'o2', 'B');
    expect(removeOption(options, 'o1').map((o) => o.key)).toEqual(['o2']);
  });
});

describe('missions checklist', () => {
  const offered =
    draftOf(version()).questions.find((q) => q.kind === 'missions')?.options ??
    [];

  it('lists offered missions, then the scope missions not offered', () => {
    const choices = missionChoices(offered, [BAR, ENTREES, DJ]);
    expect(
      choices.map((c) => [c.value, c.option !== null, c.mission !== null]),
    ).toEqual([
      ['bar', true, true],
      ['entrées', true, true],
      ['dj', false, true],
    ]);
  });

  it('keeps an offered mission the scope no longer has, unresolved', () => {
    const choices = missionChoices(offered, [BAR]);
    expect(choices.find((c) => c.value === 'entrées')?.mission).toBeNull();
  });

  it('offers once, withdraws by value', () => {
    const withDj = offerMission(offered, DJ, 'k');
    expect(withDj.map((o) => o.value)).toEqual(['bar', 'entrées', 'dj']);
    expect(offerMission(withDj, DJ, 'k2')).toHaveLength(3);
    expect(withdrawMission(withDj, 'bar').map((o) => o.value)).toEqual([
      'entrées',
      'dj',
    ]);
  });
});

describe('saveProblems', () => {
  const scoped = { scoped: true };
  const publishable = { defaultLocale: 'fr' as const, missionValues: null };

  it('passes the seeded draft', () => {
    expect(saveProblems(draftOf(version()), scoped)).toEqual([]);
  });

  it('names the later of two questions with one target', () => {
    const draft = appendQuestion(
      draftOf(version()),
      builtinQuestion('phone', 'phone-2', [], counter(), ORG),
    );
    const problems = saveProblems(draft, scoped);
    expect(problems).toEqual([
      expect.objectContaining({
        questionKey: 'phone-2',
        code: 'duplicate_target',
      }),
    ]);
  });

  it('refuses a second availability, missions or consent of one purpose', () => {
    let draft = draftOf(version());
    draft = appendQuestion(
      draft,
      builtinQuestion('availability', 'a2', [], counter(), ORG),
    );
    draft = appendQuestion(
      draft,
      builtinQuestion('missions', 'm2', [BAR], counter(), ORG),
    );
    draft = appendQuestion(
      draft,
      builtinQuestion('processing_consent', 'c2', [], counter(), ORG),
    );
    expect(codes(saveProblems(draft, scoped))).toEqual([
      'duplicate_availability',
      'duplicate_missions',
      'duplicate_consent',
    ]);
  });

  it('allows one consent of each purpose', () => {
    const draft = appendQuestion(
      draftOf(version()),
      builtinQuestion('pool_consent', 'pool', [], counter(), ORG),
    );
    expect(saveProblems(draft, scoped)).toEqual([]);
  });

  it('refuses a required pool-retention consent as the server stores it', () => {
    const draft = draftOf(
      version([
        question({
          kind: 'consent',
          consent_purpose: 'pool_retention',
          is_required: true,
        }),
      ]),
    );
    expect(codes(saveProblems(draft, scoped))).toEqual([
      'pool_retention_required',
    ]);
  });

  it('wants a French label, including on options', () => {
    let draft = appendQuestion(
      draftOf(version()),
      customQuestion('single_choice', 'c'),
    );
    expect(codes(saveProblems(draft, scoped))).toEqual(['label_missing']);
    expect(codes(publishProblems(draft, publishable))).toContain(
      'options_empty',
    );

    draft = patchQuestion(draft, 'c', {
      labelFr: 'Niveau',
      options: addOption([], 'o1'),
    });
    expect(codes(saveProblems(draft, scoped))).toEqual([
      'option_label_missing',
    ]);
  });

  it('refuses English help with no French', () => {
    const draft = patchQuestion(draftOf(version()), 'phone', {
      helpEn: 'Mobile',
    });
    expect(codes(saveProblems(draft, scoped))).toEqual(['help_missing_fr']);
  });

  it('refuses options on a kind that takes none', () => {
    const draft = draftOf(
      version([
        question({
          options: [
            {
              value: 'x',
              label: { fr: 'X' },
              checked_by_default: false,
              adults_only: false,
            },
          ],
        }),
      ]),
    );
    expect(codes(saveProblems(draft, scoped))).toEqual(['options_unexpected']);
  });

  it('refuses an email or phone question that feeds nothing', () => {
    const draft = draftOf(version([question({ kind: 'phone' })]));
    expect(codes(saveProblems(draft, scoped))).toEqual(['contact_untargeted']);
  });

  it('refuses availability and missions on an unscoped form', () => {
    expect(codes(saveProblems(draftOf(version()), { scoped: false }))).toEqual([
      'unscoped',
      'unscoped',
    ]);
  });

  it('refuses a choice question whose option list is missing altogether', () => {
    const draft = draftOf(version([question({ kind: 'multi_choice' })]));
    const broken = patchQuestion(draft, 'q-1', { options: null });
    expect(codes(saveProblems(broken, scoped))).toEqual(['options_missing']);
  });

  it('accepts a missions question with no missions to offer yet', () => {
    const draft = draftOf(
      version([question({ kind: 'missions', options: [] })]),
    );
    expect(saveProblems(draft, scoped)).toEqual([]);
  });
});

describe('publishProblems', () => {
  const context = {
    defaultLocale: 'fr' as const,
    missionValues: new Set(['bar', 'entrées']),
  };

  it('passes the seeded draft', () => {
    expect(publishProblems(draftOf(version()), context)).toEqual([]);
  });

  it('wants the processing consent, the commitment, first name and email', () => {
    const draft: FormDraft = { privacyNoticeVersion: '', questions: [] };
    expect(codes(publishProblems(draft, context))).toEqual([
      'processing_consent_missing',
      'commitment_missing',
      'first_name_missing',
      'email_missing',
    ]);
  });

  it('names a locked built-in stored as optional', () => {
    const draft = draftOf(
      version(
        SEEDED.map((q) =>
          q.id === 'email' ? { ...q, is_required: false } : q,
        ),
      ),
    );
    expect(publishProblems(draft, context)).toEqual([
      expect.objectContaining({
        questionKey: 'email',
        code: 'must_be_required',
      }),
    ]);
  });

  it('refuses two options with one value', () => {
    const draft = draftOf(
      version([
        ...SEEDED,
        question({
          id: 'level',
          position: 9,
          kind: 'single_choice',
          options: [
            {
              value: 'a',
              label: { fr: 'A' },
              checked_by_default: false,
              adults_only: false,
            },
            {
              value: 'a',
              label: { fr: 'A bis' },
              checked_by_default: false,
              adults_only: false,
            },
          ],
        }),
      ]),
    );
    expect(codes(publishProblems(draft, context))).toEqual([
      'duplicate_option',
    ]);
  });

  it('names missions that no longer resolve, once the list has loaded', () => {
    const draft = draftOf(version());
    const stale = { ...context, missionValues: new Set(['bar']) };
    const problems = publishProblems(draft, stale);
    expect(codes(problems)).toEqual(['mission_unresolved']);
    expect(problems[0]?.message).toBe(
      'No longer matches any mission: Entrées.',
    );
    expect(publishProblems(draft, { ...context, missionValues: null })).toEqual(
      [],
    );
  });

  it('wants English everywhere when English is the default', () => {
    const draft = draftOf(version([SEEDED[1] ?? question()]));
    const problems = publishProblems(draft, {
      ...context,
      defaultLocale: 'en',
    });
    expect(codes(problems)).not.toContain('label_missing_en');

    const untranslated = draftOf(version([SEEDED[2] ?? question()]));
    expect(
      codes(publishProblems(untranslated, { ...context, defaultLocale: 'en' })),
    ).toContain('label_missing_en');
  });
});

// The builder is written French-first; its messages are checked in the
// language its coordinators read, not only in the suite's English.
describe('in French', () => {
  beforeAll(async () => {
    await setLocale('fr');
  });
  afterAll(async () => {
    await setLocale('en');
  });

  it('words problems in the language of the call', () => {
    const draft: FormDraft = { privacyNoticeVersion: '', questions: [] };
    const problems = publishProblems(draft, {
      defaultLocale: 'fr',
      missionValues: null,
    });
    expect(problems.map((p) => p.message)).toEqual([
      'Il manque le consentement au traitement des réponses\u00a0: un formulaire ne peut pas être publié sans lui.',
      'Il manque la confirmation d’engagement bénévole : un formulaire ne peut pas être publié sans elle.',
      'Il manque la question du prénom.',
      'Il manque la question de l’adresse e-mail.',
    ]);
  });

  it('counts questions with French plurals, where 0 is singular', () => {
    const count = (n: number) =>
      t('forms.page.versions.questionCount', { count: n });
    expect([count(0), count(1), count(2)]).toEqual([
      '· 0 question',
      '· 1 question',
      '· 2 questions',
    ]);
  });
});

describe('server problems', () => {
  it('pins each problem to the question at its position', () => {
    const located = locateServerProblems(
      [
        { position: 3, code: 'x', message: 'Trois' },
        { position: null, code: 'y', message: 'Forme' },
        { position: 99, code: 'z', message: 'Nulle part' },
      ],
      [
        { position: 3, key: 'email' },
        { position: 4, key: 'phone' },
      ],
    );
    expect(located.map((p) => p.questionKey)).toEqual(['email', null, null]);
    expect(located.map((p) => p.message)).toEqual([
      'Trois',
      'Forme',
      'Nulle part',
    ]);
  });

  it('reads the position base off the stored questions', () => {
    expect(positionBase(version())).toBe(0);
    expect(
      positionBase(
        version([
          question({ id: 'a', position: 2 }),
          question({ id: 'b', position: 1 }),
        ]),
      ),
    ).toBe(1);
    expect(positionBase(version([]))).toBe(0);
  });
});

describe('eventDays', () => {
  it('lists each calendar day of a multi-day event, in its own zone', () => {
    // 2026-09-04 08:00 → 2026-09-06 23:00, Paris (UTC+2).
    const days = eventDays(
      { start: '2026-09-04T06:00:00Z', end: '2026-09-06T21:00:00Z' },
      'Europe/Paris',
    );
    expect(days).toHaveLength(3);
  });

  it('keeps a night that ends after midnight on the day it starts', () => {
    // Saturday 22:00 → Sunday 05:00, Paris.
    const days = eventDays(
      { start: '2026-09-05T20:00:00Z', end: '2026-09-06T03:00:00Z' },
      'Europe/Paris',
    );
    expect(days).toHaveLength(1);
  });

  it('opens a day for an end past the overnight cutoff', () => {
    // Saturday 22:00 → Sunday 10:00, Paris.
    const days = eventDays(
      { start: '2026-09-05T20:00:00Z', end: '2026-09-06T08:00:00Z' },
      'Europe/Paris',
    );
    expect(days).toHaveLength(2);
  });

  it('dates by the event zone, not by UTC', () => {
    // 23:30 UTC on the 4th is already the 5th in Paris.
    const [first] = eventDays(
      { start: '2026-09-04T23:30:00Z', end: '2026-09-05T20:00:00Z' },
      'Europe/Paris',
    );
    expect(first).toBe(
      Temporal.Instant.from('2026-09-05T10:00:00Z').epochMilliseconds,
    );
  });
});
