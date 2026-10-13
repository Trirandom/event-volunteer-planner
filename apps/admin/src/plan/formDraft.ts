// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * A form version's questions as something a coordinator can edit, and back.
 *
 * The server's `Question` is the wrong shape to type into: `label` is an
 * object whose `en` may be missing, `help_text` is `null` or an object,
 * `options` is `null` on a kind that takes none. A text box wants a string,
 * always. So a draft holds plain strings and turns them back into the wire's
 * shape in one place (`toInput`), and "is there anything to save?" is
 * answered by comparing the two *wire* shapes — which is what makes a
 * coordinator who types a space and deletes it again look unchanged.
 *
 * **Built-ins are identified by what their answer feeds**, not by a flag.
 * The server derives `builtin` from `target_path` and kind (docs/04), and the
 * rules about them — which are always required, which can never be, which may
 * not be removed (docs/09 §1 "Built-in and custom questions", ADR-0025,
 * ADR-0037) — follow the same identity. Deriving it here the same way means a
 * draft question added from the palette is recognised as built-in before the
 * server has ever seen it.
 *
 * **The pre-check is a mirror, not the authority.** `saveProblems` repeats the
 * rules docs/04 says `PUT` refuses with `422`, so the obvious mistakes are
 * named on the card that has them before the round trip; `publishProblems`
 * repeats the whole-form ones publish adds. The server still decides both —
 * which is why a server refusal is shown through the same channel
 * (`locateServerProblems`) rather than replaced by ours.
 *
 * Pure. The page that holds a draft is `views/PlanFormView.vue`.
 */
import { Temporal } from '@evp/shared/time';

import type {
  ConsentPurpose,
  FormLocale,
  FormVersion,
  MissionOption,
  PublishProblem,
  Question,
  QuestionInput,
  QuestionKind,
  TargetPath,
} from '../api/forms';
import { t, type AdminMessageKey } from '../i18n';

export interface DraftOption {
  /** Client-side identity: stable across renames, never sent. */
  readonly key: string;
  readonly value: string;
  readonly labelFr: string;
  readonly labelEn: string;
  readonly skillId: string | null;
  /**
   * The value may no longer follow the label. True for every option the
   * server already holds — a submission may have answered with that value,
   * and renaming "Débutant" to "Novice" must not orphan it — and for the
   * fixed sizes and the missions' folded keys, which were never slugs of a
   * label in the first place.
   */
  readonly valueFixed: boolean;
}

export interface DraftQuestion {
  /** The server's question id once saved; a client key before that. */
  readonly key: string;
  readonly kind: QuestionKind;
  readonly targetPath: TargetPath | null;
  readonly consentPurpose: ConsentPurpose | null;
  readonly labelFr: string;
  readonly labelEn: string;
  readonly helpFr: string;
  readonly helpEn: string;
  /** `null` exactly on a kind that takes none. */
  readonly options: readonly DraftOption[] | null;
  readonly isRequired: boolean;
  readonly isSensitive: boolean;
}

export interface FormDraft {
  readonly privacyNoticeVersion: string;
  readonly questions: readonly DraftQuestion[];
}

// ── Built-in identity ───────────────────────────────────────────────────────

export type BuiltinId =
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'phone'
  | 'tshirt_size'
  | 'dietary'
  | 'notes'
  | 'availability'
  | 'missions'
  | 'processing_consent'
  | 'pool_consent'
  | 'commitment';

const BUILTIN_BY_TARGET: Readonly<Record<TargetPath, BuiltinId>> = {
  'volunteer.first_name': 'first_name',
  'volunteer.last_name': 'last_name',
  'volunteer.email': 'email',
  'volunteer.phone': 'phone',
  'volunteer.tshirt_size': 'tshirt_size',
  'volunteer.dietary': 'dietary',
  'volunteer.notes': 'notes',
};

type Identity = Pick<DraftQuestion, 'kind' | 'targetPath' | 'consentPurpose'>;

/** Which built-in this is, or `null` for a custom question or a section. */
export function builtinOf(question: Identity): BuiltinId | null {
  if (question.targetPath !== null) {
    return BUILTIN_BY_TARGET[question.targetPath];
  }
  if (question.kind === 'availability' || question.kind === 'missions') {
    return question.kind;
  }
  if (question.kind === 'consent') {
    switch (question.consentPurpose) {
      case 'pool_retention':
        return 'pool_consent';
      case 'commitment':
        return 'commitment';
      default:
        return 'processing_consent';
    }
  }
  return null;
}

