// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * What the volunteer has typed so far, and whether it can be sent.
 *
 * Pure, so the rules that decide whether a volunteer is stopped at the submit
 * button are tested without a DOM. Availability is not here: it has its own
 * model (`availability/model.ts`) and only reports whether it is answered.
 */
import type { AnswerValue, Prefill, Question } from '../api/publicForm';

/** Every kind except `section` and `availability` keeps one value here. */
export type Answers = Record<string, AnswerValue>;

export type FieldError = 'required' | 'email' | 'phone' | 'date';

export function emptyAnswer(question: Question): AnswerValue {
  switch (question.kind) {
    case 'multi_choice':
      return [];
    case 'missions':
      // Most missions anyone can do, so they start ticked and the volunteer
      // unticks what they would rather not. A technical or adults-only one
      // waits for an explicit tick (the server never stamps both).
      return (question.options ?? [])
        .filter((option) => option.checked_by_default)
        .map((option) => option.value);
    case 'consent':
      return false;
    case 'boolean':
      // `null` until answered: a required yes/no has no default, and an
      // optional one is a checkbox whose unticked state *is* an answer.
      return question.is_required ? null : false;
    default:
      return '';
  }
}

/**
 * Fresh answers, overlaid with prefill where it still fits the question. A
 * prefilled value of the wrong shape — the question changed kind between
 * versions — is dropped rather than coerced (docs/09 §2: prefill covers
 * surviving questions only).
 */
export function initialAnswers(
  questions: readonly Question[],
  prefill: Prefill | null | undefined,
): Answers {
  const answers: Answers = {};
  for (const question of questions) {
    if (question.kind === 'section' || question.kind === 'availability') {
      continue;
    }
    const empty = emptyAnswer(question);
    const given = prefill?.answers[question.id];
    // Consent is never carried over: it is given now, to this version's
    // notice, or it is not given (docs/09 §8).
    answers[question.id] =
      given !== undefined &&
      question.kind !== 'consent' &&
      sameShape(empty, given)
        ? keepKnownOptions(question, given)
        : empty;
  }
  return answers;
}

function sameShape(empty: AnswerValue, given: AnswerValue): boolean {
  if (Array.isArray(empty)) {
    return Array.isArray(given);
  }
  if (empty === null || typeof empty === 'boolean') {
    return given === null || typeof given === 'boolean';
  }
  return typeof given === 'string';
}

function keepKnownOptions(question: Question, given: AnswerValue): AnswerValue {
  const known = new Set((question.options ?? []).map((o) => o.value));
  if (Array.isArray(given)) {
    return question.options == null
      ? given
      : given.filter((value) => known.has(value));
  }
  if (question.kind === 'single_choice' && typeof given === 'string') {
    return known.has(given) ? given : '';
  }
  return given;
}

// Loose on purpose. The server normalises; the client only catches the typo
// a volunteer would want to hear about before sending.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** docs/09 §1: international formats, no false rejections. */
export function looksLikePhone(value: string): boolean {
  if (!/^[+\d\s().\-/]+$/u.test(value)) {
    return false;
  }
  const digits = value.replace(/\D/gu, '').length;
  return digits >= 6 && digits <= 17;
}

export function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'boolean') {
    return true;
  }
  return value.trim() !== '';
}

/** `null` when the answer can be sent as it is. */
export function fieldError(
  question: Question,
  value: AnswerValue | undefined,
): FieldError | null {
  // A required consent or optional boolean is a checkbox: `false` is a value,
  // but not the one a required consent needs.
  const answered =
    question.kind === 'consent' ? value === true : isAnswered(value);
  if (!answered) {
    return question.is_required ? 'required' : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (question.kind === 'email' && !EMAIL.test(text)) {
    return 'email';
  }
  if (question.kind === 'phone' && !looksLikePhone(text)) {
    return 'phone';
  }
  if (question.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    return 'date';
  }
  return null;
}

/** What goes on the wire: text trimmed, email lowercased. */
export function wireAnswers(
  questions: readonly Question[],
  answers: Answers,
): Answers {
  const out: Answers = {};
  for (const question of questions) {
    const value = answers[question.id];
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      out[question.id] = question.kind === 'email' ? text.toLowerCase() : text;
    } else {
      out[question.id] = value;
    }
  }
  return out;
}
