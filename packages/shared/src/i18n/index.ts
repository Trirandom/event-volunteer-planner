// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Translation for both applications (docs/16 §6, ADR-0038).
 *
 * vue-i18n holds the current locale and the catalogues; FormatJS renders
 * ICU MessageFormat in place of vue-i18n's own syntax (`compiler.ts`). What
 * this module adds is the typing: vue-i18n's `t` accepts any string, so a
 * misspelled key would render as the key itself in production. Here `t` only
 * accepts the dotted paths of the application's French catalogue, and a key
 * that does not exist is a `vue-tsc` failure — the "missing key in CI"
 * gate of docs/16 §6 without a separate tool.
 *
 * Only the global scope is used. A component-local catalogue is a second
 * place for a string to hide, and the per-app catalogue split by area already
 * keeps files reviewable.
 */
import { computed, type ComputedRef } from 'vue';
import { createI18n, type I18n } from 'vue-i18n';

import type { ViewerLocale } from '../intl/index.js';
import type { Catalogue } from './audit.js';
import { icuMessageCompiler } from './compiler.js';

export {
  auditCatalogues,
  flattenCatalogue,
  type Catalogue,
  type CatalogueProblem,
} from './audit.js';
export { sharedEn, sharedFr } from './messages.js';

/** The languages this build ships. Also the formatters' locale type. */
export type Locale = ViewerLocale;

export const LOCALES: readonly Locale[] = ['fr', 'en'];

/** Default and fallback (docs/16 §6): the association works in French. */
export const DEFAULT_LOCALE: Locale = 'fr';

/** The language's own name, never translated — a French speaker lost in an
 * English UI is looking for «Français», not "French". */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  fr: 'Français',
  en: 'English',
};

export function isLocale(value: unknown): value is Locale {
  return value === 'fr' || value === 'en';
}

/**
 * The first candidate this build can render, by primary subtag: `fr-CA` is
 * `fr`, `en-GB` is `en`. `null` when none match, so the caller decides the
 * next source rather than this function silently choosing French for it.
 *
 * Region is deliberately dropped. Language and locale are separate axes
 * (docs/16 §1), and the catalogues are per language.
 */
export function negotiateLocale(
  candidates: Iterable<string | null | undefined>,
): Locale | null {
  for (const candidate of candidates) {
    const primary = candidate?.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) {
      return primary;
    }
  }
  return null;
}

/** The dotted path of every leaf in a nested catalogue. */
export type MessageKey<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${MessageKey<T[K]>}`;
}[keyof T & string];

/** ICU arguments. Dates arrive pre-formatted as strings (docs/16 §6). */
export type MessageValues = Readonly<Record<string, string | number>>;

export type Translate<Key extends string> = (
  key: Key,
  values?: MessageValues,
) => string;

export interface EvpI18n<Schema> {
  /** For `app.use`. Everything else goes through the fields below. */
  readonly plugin: I18n<
    Record<string, never>,
    Record<string, never>,
    Record<string, never>,
    string,
    false
  >;
  /** The rendered language. Reactive: read it inside a `computed`. */
  readonly locale: ComputedRef<Locale>;
  /**
   * Reactive in templates and `computed`s — it reads the current locale, so
   * a re-render follows a language switch — and callable from plain modules
   * for the same reason, which is how `plan/*` builds its messages.
   */
  readonly t: Translate<MessageKey<Schema>>;
  /** Loads the catalogue if needed, then switches, then updates `<html lang>`. */
  readonly setLocale: (locale: Locale) => Promise<void>;
}

export interface EvpI18nOptions<Schema extends Catalogue> {
  /** Bundled: it is the default and the fallback, so it is always needed. */
  readonly fr: Schema;
  /**
   * Every other language, loaded on first use. A separate chunk keeps it out
   * of the form's cold-load budget (docs/01 §5) for the majority who read
   * French. Tests pass a resolved catalogue.
   */
  readonly others: Readonly<
    Record<Exclude<Locale, 'fr'>, () => Promise<Schema>>
  >;
}

export function createEvpI18n<Schema extends Catalogue>(
  options: EvpI18nOptions<Schema>,
): EvpI18n<Schema> {
  const plugin = createI18n({
    legacy: false,
    locale: DEFAULT_LOCALE,
    fallbackLocale: DEFAULT_LOCALE,
    messageCompiler: icuMessageCompiler,
    // No `$t`: it is untyped, so it would be the one route a misspelled key
    // could take past `vue-tsc`.
    globalInjection: false,
    messages: {},
  });
  plugin.global.setLocaleMessage(DEFAULT_LOCALE, options.fr);

  const loaded = new Set<Locale>([DEFAULT_LOCALE]);
  // A second switch issued while the first catalogue is still downloading
  // must win, not be overwritten when the slower request lands.
  let latestRequest = 0;

  const locale = computed((): Locale => {
    const current = plugin.global.locale.value;
    return isLocale(current) ? current : DEFAULT_LOCALE;
  });

  async function setLocale(next: Locale): Promise<void> {
    latestRequest += 1;
    const request = latestRequest;
    if (next !== 'fr' && !loaded.has(next)) {
      const messages = await options.others[next]();
      plugin.global.setLocaleMessage(next, messages);
      loaded.add(next);
    }
    if (request !== latestRequest) {
      return;
    }
    plugin.global.locale.value = next;
    // WCAG 3.1.1: a screen reader picks its voice from `lang`, and French
    // read with an English voice is barely intelligible.
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next;
    }
  }

  return {
    plugin,
    locale,
    t: (key, values) => plugin.global.t(key, values ?? {}),
    setLocale,
  };
}
