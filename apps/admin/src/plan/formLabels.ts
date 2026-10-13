// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The form builder's names for things, in one place.
 *
 * The card, the palette, the read-only view and the problem summary all name
 * the same kinds and built-ins; four hand-written copies would call the
 * dietary question four slightly different things, and a coordinator reading
 * "Régime" in the palette and "Allergies" on the card would reasonably think
 * they were two questions.
 *
 * The words themselves are in the catalogue (`i18n/{fr,en}/forms.ts`); what stays
 * here is which key names which thing, so that mapping still has one home.
 * Maps of keys rather than of text, and text only when asked for, because a
 * map of text filled at import would stay in the language the page loaded in.
 */
import type { QuestionKind } from '../api/forms';
import { t, type AdminMessageKey } from '../i18n';
import type { BuiltinId } from './formDraft';

const KIND_LABELS: Readonly<Record<QuestionKind, AdminMessageKey>> = {
  short_text: 'forms.labels.kind.shortText',
  long_text: 'forms.labels.kind.longText',
  email: 'forms.labels.kind.email',
  phone: 'forms.labels.kind.phone',
  date: 'forms.labels.kind.date',
  single_choice: 'forms.labels.kind.singleChoice',
  multi_choice: 'forms.labels.kind.multiChoice',
  boolean: 'forms.labels.kind.boolean',
  availability: 'forms.labels.kind.availability',
  missions: 'forms.labels.kind.missions',
  consent: 'forms.labels.kind.consent',
  section: 'forms.labels.kind.section',
};

export function kindLabel(kind: QuestionKind): string {
  return t(KIND_LABELS[kind]);
}

const BUILTIN_LABELS: Readonly<Record<BuiltinId, AdminMessageKey>> = {
  first_name: 'forms.labels.builtin.firstName',
  last_name: 'forms.labels.builtin.lastName',
  email: 'forms.labels.builtin.email',
  phone: 'forms.labels.builtin.phone',
  tshirt_size: 'forms.labels.builtin.tshirtSize',
  dietary: 'forms.labels.builtin.dietary',
  notes: 'forms.labels.builtin.notes',
  availability: 'forms.labels.builtin.availability',
  missions: 'forms.labels.builtin.missions',
  processing_consent: 'forms.labels.builtin.processingConsent',
  pool_consent: 'forms.labels.builtin.poolConsent',
  commitment: 'forms.labels.builtin.commitment',
};

export function builtinLabel(id: BuiltinId): string {
  return t(BUILTIN_LABELS[id]);
}

/** Where a built-in's answer goes — the tooltip behind «Intégrée», and the
 * reason a coordinator should care that it is one. */
const BUILTIN_DESTINATIONS: Readonly<Record<BuiltinId, AdminMessageKey>> = {
  first_name: 'forms.labels.destination.firstName',
  last_name: 'forms.labels.destination.lastName',
  email: 'forms.labels.destination.email',
  phone: 'forms.labels.destination.phone',
  tshirt_size: 'forms.labels.destination.tshirtSize',
  dietary: 'forms.labels.destination.dietary',
  notes: 'forms.labels.destination.notes',
  availability: 'forms.labels.destination.availability',
  missions: 'forms.labels.destination.missions',
  processing_consent: 'forms.labels.destination.processingConsent',
  pool_consent: 'forms.labels.destination.poolConsent',
  commitment: 'forms.labels.destination.commitment',
};

/** A built-in's destination, or a custom question's when `null`. */
export function destinationOf(id: BuiltinId | null): string {
  return t(
    id === null ? 'forms.labels.destination.custom' : BUILTIN_DESTINATIONS[id],
  );
}

/** Why a toggle is locked, in the words the card shows under it. */
const REQUIRED_REASONS: Readonly<Partial<Record<BuiltinId, AdminMessageKey>>> =
  {
    first_name: 'forms.labels.requiredReason.firstName',
    email: 'forms.labels.requiredReason.email',
    processing_consent: 'forms.labels.requiredReason.processingConsent',
    pool_consent: 'forms.labels.requiredReason.poolConsent',
    commitment: 'forms.labels.requiredReason.commitment',
  };

/** `undefined` for a question whose requiredness is the coordinator's. */
export function requiredReason(id: BuiltinId | null): string | undefined {
  const key = id === null ? undefined : REQUIRED_REASONS[id];
  return key === undefined ? undefined : t(key);
}
