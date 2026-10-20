# ADR-0046 — The schedule email is edited as rich text, and still stored as HTML

**Status:** Accepted · **Date:** 2026-10-20
**Amends:** [02 §2](../02-architecture.md#2-technology-choices) (adds a row)

## Context

The emails page (`apps/admin/src/views/PlanEmailsView.vue`) gives the
coordinator a `<textarea>` holding the schedule email's template as raw HTML:
`<br>`, `<b>`, `<div dir="ltr">`, typed by hand. That was the spreadsheet's
template carried over as it stood, and it suits the one person who wrote it.
Everyone else who opens the page sees markup they did not write and are afraid
to touch. Bold text, a line break or a link should not require knowing a tag.

Three things are already settled and constrain the choice:

- **The template is HTML with `{{name}}` placeholders, and two renderers read
  it.** The page previews it with `renderTemplate` (`plan/emails.ts`), the
  server will send it with `evp_domain::schedule::render`, and
  `crates/evp-domain/fixtures/schedule_render.json` holds the two to one
  output. `{{a|b}}` means "a, or b where a is empty", and that grammar is why
  the server does not use minijinja.
- **The result goes to mail clients.** Gmail, Outlook and the rest drop
  `<style>` blocks, ignore classes and handle little more than inline
  formatting, paragraphs, lists and links. An editor whose output depends on
  its own stylesheet produces mail that looks right in the preview and wrong
  in the inbox.
- **`v-html` is banned** ([12 §4](../12-security.md)), and the preview stays a
  sandboxed `iframe`.

## Decision

**The template is edited in a Tiptap editor (ProseMirror underneath), with a
schema limited to what mail clients render. What it stores is still the same
HTML-with-placeholders, so neither renderer changes.**

- **Schema, not sanitiser.** The editor knows paragraphs, line breaks, bold,
  italic, underline, links (`http`, `https`, `mailto` only), bulleted and
  numbered lists, and nothing else. Pasted content from Word or a web page is
  parsed *into* that schema, so anything it cannot express (fonts, colours,
  classes, tables, scripts) disappears on paste rather than reaching an inbox.
  No class or style attribute is ever emitted.
- **A placeholder is an atom.** The variable buttons insert a node that
  serialises as `<span data-evp-variable="firstName">{{firstName}}</span>`. It
  is deleted, moved and copied as one piece, so a coordinator cannot
  half-delete a brace and send `{{firstNam` to four hundred people. The braces
  inside the span are what both renderers already replace, which is why the
  span needs no support on either side. A fixture case proves that for both.
  `{{assignations}}` is a list, which HTML does not allow inside a paragraph,
  so it is a block node (`<div data-evp-variable="assignations">`).
- **Braces written as text still work.** A placeholder typed by hand stays
  text while it is being edited. It renders, and `unknownPlaceholders` still
  flags a misspelt one, exactly as before. When a template is loaded, which
  includes a draft saved from the textarea, each known placeholder becomes an
  atom and a `{{assignations}}` inside a paragraph is lifted out into its own
  block. Unknown ones stay text, so a typo is not dressed up as a chip.
- **Two serialisation fixes for mail clients.** A list item's paragraph is
  unwrapped (`<li>text</li>`), because Gmail and Outlook give it paragraph
  margins. An empty paragraph is written `<p><br></p>`, because they collapse
  an empty `<p>` and the blank line the coordinator made would vanish. The
  plain-text part sets paragraphs off by a blank line, on both renderers.
- **The default template is paragraphs**, not the spreadsheet's
  `<div dir="ltr">…<br><br>` markup, because that is what the editor would turn
  it into on the first keystroke anyway.

Versions are pinned exactly in `apps/admin/package.json`, like every other
dependency. The editor is admin-only, so the public form bundle does not grow
(`hoist: false` keeps it unable to import it).

## Alternatives considered

- **Keep the textarea.** This is the problem being fixed.
- **A textarea plus a toolbar that inserts tags.** It is still raw HTML. The
  coordinator sees `<b>` and can still unbalance it.
- **Markdown.** It changes the stored format, which means a converter on both
  renderers, a fixture to keep them agreeing, and every saved template read
  with a new meaning. It would also put syntax in front of people, which is
  what they asked not to see.
- **`contenteditable` with `document.execCommand`.** It has no dependency, but
  `execCommand` is deprecated and its output differs between browsers
  (`<b>` against `<strong>`, `<div>` against `<p>`). It also accepts whatever
  is pasted, inline styles and all, so every guarantee about the output would
  have to be a hand-written sanitiser.
- **Quill.** Its output relies on its own classes (`ql-indent-1`,
  `ql-align-center`) that mean nothing in a mail client.
- **CKEditor 5.** GPL-2.0-or-later or commercial. The licence would do, but the
  bundle is several times larger for features (tables, images, a source view)
  this template must not have.
- **Lexical.** It is React-first, and its Vue bindings are community-maintained.

## Consequences

- The admin bundle gains Tiptap and ProseMirror (MIT, all of them), but only on
  the emails route, which is lazily loaded.
- There is no HTML source view. Anything the schema cannot express cannot go
  into the template, and that limit is deliberate. A coordinator who needs a
  table or an image in the schedule email is asking for a schema change, which
  is decided here first.
- A draft saved in this browser before the change loads into the editor, which
  normalises it to the schema. The `<div dir="ltr">` wrapper becomes a
  paragraph, its `<b>` becomes `<strong>`, and its schedule becomes a block.
  What it says is unchanged.
- When templates move to the server, it stores the same string. Server-side
  sanitising against the same allowlist is still required there, because the
  editor is a convenience and the API re-decides everything
  ([12 §4](../12-security.md)).