/**
 * Whether the coordinator decides requiredness.
 *
 * `always`: the public route cannot reconcile without an address, a greeting
 * needs a name (ADR-0037), processing is what the whole submission rests
 * on (ADR-0025), and the commitment is what makes the help unpaid and on the
 * organisation's behalf (ADR-0040). `never`: pool retention, because refusing it must not stop
 * anyone volunteering — the schema refuses it outright. A section takes no
 * answer, so it has nothing to require.
 */
export type RequiredRule = 'always' | 'never' | 'choice';

export function requiredRule(question: Identity): RequiredRule {
  if (question.kind === 'section') {
    return 'never';
  }
  const builtin = builtinOf(question);
  if (
    builtin === 'first_name' ||
    builtin === 'email' ||
    builtin === 'processing_consent' ||
    builtin === 'commitment'
  ) {
    return 'always';
  }
  return builtin === 'pool_consent' ? 'never' : 'choice';
}

/**
 * Whether the coordinator decides sensitivity.
 *
 * Only on custom questions (ADR-0037). Dietary is sensitive by nature — it
 * can imply religion or health (docs/09 §8) — and every other built-in lands
 * in a column whose handling is already decided, so offering the toggle there
 * would be offering a switch that changes nothing a coordinator can see.
 */
export type SensitiveRule = 'always' | 'fixed' | 'choice';

export function sensitiveRule(question: Identity): SensitiveRule {
  const builtin = builtinOf(question);
  if (builtin === 'dietary') {
    return 'always';
  }
  return builtin === null && question.kind !== 'section' ? 'choice' : 'fixed';
}

/** docs/04: first name, email, the processing consent and the commitment
 * "cannot be removed or made optional" — the same four `requiredRule` pins. */
export function isRemovable(question: Identity): boolean {
  return requiredRule(question) !== 'always';
}

/** The kinds that must carry options, and the one whose options come from
 * the scope rather than from the coordinator. */
function takesOptions(kind: QuestionKind): boolean {
  return (
    kind === 'single_choice' || kind === 'multi_choice' || kind === 'missions'
  );
}

// ── Server ⇄ draft ──────────────────────────────────────────────────────────

function optionsOf(question: Question): DraftOption[] | null {
  if (question.options === null || question.options === undefined) {
    return takesOptions(question.kind) ? [] : null;
  }
  return question.options.map((option, index) => ({
    key: `${question.id}#${String(index)}`,
    value: option.value,
    labelFr: option.label.fr,
    labelEn: option.label.en ?? '',
    skillId: option.skill_id ?? null,
    valueFixed: true,
  }));
}

/** A stored question, as editable strings. Nothing is corrected on the way
 * in: a stored `first_name` that is somehow optional shows as optional, and
 * the pre-check says so, rather than the editor quietly repairing what the
 * server holds and calling the result unchanged. */
export function draftQuestionOf(question: Question): DraftQuestion {
  return {
    key: question.id,
    kind: question.kind,
    targetPath: question.target_path,
    consentPurpose: question.consent_purpose,
    labelFr: question.label.fr,
    labelEn: question.label.en ?? '',
    helpFr: question.help_text?.fr ?? '',
    helpEn: question.help_text?.en ?? '',
    options: optionsOf(question),
    isRequired: question.is_required,
    isSensitive: question.is_sensitive,
  };
}

/** Sorted by `position` rather than trusted to arrive in order: the array
 * order is what a `PUT` means by order, so reading it any other way would
 * reorder the form on the first save. */
export function draftOf(version: FormVersion): FormDraft {
  return {
    privacyNoticeVersion: version.privacy_notice_version ?? '',
    questions: [...version.questions]
      .sort((a, b) => a.position - b.position)
      .map(draftQuestionOf),
  };
}

function localized(
  fr: string,
  en: string,
): { readonly fr: string; readonly en?: string } {
  const trimmedEn = en.trim();
  return trimmedEn === ''
    ? { fr: fr.trim() }
    : { fr: fr.trim(), en: trimmedEn };
}

/** The `PUT` body's questions, in the draft's order. */
export function toInput(draft: FormDraft): QuestionInput[] {
  return draft.questions.map((question) => ({
    kind: question.kind,
    target_path: question.targetPath,
    consent_purpose: question.consentPurpose,
    label: localized(question.labelFr, question.labelEn),
    help_text:
      question.helpFr.trim() === '' && question.helpEn.trim() === ''
        ? null
        : localized(question.helpFr, question.helpEn),
    options:
      question.options === null
        ? null
        : question.options.map((option) => ({
            value: option.value,
            label: localized(option.labelFr, option.labelEn),
            ...(option.skillId === null ? {} : { skill_id: option.skillId }),
          })),
    is_required: question.isRequired,
    is_sensitive: question.isSensitive,
  }));
}

