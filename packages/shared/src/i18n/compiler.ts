// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { IntlMessageFormat } from 'intl-messageformat';
import type {
  MessageCompiler,
  MessageContext,
  MessageFunction,
} from 'vue-i18n';

/**
 * vue-i18n's message compiler, replaced by FormatJS's ICU MessageFormat.
 *
 * vue-i18n's own syntax has plurals (`bénévole | bénévoles`) but no `select`
 * and no CLDR plural categories, and docs/16 §6 requires ICU: French puts `0`
 * in the singular and a hand-picked branch index gets that wrong. ICU is also
 * the syntax every translation tool reads, so a catalogue can leave the
 * repository without a converter.
 *
 * It is also the CSP answer. `script-src 'self'` has no `unsafe-eval`
 * (docker/caddy/Caddyfile), and `IntlMessageFormat` interprets a parsed AST
 * rather than generating code.
 *
 * `ignoreTag`: a message is text. `<` in a catalogue is a literal character,
 * never markup — `v-html` is banned, so there is nothing that could render a
 * tag anyway, and treating one as syntax would only turn a stray `<` into a
 * parse error.
 */
export function compileMessage(
  source: string,
  locale: string,
): IntlMessageFormat {
  return new IntlMessageFormat(source, locale, undefined, { ignoreTag: true });
}

/**
 * Collapses a FormatJS result to the string vue-i18n expects. With the
 * primitive values a template passes it is already a string; the array form
 * only arises from rich-text values, which this project does not pass.
 */
function flatten(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    return result.map((part) => String(part)).join('');
  }
  return String(result);
}

/**
 * vue-i18n's handler wants its own `CompileError`, which is a `SyntaxError`
 * with a numeric `code`. Zero is not one of its codes: these errors are ours,
 * not its parser's.
 */
function compileError(message: string): SyntaxError & { code: number } {
  return Object.assign(new SyntaxError(message), { code: 0 });
}

export const icuMessageCompiler: MessageCompiler = (
  message,
  { locale, key, onError },
): MessageFunction => {
  if (typeof message !== 'string') {
    // Only reachable if someone adds the vue-i18n build plugin, which
    // precompiles catalogues into its *own* AST. Saying so beats rendering
    // the key and leaving the reader to work out why.
    onError?.(
      compileError(
        `${key}: catalogues must be plain ICU strings, not precompiled vue-i18n ASTs`,
      ),
    );
    return () => key;
  }
  try {
    const format = compileMessage(message, locale);
    return (ctx: MessageContext) => flatten(format.format(ctx.values));
  } catch (error: unknown) {
    // Unreachable for a catalogue that passed `auditCatalogues` in CI; kept
    // so a broken message degrades to its key rather than a blank page.
    onError?.(
      compileError(
        `${key}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return () => key;
  }
};
