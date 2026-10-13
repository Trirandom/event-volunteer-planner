// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import {
  isDateElement,
  isLiteralElement,
  isPluralElement,
  isPoundElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  parse,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';

/**
 * The catalogue gates of docs/16 §7, as a function each application's test
 * suite runs over its own catalogues.
 *
 * Key parity is already a type error — `en` is declared with `fr`'s type — so
 * what is checked here is what a type cannot see: that every message is valid
 * ICU, that both languages ask for the same arguments, and that no message
 * formats a date itself.
 */

/** A nested catalogue: every leaf is an ICU message. */
export interface Catalogue {
  readonly [key: string]: string | Catalogue;
}

export interface CatalogueProblem {
  readonly key: string;
  readonly locale: string;
  readonly problem: string;
}

/** `{ a: { b: 'x' } }` → `[['a.b', 'x']]`. */
export function flattenCatalogue(
  catalogue: Catalogue,
  prefix = '',
): [string, string][] {
  return Object.entries(catalogue).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[`${prefix}${key}`, value] satisfies [string, string]]
      : flattenCatalogue(value, `${prefix}${key}.`),
  );
}

/** Direct children: plural/select branches and (unused) tag bodies. */
function childrenOf(element: MessageFormatElement): MessageFormatElement[] {
  if (isPluralElement(element) || isSelectElement(element)) {
    return Object.values(element.options).flatMap((option) => option.value);
  }
  if (isTagElement(element)) {
    return element.children;
  }
  return [];
}

function walk(
  elements: readonly MessageFormatElement[],
): MessageFormatElement[] {
  return elements.flatMap((element) => [element, ...walk(childrenOf(element))]);
}

/** The names a message interpolates, however deep in a plural or select. */
function argumentsOf(elements: readonly MessageFormatElement[]): Set<string> {
  return new Set(
    walk(elements).flatMap((element) =>
      isLiteralElement(element) ||
      isPoundElement(element) ||
      isTagElement(element)
        ? []
        : [element.value],
    ),
  );
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function describe(set: ReadonlySet<string>): string {
  return `{${[...set].sort().join(', ')}}`;
}

/**
 * Every problem in the catalogues, with the first locale as the reference.
 * An empty array is a pass.
 */
export function auditCatalogues(
  catalogues: Readonly<Record<string, Catalogue>>,
): CatalogueProblem[] {
  const problems: CatalogueProblem[] = [];
  const parsed = new Map<string, Map<string, Set<string>>>();

  for (const [locale, catalogue] of Object.entries(catalogues)) {
    const byKey = new Map<string, Set<string>>();
    parsed.set(locale, byKey);
    for (const [key, source] of flattenCatalogue(catalogue)) {
      if (source.trim() === '') {
        problems.push({ key, locale, problem: 'empty message' });
        continue;
      }
      let ast: MessageFormatElement[];
      try {
        // Same options as the runtime compiler, so a message that passes
        // here is one that renders.
        ast = parse(source, { ignoreTag: true });
      } catch (error: unknown) {
        problems.push({
          key,
          locale,
          problem: `invalid ICU: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (
        walk(ast).some(
          (element) => isDateElement(element) || isTimeElement(element),
        )
      ) {
        // docs/16 §6: a time is shown in the *event's* zone, and ICU's
        // `date`/`time` would use the viewer's. Format it with
        // @evp/shared/intl and pass the string in.
        problems.push({
          key,
          locale,
          problem:
            'formats a date or time itself; pass a string from @evp/shared/intl',
        });
      }
      byKey.set(key, argumentsOf(ast));
    }
  }

  const [reference, ...others] = [...parsed.entries()];
  if (reference === undefined) {
    return problems;
  }
  const [referenceLocale, referenceKeys] = reference;
  for (const [locale, keys] of others) {
    for (const [key, args] of referenceKeys) {
      const translated = keys.get(key);
      if (translated === undefined) {
        problems.push({
          key,
          locale,
          problem: `missing (present in ${referenceLocale})`,
        });
      } else if (!sameSet(args, translated)) {
        problems.push({
          key,
          locale,
          problem: `arguments ${describe(translated)} differ from ${referenceLocale}'s ${describe(args)}`,
        });
      }
    }
    for (const key of keys.keys()) {
      if (!referenceKeys.has(key)) {
        problems.push({ key, locale, problem: `not in ${referenceLocale}` });
      }
    }
  }
  return problems;
}