/** `null` rather than `""` on the wire: docs/04 makes the field optional, and
 * an empty notice version would be recorded against every submission as
 * though it named one. */
export function privacyNoticeOf(draft: FormDraft): string | null {
  const trimmed = draft.privacyNoticeVersion.trim();
  return trimmed === '' ? null : trimmed;
}

/** Whether saving would change anything. Compared on the wire shape, so
 * whitespace a `PUT` would trim anyway does not count as an edit. */
export function isDirty(saved: FormVersion, draft: FormDraft): boolean {
  const before = draftOf(saved);
  return (
    JSON.stringify(toInput(before)) !== JSON.stringify(toInput(draft)) ||
    privacyNoticeOf(before) !== privacyNoticeOf(draft)
  );
}

// ── Editing ─────────────────────────────────────────────────────────────────

export type QuestionPatch = Partial<
  Pick<
    DraftQuestion,
    | 'labelFr'
    | 'labelEn'
    | 'helpFr'
    | 'helpEn'
    | 'isRequired'
    | 'isSensitive'
    | 'options'
  >
>;

/**
 * Applies a patch, then pins what the rules pin. A disabled toggle is the
 * UI's half of that; this is the half that holds when the patch came from
 * anywhere else.
 */
export function patchQuestion(
  draft: FormDraft,
  key: string,
  patch: QuestionPatch,
): FormDraft {
  return {
    ...draft,
    questions: draft.questions.map((question) => {
      if (question.key !== key) {
        return question;
      }
      const next = { ...question, ...patch };
      const required = requiredRule(next);
      const sensitive = sensitiveRule(next);
      return {
        ...next,
        isRequired:
          required === 'always'
            ? true
            : required === 'never'
              ? false
              : next.isRequired,
        isSensitive:
          sensitive === 'always'
            ? true
            : sensitive === 'fixed'
              ? question.isSensitive
              : next.isSensitive,
      };
    }),
  };
}

/** The result of a move, with where the question ended up so the page can
 * announce it and put focus back on it. `null` when it was already at that
 * end — a no-op the caller should say nothing about. */
export function moveQuestion(
  draft: FormDraft,
  key: string,
  delta: -1 | 1,
): { readonly draft: FormDraft; readonly index: number } | null {
  const from = draft.questions.findIndex((question) => question.key === key);
  const to = from + delta;
  const moving = draft.questions[from];
  if (from === -1 || moving === undefined || to < 0) {
    return null;
  }
  if (to >= draft.questions.length) {
    return null;
  }
  const rest = draft.questions.filter((question) => question.key !== key);
  return {
    draft: {
      ...draft,
      questions: [...rest.slice(0, to), moving, ...rest.slice(to)],
    },
    index: to,
  };
}

/** Removes a question the rules allow removing, and refuses the rest by
 * returning the draft unchanged. */
export function removeQuestion(draft: FormDraft, key: string): FormDraft {
  return {
    ...draft,
    questions: draft.questions.filter(
      (question) => question.key !== key || !isRemovable(question),
    ),
  };
}

export function appendQuestion(
  draft: FormDraft,
  question: DraftQuestion,
): FormDraft {
  return { ...draft, questions: [...draft.questions, question] };
}

// ── Options ─────────────────────────────────────────────────────────────────

/**
 * A label, as an option value: lowercase ASCII, words joined by `-`.
 *
 * Diacritics are folded rather than dropped, so «Débutant» is `debutant` and
 * not `dbutant`. `NFD` then stripping combining marks is exactly that fold;
 * anything left that is not a letter or digit becomes a separator. Plain
 * `toLowerCase` for the reason `missionKey` gives — the locale-aware one reads
 * the host's locale.
 */
