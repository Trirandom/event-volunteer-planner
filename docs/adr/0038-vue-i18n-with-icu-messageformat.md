# ADR-0038 — vue-i18n for the runtime, FormatJS for ICU MessageFormat, keys typed against French

**Status:** Accepted · **Date:** 2026-09-30
**Implements:** [16 §6](../16-i18n-and-time.md#6-localisation) (catalogues,
ICU, fallback) and the catalogue rows of [16 §7](../16-i18n-and-time.md#7-enforcement).

## Context

docs/16 §6 fixed the *policy* before any code: `fr` and `en`, `fr` the default
and the fallback, ICU MessageFormat for anything with a count or a variable,
semantic keys, a missing key failing CI, and no translated string ever parsed
or concatenated. It did not choose a library, and until now neither
application had one: the coordinator application was written in English with
the newest pages (the form builder) in French, and the volunteer form in
French.

The choice is constrained by things already decided elsewhere:

- **CSP.** Production sends `script-src 'self'` with no `'unsafe-eval'`
  (`docker/caddy/Caddyfile`). A message compiler that generates JavaScript
  with `new Function` does not run.
- **ICU, specifically.** French puts `0` in the singular («0 bénévole») and
  English does not. vue-i18n's own syntax chooses a plural branch by index
  (`bénévole | bénévoles`) with a per-locale rule the application must write
  itself, and has no `select`. ICU plural categories come from CLDR and are
  what every translation tool reads.
- **Strict TypeScript** with `skipLibCheck: false` (docs/11 §3), and "missing
  key in CI is a failure" (docs/16 §6).
- **The form's budget.** `apps/form` is measured against a 1.5 s cold load on
  3G-fast (docs/01 §5) and every dependency in it is weighed.
- **Two bundles, one boundary.** Whatever the form uses must come through
  `packages/shared`, not from `apps/admin` (docs/09 §6, `hoist: false`).
- **Times are not formatted by messages.** docs/16 §6 requires the *event's*
  timezone. ICU's `{when, date}` formats in the viewer's.

## Decision

**vue-i18n 11 holds the locale and the catalogues; FormatJS's
`intl-messageformat` renders every message as ICU; a thin layer in
`@evp/shared/i18n` types keys against the French catalogue.**

- `@evp/shared/i18n` (`packages/shared/src/i18n/`) is the only module that
  imports vue-i18n or FormatJS. It exports `createEvpI18n`, locale
  negotiation, the catalogue audit and the shared components' strings.
  Neither application declares vue-i18n. A second copy of the library would
  break the injection the shared components rely on.
- vue-i18n's `messageCompiler` option is FormatJS (`compiler.ts`). It
  interprets a parsed AST, so it needs no `unsafe-eval`. `ignoreTag` is set:
  a message is text, `v-html` is banned, and a `<` is a character.
- **Typed keys.** vue-i18n's own `t` accepts any string. `createEvpI18n`
  returns a `t` whose key parameter is the union of the dotted paths of the
  application's French catalogue (`MessageKey<typeof fr>`). A misspelled or
  removed key is a `vue-tsc` error. The English catalogue is declared
  `satisfies typeof fr`, so a key missing from English, or present only in
  English, is also a type error.
- **One global scope.** `t` is imported from the application's `i18n` module
  (`apps/*/src/i18n/index.ts`) and works the same in templates, `computed`s
  and plain modules under `plan/` and `board/`. It is reactive because it
  reads the current locale. No component-local catalogues and no `$t`
  (`globalInjection: false`), because `$t` is untyped.
- **Catalogues are TypeScript**, one file per area
  (`apps/admin/src/i18n/{fr,en}/<area>.ts`). TypeScript rather than JSON
  because it carries the SPDX header and translator comments, and because it
  is what makes the key type free. French is bundled. English is a dynamic
  import, its own chunk, loaded on first use.
- **Which language:**
  - *Form* (docs/09 §7): `?lang=`, then the browser's languages, then the
    organisation default (once the form API serves it), then `fr`. It is
    applied in a router guard, so the first paint is already right.
  - *Coordinator application:* a choice made with the header switcher and
    kept on the device, then `users.locale` once the session is known, then
    the browser, then `fr`. The device choice outranks the account because
    nothing can write `users.locale` yet.
  - Every switch sets `<html lang>` (WCAG 3.1.1).
- **The formatting locale is the UI language.** Views used to derive a locale
  from `users.locale` with an English default. They now read the same
  `locale` as `t`, so a screen cannot show English words beside French dates.
- **Gates** (docs/16 §7):
  - `vue/no-bare-strings-in-template` fails lint on text, `aria-label`,
    `title`, `placeholder` or `alt` written directly in a template.
  - `auditCatalogues`, run by each application's `i18n/catalogue.test.ts`,
    rejects:
    - invalid ICU;
    - empty messages;
    - a translation whose arguments differ from French's;
    - any `date` or `time` argument. Times are formatted by
      `@evp/shared/intl`, with the event's timezone, and passed in as
      strings.
- **Patch.** vue-i18n ≥ 11.3's typings import `GenericComponentInstance`,
  which Vue exports only from 3.6. Under `skipLibCheck: false` this does not
  compile against our Vue 3.5. `patches/vue-i18n@11.4.12.patch` removes that
  member of one union, in the same spirit as the vue-router patch.
- **Build flags** (`packages/shared/src/i18n/buildFlags.ts`, used by both Vite
  configs and Vitest) drop vue-i18n's legacy API, its global components, its
  production devtools hook and its own message compiler.

## Alternatives considered

- **vue-i18n with its own message syntax.** It is the smallest option, since
  the build plugin precompiles messages and the runtime needs no parser. It is
  rejected because its syntax is not ICU. French `0`, `select` and
  translation-tool interchange would each need working around, and docs/16
  §6 names ICU explicitly.
- **FormatJS alone behind a small in-house composable.** It saves the
  vue-i18n runtime, about 12 kB gzip. It is rejected for now: we would own
  locale state, fallback, lazy loading and plugin injection, which is what a
  maintained library exists for. It is the fallback if vue-i18n drops custom
  compilers (see Consequences).
- **Paraglide (inlang).** It compiles each message to a tree-shakeable,
  typed function, so it is the smallest and best-typed option. It is rejected
  for three reasons:
  - its plurals are its own "variants" format rather than ICU;
  - it needs a compiler step and a project file outside the Vite config;
  - message identifiers must be flat, which loses the per-screen nesting the
    catalogues use for review.
- **JSON catalogues.** JSON is the lingua franca of translation platforms.
  It is rejected here because it has no comments (no SPDX header, no
  translator context) and needs a separate type-generation step. A converter
  to JSON is a few lines if a translation platform is ever adopted.

## Consequences

- Cost, measured against the production form bundle by sourcemap
  attribution:
  - vue-i18n runtime: ~31 kB minified, ~12 kB gzip;
  - FormatJS: ~33 kB minified, ~10 kB gzip;
  - total: ~20 kB of the form's 58.6 kB gzip;
  - the English catalogue is a separate chunk of well under 1 kB.

  The largest single part is the ICU parser (≈ 6 kB gzip with its skeleton
  parser). If the budget tightens, the next step is to parse catalogues at
  build time and ship ASTs, which `intl-messageformat` accepts, so the
  parser never reaches the browser.
- vue-i18n labels `messageCompiler` "experimental" and prints a one-time
  warning in development. The option has existed since v9.3 and is how its
  own documentation integrates `intl-messageformat`. If it were removed,
  `createEvpI18n` is the only code that knows, and the in-house alternative
  above replaces it behind the same `t`.
- The patch must be deleted on the move to Vue 3.6. Until then, every
  vue-i18n bump needs its patch regenerated, and `pnpm install` fails loudly
  if the patch no longer applies.
- The form's question labels are *data*, stored per locale on the form
  version (docs/09 §7). They never enter these catalogues, and the catalogues
  never hold volunteer or coordinator text.
- Server-rendered text (emails, SMS, PDF) is out of scope here. It will need
  its own catalogues on the Rust side. Keeping the frontend's ICU means both
  sides can share one message syntax.
- Adding a language is a new `<locale>/` directory per application, one entry
  in `LOCALES`, and the `ViewerLocale` union. The type checker then lists
  every string still to translate.