export function slugify(label: string): string {
  return label
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** `slugify`, made unique among `taken` by a numeric suffix, and never empty
 * — a label of only punctuation still needs a value. */
export function uniqueValue(label: string, taken: ReadonlySet<string>): string {
  const base = slugify(label) === '' ? 'option' : slugify(label);
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${String(suffix)}`)) {
    suffix += 1;
  }
  return `${base}-${String(suffix)}`;
}

function valuesExcept(
  options: readonly DraftOption[],
  key: string | null,
): Set<string> {
  return new Set(
    options.filter((option) => option.key !== key).map((o) => o.value),
  );
}

export function addOption(
  options: readonly DraftOption[],
  key: string,
  labelFr = '',
): DraftOption[] {
  return [
    ...options,
    {
      key,
      value: uniqueValue(labelFr, valuesExcept(options, null)),
      labelFr,
      labelEn: '',
      skillId: null,
      valueFixed: false,
    },
  ];
}

/** Renames an option; its value follows the French label only until the
 * option has been saved once (see `DraftOption.valueFixed`). */
export function renameOption(
  options: readonly DraftOption[],
  key: string,
  label: { readonly fr?: string; readonly en?: string },
): DraftOption[] {
  return options.map((option) => {
    if (option.key !== key) {
      return option;
    }
    const labelFr = label.fr ?? option.labelFr;
    return {
      ...option,
      labelFr,
      labelEn: label.en ?? option.labelEn,
      value: option.valueFixed
        ? option.value
        : uniqueValue(labelFr, valuesExcept(options, key)),
    };
  });
}

export function removeOption(
  options: readonly DraftOption[],
  key: string,
): DraftOption[] {
  return options.filter((option) => option.key !== key);
}

// ── The missions question ───────────────────────────────────────────────────

/** One row of the missions checklist: a mission the scope has, an option
 * the draft offers, or both. */
export interface MissionChoice {
  readonly value: string;
  /** The option, when this mission is offered. */
  readonly option: DraftOption | null;
  /** The scope's mission, when it still has one by this key. `null` is an
   * offered option that no longer resolves — renamed or deleted on the
   * missions page since — which publish refuses. */
  readonly mission: MissionOption | null;
}

/**
 * Offered options first, in the order the volunteer will see them, then every
 * mission the scope has that is not offered — which is how a mission added on
 * the missions page after this draft was made turns up: as an unticked
 * suggestion, not silently added and not silently missing.
 */
export function missionChoices(
  options: readonly DraftOption[],
  scopeMissions: readonly MissionOption[],
): MissionChoice[] {
  const byValue = new Map(scopeMissions.map((m) => [m.value, m]));
  const offered = new Set(options.map((option) => option.value));
  return [
    ...options.map((option) => ({
      value: option.value,
      option,
      mission: byValue.get(option.value) ?? null,
    })),
    ...scopeMissions
      .filter((mission) => !offered.has(mission.value))
      .map((mission) => ({ value: mission.value, option: null, mission })),
  ];
}

export function offerMission(
  options: readonly DraftOption[],
  mission: MissionOption,
  key: string,
): DraftOption[] {
  if (options.some((option) => option.value === mission.value)) {
    return [...options];
  }
  return [
    ...options,
    {
      key,
      value: mission.value,
      labelFr: mission.label,
      labelEn: '',
      skillId: null,
      valueFixed: true,
    },
  ];
}

export function withdrawMission(
  options: readonly DraftOption[],
  value: string,
): DraftOption[] {
  return options.filter((option) => option.value !== value);
}

// ── The palette ─────────────────────────────────────────────────────────────

export const CUSTOM_KINDS = [
  'short_text',
  'long_text',
  'single_choice',
  'multi_choice',
  'boolean',
  'date',
] as const;

export type CustomKind = (typeof CUSTOM_KINDS)[number];

/** The order the palette offers them in: the four a form cannot publish
 * without first, should one somehow be missing, then the rest as docs/09
 * lists them. */
const PALETTE_BUILTINS: readonly BuiltinId[] = [
  'first_name',
  'email',
  'processing_consent',
  'commitment',
  'last_name',
  'phone',
  'tshirt_size',
  'dietary',
  'notes',
  'availability',
  'missions',
  'pool_consent',
];

/**
 * The built-ins that could be added: those not already on the form, and not
 * `availability`/`missions` on an unscoped one, which has no days and no
 * missions to ask about (docs/04's `PUT` refuses both there).
 */
export function availableBuiltins(
  draft: FormDraft,
  scoped: boolean,
): BuiltinId[] {
  const present = new Set(draft.questions.map(builtinOf));
  return PALETTE_BUILTINS.filter(
    (id) =>
      !present.has(id) &&
      (scoped || (id !== 'availability' && id !== 'missions')),
  );
}

export const TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'] as const;

interface Template {
  readonly kind: QuestionKind;
  readonly targetPath: TargetPath | null;
  readonly consentPurpose: ConsentPurpose | null;
  readonly fr: string;
  readonly en: string;
  readonly help?: { readonly fr: string; readonly en: string };
  readonly isRequired: boolean;
  readonly isSensitive: boolean;
}

/** The wording a built-in starts with. Copy, not policy: every label is
 * editable, and these are what the Soundclash form asked, tidied. Not in the
 * i18n catalogue: they become the question's stored `{ fr, en }` label, which
 * follows the form's languages, not the language of the builder.
 *
 * `{organization}` is replaced by the organisation's name when the question
 * is added, as the server's seeded draft does (ADR-0040). */
const BUILTIN_TEMPLATES: Readonly<Record<BuiltinId, Template>> = {
  first_name: {
    kind: 'short_text',
    targetPath: 'volunteer.first_name',
    consentPurpose: null,
    fr: 'Comment veux-tu qu’on t’appelle ?',
    en: 'What should we call you?',
    isRequired: true,
    isSensitive: false,
  },
  last_name: {
    kind: 'short_text',
    targetPath: 'volunteer.last_name',
    consentPurpose: null,
    fr: 'Nom de famille',
    en: 'Last name',
    isRequired: false,
    isSensitive: false,
  },
  email: {
    kind: 'email',
    targetPath: 'volunteer.email',
    consentPurpose: null,
    fr: 'Adresse e-mail',
    en: 'Email address',
    isRequired: true,
    isSensitive: false,
  },
  phone: {
    kind: 'phone',
    targetPath: 'volunteer.phone',
    consentPurpose: null,
    fr: 'Numéro de téléphone',
    en: 'Phone number',
    isRequired: false,
    isSensitive: false,
  },
  tshirt_size: {
    kind: 'single_choice',
    targetPath: 'volunteer.tshirt_size',
    consentPurpose: null,
    fr: 'Taille de t-shirt',
    en: 'T-shirt size',
    isRequired: false,
    isSensitive: false,
  },
  dietary: {
    kind: 'long_text',
    targetPath: 'volunteer.dietary',
    consentPurpose: null,
    fr: 'Régime alimentaire, allergies',
    en: 'Dietary requirements, allergies',
    isRequired: false,
    isSensitive: true,
  },
  notes: {
    kind: 'long_text',
    targetPath: 'volunteer.notes',
    consentPurpose: null,
    fr: 'Remarques',
    en: 'Remarks',
    isRequired: false,
    isSensitive: false,
  },
  availability: {
    kind: 'availability',
    targetPath: null,
    consentPurpose: null,
    fr: 'Quand es-tu disponible ?',
    en: 'When are you available?',
    isRequired: false,
    isSensitive: false,
  },
  missions: {
    kind: 'missions',
    targetPath: null,
    consentPurpose: null,
    fr: 'Postes possibles',
    en: 'Missions you could do',
    help: {
      fr: 'Coche tout ce que tu serais prêt·e à faire.',
      en: 'Tick everything you would be willing to do.',
    },
    isRequired: false,
    isSensitive: false,
  },
  processing_consent: {
    kind: 'consent',
    targetPath: null,
    consentPurpose: 'processing',
    fr: 'J’accepte que mes réponses soient utilisées pour organiser les bénévoles de cet événement, et qu’on me contacte à ce sujet par e-mail et SMS.',
    en: 'I agree to my answers being used to staff this event, and to being contacted about it by email and SMS.',
    isRequired: true,
    isSensitive: false,
  },
  pool_consent: {
    kind: 'consent',
    targetPath: null,
    consentPurpose: 'pool_retention',
    fr: 'J’accepte que mes coordonnées, compétences, taille de t-shirt et éventuels régimes alimentaires ou allergies soient conservés pour être invité·e aux prochains événements.',
    en: 'I agree to my contact details, skills, T-shirt size and any dietary requirements or allergies being kept so I can be invited to future events.',
    isRequired: false,
    isSensitive: false,
  },
  commitment: {
    kind: 'consent',
    targetPath: null,
    consentPurpose: 'commitment',
    fr: 'Je confirme mon engagement bénévole auprès de {organization} pour cet événement.',
    en: 'I confirm my volunteer commitment to {organization} for this event.',
    help: {
      fr: 'Je confirme participer bénévolement à l’organisation de cet événement pour le compte de l’association {organization}, dans le cadre des missions qui me sont confiées.',
      en: 'I confirm that I am taking part, unpaid, in organising this event on behalf of the association {organization}, within the missions entrusted to me.',
    },
    isRequired: true,
    isSensitive: false,
  },
};

function fill(text: string, organizationName: string): string {
  return text.replaceAll('{organization}', organizationName.trim());
}

/**
 * A built-in, ready to append.
 *
 * The missions question starts with every mission the scope has offered, as
 * the server's seeded draft does (docs/04); the sizes start fixed. `nextKey`
 * mints the client keys, so the caller owns the counter and this stays pure.
 * `organizationName` is what the commitment names.
 */
export function builtinQuestion(
  id: BuiltinId,
  key: string,
  scopeMissions: readonly MissionOption[],
  nextKey: () => string,
  organizationName: string,
): DraftQuestion {
  const template = BUILTIN_TEMPLATES[id];
  let options: DraftOption[] | null = null;
  if (id === 'tshirt_size') {
    options = TSHIRT_SIZES.map((size) => ({
      key: nextKey(),
      value: size.toLowerCase(),
      labelFr: size,
      labelEn: '',
      skillId: null,
      valueFixed: true,
    }));
  } else if (id === 'missions') {
    options = scopeMissions.reduce<DraftOption[]>(
      (acc, mission) => offerMission(acc, mission, nextKey()),
      [],
    );
  }
  return {
    key,
    kind: template.kind,
    targetPath: template.targetPath,
    consentPurpose: template.consentPurpose,
    labelFr: fill(template.fr, organizationName),
    labelEn: fill(template.en, organizationName),
    helpFr: fill(template.help?.fr ?? '', organizationName),
    helpEn: fill(template.help?.en ?? '', organizationName),
    options,
    isRequired: template.isRequired,
    isSensitive: template.isSensitive,
  };
}

/** A custom question, or a section, with an empty label to fill in. */
export function customQuestion(
  kind: CustomKind | 'section',
  key: string,
): DraftQuestion {
  return {
    key,
    kind,
    targetPath: null,
    consentPurpose: null,
    labelFr: '',
    labelEn: '',
    helpFr: '',
    helpEn: '',
    options: takesOptions(kind) ? [] : null,
    isRequired: false,
    isSensitive: false,
  };
}

/** Whether a question's options are the coordinator's to edit. The sizes
 * are fixed and the missions come from the scope; both have their own
 * rendering. */
export function hasEditableOptions(question: DraftQuestion): boolean {
  return (
    (question.kind === 'single_choice' || question.kind === 'multi_choice') &&
    builtinOf(question) !== 'tshirt_size'
  );
}

// ── The pre-check ───────────────────────────────────────────────────────────

export interface DraftProblem {
  /** The question it concerns, or `null` for the form as a whole. */
  readonly questionKey: string | null;
  readonly code: string;
  /** In the UI language of the call — which is why the page computes
   * problems inside a `computed`, where a language switch recomputes them. */
  readonly message: string;
}

function problem(
  question: DraftQuestion | null,
  code: string,
  message: string,
): DraftProblem {
  return { questionKey: question?.key ?? null, code, message };
}

/** The first occurrence is fine; every later one is the problem, which is
 * the question the coordinator just added. */
function laterDuplicates(
  questions: readonly DraftQuestion[],
  identity: (question: DraftQuestion) => string | null,
): DraftQuestion[] {
  const seen = new Set<string>();
  return questions.filter((question) => {
    const id = identity(question);
    if (id === null) {
      return false;
    }
    if (seen.has(id)) {
      return true;
    }
    seen.add(id);
    return false;
  });
}

/**
 * What `PUT` would refuse (docs/04 §"The volunteer form"), per question.
 *
 * `scoped` is whether the form covers a festival or an event: an unscoped
 * one has no days to ask availability about and no missions to offer.
 */
export function saveProblems(
  draft: FormDraft,
  { scoped }: { readonly scoped: boolean },
): DraftProblem[] {
  const { questions } = draft;
  const problems: DraftProblem[] = [];

  for (const question of laterDuplicates(questions, (q) => q.targetPath)) {
    problems.push(
      problem(
        question,
        'duplicate_target',
        t('forms.problems.duplicateTarget'),
      ),
    );
  }
  for (const question of laterDuplicates(questions, (q) =>
    q.kind === 'availability' || q.kind === 'missions' ? q.kind : null,
  )) {
    problems.push(
      problem(
        question,
        `duplicate_${question.kind}`,
        t(
          question.kind === 'availability'
            ? 'forms.problems.duplicateAvailability'
            : 'forms.problems.duplicateMissions',
        ),
      ),
    );
  }
  for (const question of laterDuplicates(questions, (q) =>
    q.kind === 'consent' ? (q.consentPurpose ?? 'processing') : null,
  )) {
    problems.push(
      problem(
        question,
        'duplicate_consent',
        t('forms.problems.duplicateConsent'),
      ),
    );
  }

  for (const question of questions) {
    if (question.labelFr.trim() === '') {
      problems.push(
        problem(
          question,
          'label_missing',
          t(
            question.kind === 'section'
              ? 'forms.problems.sectionTitleMissing'
              : 'forms.problems.labelMissing',
          ),
        ),
      );
    }
    if (question.helpFr.trim() === '' && question.helpEn.trim() !== '') {
      problems.push(
        problem(question, 'help_missing_fr', t('forms.problems.helpMissingFr')),
      );
    }
    if (question.kind === 'consent' && question.consentPurpose === null) {
      problems.push(
        problem(
          question,
          'consent_purpose_missing',
          t('forms.problems.consentPurposeMissing'),
        ),
      );
    }
    if (question.consentPurpose === 'pool_retention' && question.isRequired) {
      problems.push(
        problem(
          question,
          'pool_retention_required',
          t('forms.problems.poolRetentionRequired'),
        ),
      );
    }
    if (
      (question.kind === 'email' || question.kind === 'phone') &&
      question.targetPath === null
    ) {
      problems.push(
        problem(
          question,
          'contact_untargeted',
          t('forms.problems.contactUntargeted'),
        ),
      );
    }
    if (!takesOptions(question.kind) && question.options !== null) {
      problems.push(
        problem(
          question,
          'options_unexpected',
          t('forms.problems.optionsUnexpected'),
        ),
      );
    }
    // A list is what the server requires; an empty one is saveable, so a
    // choice question can be drafted before its options are decided, and
    // `publishProblems` is where "none at all" is raised.
    if (takesOptions(question.kind) && question.options === null) {
      problems.push(
        problem(
          question,
          'options_missing',
          t('forms.problems.optionsMissing'),
        ),
      );
    }
    for (const option of question.options ?? []) {
      if (option.labelFr.trim() === '') {
        problems.push(
          problem(
            question,
            'option_label_missing',
            t('forms.problems.optionLabelMissing'),
          ),
        );
        break;
      }
    }
    if (
      !scoped &&
      (question.kind === 'availability' || question.kind === 'missions')
    ) {
      problems.push(
        problem(question, 'unscoped', t('forms.problems.unscoped')),
      );
    }
  }

  return problems;
}

/**
 * What publish would add to `saveProblems` — the whole-form invariants no
 * constraint can express.
 *
 * `missionValues` is the scope's missions right now, or `null` while they
 * have not loaded; an option is only called unresolved against a list that
 * actually arrived. `locales` is every locale the form must be complete in:
 * French always, plus the default when it is not French (docs/09 §7).
 */
export function publishProblems(
  draft: FormDraft,
  {
    defaultLocale,
    missionValues,
  }: {
    readonly defaultLocale: FormLocale;
    readonly missionValues: ReadonlySet<string> | null;
  },
): DraftProblem[] {
  const { questions } = draft;
  const problems: DraftProblem[] = [];

  const consents: readonly (readonly [
    ConsentPurpose,
    string,
    AdminMessageKey,
  ])[] = [
    [
      'processing',
      'processing_consent_missing',
      'forms.problems.processingConsentMissing',
    ],
    ['commitment', 'commitment_missing', 'forms.problems.commitmentMissing'],
  ];
  for (const [purpose, code, missing] of consents) {
    if (
      !questions.some(
        (q) => q.kind === 'consent' && q.consentPurpose === purpose,
      )
    ) {
      problems.push(problem(null, code, t(missing)));
    }
  }

  const required: readonly (readonly [string, TargetPath, AdminMessageKey])[] =
    [
      ['first_name', 'volunteer.first_name', 'forms.problems.firstNameMissing'],
      ['email', 'volunteer.email', 'forms.problems.emailMissing'],
    ];
  for (const [id, target, missing] of required) {
    if (!questions.some((q) => q.targetPath === target)) {
      problems.push(problem(null, `${id}_missing`, t(missing)));
    }
  }

  for (const question of questions) {
    if (requiredRule(question) === 'always' && !question.isRequired) {
      problems.push(
        problem(
          question,
          'must_be_required',
          t('forms.problems.mustBeRequired'),
        ),
      );
    }

    if (
      (question.kind === 'single_choice' || question.kind === 'multi_choice') &&
      (question.options ?? []).length === 0
    ) {
      problems.push(
        problem(question, 'options_empty', t('forms.problems.optionsEmpty')),
      );
    }

    const values = (question.options ?? []).map((option) => option.value);
    if (new Set(values).size !== values.length) {
      problems.push(
        problem(
          question,
          'duplicate_option',
          t('forms.problems.duplicateOption'),
        ),
      );
    }

    if (question.kind === 'missions' && missionValues !== null) {
      const unresolved = (question.options ?? []).filter(
        (option) => !missionValues.has(option.value),
      );
      if (unresolved.length > 0) {
        problems.push(
          problem(
            question,
            'mission_unresolved',
            t('forms.problems.missionUnresolved', {
              missions: unresolved.map((o) => o.labelFr).join(', '),
            }),
          ),
        );
      }
    }

    if (defaultLocale === 'en') {
      const untranslated =
        question.labelEn.trim() === '' ||
        (question.helpFr.trim() !== '' && question.helpEn.trim() === '') ||
        (question.options ?? []).some((option) => option.labelEn.trim() === '');
      if (untranslated) {
        problems.push(
          problem(
            question,
            'label_missing_en',
            t('forms.problems.labelMissingEn'),
          ),
        );
      }
    }
  }

  return problems;
}

/**
 * Pins the server's problems to the questions they name.
 *
 * `position` is read against the questions *as the server numbered them*:
 * `positioned` pairs each position the server knows with the draft question
 * it became. A problem whose position matches nothing is kept, at form
 * level, rather than dropped — the coordinator is still owed the sentence.
 */
export function locateServerProblems(
  problems: readonly PublishProblem[],
  positioned: readonly { readonly position: number; readonly key: string }[],
): DraftProblem[] {
  const byPosition = new Map(positioned.map((p) => [p.position, p.key]));
  return problems.map((p) => ({
    questionKey:
      p.position === null ? null : (byPosition.get(p.position) ?? null),
    code: p.code,
    message: p.message,
  }));
}

/**
 * Where the server starts counting. docs/04 names positions but not their
 * base, so it is read off the stored questions — the lowest `position` a
 * version holds is what its first question is called — and a `PUT` refusal
 * against a draft that was just submitted is numbered the same way.
 */
export function positionBase(version: FormVersion): number {
  return version.questions.reduce(
    (lowest, question) => Math.min(lowest, question.position),
    version.questions[0]?.position ?? 0,
  );
}

// ── The preview ─────────────────────────────────────────────────────────────

/**
 * When a night stops being "the day before". A club night ending at 05:00 is
 * one day of the event, not two — docs/09 §3: a day that crosses midnight
 * belongs to the day it starts on — so an end at or before this hour does not
 * open a row of its own.
 */
const OVERNIGHT_CUTOFF = Temporal.PlainTime.from('06:00');

/** Enough for any real edition, and a bound on a malformed period. */
const MAX_DAYS = 62;

/**
 * The day rows an event's availability group would show, as instants at
 * noon in the event's own zone — which is what `formatDate` needs to name the
 * right date whatever the viewer's zone is.
 */
export function eventDays(
  period: { readonly start: string; readonly end: string },
  timezone: string,
): number[] {
  const start = Temporal.Instant.from(period.start).toZonedDateTimeISO(
    timezone,
  );
  const end = Temporal.Instant.from(period.end).toZonedDateTimeISO(timezone);
  let last = end.toPlainDate();
  const first = start.toPlainDate();
  if (
    Temporal.PlainDate.compare(last, first) > 0 &&
    Temporal.PlainTime.compare(end.toPlainTime(), OVERNIGHT_CUTOFF) <= 0
  ) {
    last = last.subtract({ days: 1 });
  }

  const days: number[] = [];
  for (
    let day = first;
    Temporal.PlainDate.compare(day, last) <= 0 && days.length < MAX_DAYS;
    day = day.add({ days: 1 })
  ) {
    days.push(
      day.toZonedDateTime({
        timeZone: timezone,
        plainTime: Temporal.PlainTime.from('12:00'),
      }).epochMilliseconds,
    );
  }
  return days;
}

/** A single-choice question is a radio group up to this many options and a
 * select past it (docs/09 §1: "by option count") — a column of fifteen
 * radios on a phone is a scroll, a select is one tap. */
export const RADIO_LIMIT = 6;
