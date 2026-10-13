# 14 — Accessibility and interaction

Two goals that turn out to be the same goal: the application must be usable by
people who cannot use a mouse, and it must let a coordinator make **mass
modifications fast**. Both require that everything is reachable and operable
from the keyboard, so building for the first gives the second nearly free.

Target: **WCAG 2.2 level AA**, with RGAA 4 as the French compliance frame
([ADR-0017](adr/0017-accessibility-target-wcag22-aa.md)).

## 1. Why this is not optional

Whether the European Accessibility Act or RGAA strictly binds a cultural
association is a question for a lawyer. It is also the wrong question. The
volunteer pool is a slice of the general public: some of them do not use a
mouse, some use a screen reader, some cannot distinguish red from green, and
all of them are being asked to fill in a form. A form they cannot complete is a
volunteer lost.

Three WCAG 2.2 criteria bear directly on decisions already taken, and they turn
preferences into requirements:

| Criterion | Level | Consequence here |
| --- | --- | --- |
| **2.5.7 Dragging Movements** | AA | **Every drag must have a non-drag alternative.** The planner board's drag-and-drop assignment and the availability picker's drag track each require a keyboard and pointer-click equivalent. This was already specified as good practice; it is a conformance requirement. |
| **3.3.8 Accessible Authentication (Minimum)** | AA | No cognitive function test in the login path. Magic links and OIDC both pass; a password with a puzzle or a memory test would not. The auth decisions in [ADR-0013](adr/0013-google-oidc-without-an-identity-provider.md) already satisfy this. |
| **2.1.4 Character Key Shortcuts** | A | Single-character shortcuts must be remappable, switchable off, **or active only when a component has focus.** This shapes the shortcut design in §5 — ours are focus-scoped. |

## 2. Ground rules

**Semantics before ARIA.** A real `<button>`, `<label>`, `<table>`, `<dialog>`.
ARIA is for when no native element fits, and *no ARIA is better than bad ARIA* —
a wrong `role` actively misinforms a screen reader, where plain HTML would have
worked.

- Every input has a programmatically associated `<label>`. Placeholder text is
  not a label.
- Focus is **never** removed. `:focus-visible` styling is required, with a
  visible indicator at 3:1 contrast against its background.
- No `tabindex` greater than 0. Ever. DOM order is tab order.
- Colour is never the only carrier of meaning. A constraint warning is an icon
  **and** text **and** a colour.
- Contrast: 4.5:1 for body text, 3:1 for large text and UI boundaries.
- Text reflows without horizontal scrolling at 320 px equivalent width and at
  400% zoom (1.4.10). **320 px is the conformance floor; 400 px is the width the
  form is designed for**, which is where the other documents' "must work at
  400 px" comes from — the two are not in tension, and a layout that only works
  at 400 px fails here. The board is the exception permitted for data tables,
  and it scrolls in one axis inside its own container, not the page.
- Target size at least 24×24 CSS px (2.5.8); the availability picker and other
  touch-first surfaces use 44 px, which is a comfort target rather than a
  conformance one.
- `prefers-reduced-motion` disables transitions and any animated drag preview.
- `forced-colors` mode is tested: borders and focus rings must survive it,
  which means not relying on `background-color` alone to delimit a control.

**Announce asynchronous outcomes.** An optimistic assignment that the server
refuses must be announced, not merely un-rendered. `aria-live="polite"` for
successes, `assertive` for constraint refusals, and the message says what
happened and why.

**Manage focus deliberately.** On dialog open, focus moves in and is trapped;
on close, it returns to the trigger. On an optimistic rollback, focus stays put
and the error is associated with the control via `aria-describedby`. On route
change, the new view's heading is focused so a screen reader is not left in the
old context.

## 3. The planner board

The densest surface, and the one where accessibility and power use converge.

It is an **ARIA grid**: `role="grid"` with rows for locations and cells for
(location, time-bucket). Interaction follows the APG grid pattern, because a
custom navigation model would have to be learned by everyone.

| Key | Action |
| --- | --- |
| `↑ ↓ ← →` | Move between cells |
| `Home` / `End` | First / last cell in the row |
| `Ctrl+Home` / `Ctrl+End` | First / last cell in the grid |
| `PageUp` / `PageDown` | Scroll by a day |
| `Enter` | Open the focused shift's roster |
| `Space` | Toggle selection of the focused shift |
| `Escape` | Clear selection, or close the panel |

**Roving tabindex**: exactly one cell is tabbable at a time, so the board is a
single tab stop rather than 2 700 of them. Getting this wrong makes the whole
application untabbable, which is why it is stated rather than assumed.

The grid carries `aria-rowcount` / `aria-colcount` for the *virtual* extent, and
each rendered row its real `aria-rowindex` — virtualisation otherwise tells a
screen reader that a seven-day event has twelve columns.

Each cell announces its post, its time range **in the event timezone**, its
fill against required headcount, and any warnings on its assignments.

## 4. Mass modification

The explicit request, and the thing that decides whether this beats a
spreadsheet for a coordinator's actual working session. A spreadsheet is very
fast at bulk edits; a web app that requires a mouse click per assignment is not
a replacement.

### Selection

A real multi-selection model, on both axes of the problem:

- Click, `Shift+Click` for a range, `Ctrl/Cmd+Click` to toggle.
- `Ctrl/Cmd+A` selects everything **in the current scope** — the focused zone,
  or the focused day — never the whole event by surprise.
- Shifts *and* volunteers are selectable. Selecting three volunteers and four
  shifts and pressing `Enter` is the bulk primitive.
- The selection count is always visible, and announced on change.

### Bulk operations

Each is one server transaction, evaluated against the constraint engine per
pair, returning a per-item result rather than an all-or-nothing failure — so
"assign these 3 to these 12 shifts" reports the two that clashed and applies
the rest, with the refusals listed by name and reason. That is the API
convention, not a UI nicety: the endpoints and their response shape are in
[04](04-api.md#assignments--the-core-write-path), and the distinction between
per-item bulk and atomic replacement is
[ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md).

| Operation | Why it matters |
| --- | --- |
| Assign selection → selection | The core bulk action |
| Clear selected shifts | Undo a bad pass quickly |
| **Copy a day, paste onto another** | Festival days repeat. This is the single biggest time saver, and it is what the spreadsheet did well by dragging a range |
| Copy a shift's roster, paste onto another shift | Same post, next slot |
| Fill gaps at a post | Ranked candidates, coordinator confirms each |
| Replace volunteer X with Y across a selection | Someone drops out |

### Type-ahead assignment

With a shift focused, **start typing a name** — the candidate panel filters
live, ranked by eligibility and availability, and `Enter` assigns the top
match. No mouse, no dialog.

This deliberately reproduces the one thing the spreadsheet's data-validation
dropdown was genuinely good at
([10 §1](10-prior-art-spreadsheet.md#1-what-it-actually-does)): type a few
letters, get the right person. Losing that would make the replacement feel
slower even while being more correct.

### Undo

**Bulk editing without undo is bulk editing nobody dares to do.** So:

- `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` operate on an **operation stack of domain
  actions**, not on text or on optimistic UI state.
- Every mutating operation — including each bulk one — records its inverse
  server-side in `operations`, so undo is a real compensating transaction and
  works after a page reload, from another machine, and for a change a colleague
  made. `POST …/operations/{id}/undo` is the endpoint
  ([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)).
- The inverse is replayed **through the domain service**, so an undo passes the
  constraint engine and can legitimately be refused — the world may have moved
  on. It is also refused when a later operation has touched the same entities,
  rather than silently reverting somebody else's work.
- Undo of a published change is refused with an explanation. Publication has
  already sent email; the correction is a new change and a republish.
- The audit log records the undo as its own entry, with a reference to what it
  reversed. History is append-only.

This is a genuine backend requirement, not a frontend nicety, and it is why
every mutating endpoint returns an operation id.

### Command palette

`Ctrl/Cmd+K`. Every action in the application is reachable and searchable from
it, with its shortcut shown beside it.

It solves discoverability, which is what usually kills keyboard efficiency:
shortcuts nobody knows about are shortcuts nobody uses. `?` opens the full
shortcut sheet.

### Shortcut hygiene

- Single-character shortcuts are **scoped to a focused component**, which is how
  WCAG 2.1.4 is satisfied without building a remapping system.
- No shortcut fires while a text input or textarea has focus, unless it carries
  a modifier.
- Nothing overrides a browser or assistive-technology binding — `Ctrl+W`,
  `Ctrl+T`, `Ctrl+N`, `Ctrl+L`, `F6` and friends are off limits.
- Shortcuts are not user-configurable in v1. Documented as a known gap.

## 5. The volunteer form

Filled in once, on a phone, by someone with no training and no incentive to
persist. It gets the strictest treatment.

- Works at 320 px. Single column, no horizontal scroll.
- Native inputs wherever they exist, so platform accessibility comes free.
- The availability picker's **numeric time entry is a first-class input, not a
  fallback** ([09 §3](09-volunteer-form.md#3-the-availability-picker)) — it
  satisfies 2.5.7 and is often the fastest path on a phone regardless.
- Errors are summarised at the top with in-page links to each field, and each
  field's message is associated by `aria-describedby`. Never colour alone.
- Progress is preserved: the form drafts to `localStorage` as it is filled, so a
  dropped connection at a venue does not discard ten minutes of work.
- No timeout. A form that expires while someone is thinking is a form that loses
  a volunteer.

## 6. Modern web platform

- **Browser support policy: Baseline Widely Available.** A feature is used when
  it has been interoperable across the major engines for long enough to be in
  that set, rather than against a hand-maintained browserslist that nobody
  revisits. Anything newer needs a fallback or a documented reason.
- **Progressive enhancement where it is cheap**, particularly on the form:
  semantic HTML and native validation first, JavaScript enriching it. The
  availability picker genuinely requires JavaScript and says so.
- `prefers-color-scheme` honoured; both themes meet contrast requirements
  independently.
- No layout shift: skeletons reserve the space their content will occupy.
- View Transitions only behind `prefers-reduced-motion`, and never load-bearing
  for comprehension.
- No custom scrollbars, no scroll hijacking, no focus stealing.

## 7. Enforcement

Status as in [11 §7](11-engineering-standards.md#7-enforcement-summary).

| Check | Gate | Stage | Status |
| --- | --- | --- | --- |
| Automated audit | `@axe-core/playwright` on every route and on the form, zero violations (`just e2e`) | test | partial — most coordinator specs, and the form's unavailable page; not a rendered form yet |
| Keyboard-only journey | Playwright, no pointer events: sign in → plan an event → bulk assign → publish | test | planned — bulk assign and publish do not exist; the board's keyboard resize is covered |
| No `tabindex > 0` | ESLint `vuejs-accessibility` + a DOM assertion | check | lint enforced; DOM assertion planned |
| Focus visible | Assertion that `:focus-visible` styling is not suppressed | test | planned |
| Contrast | Token-level contrast test over the palette, both themes (`packages/shared/src/tokens.test.ts`) | test | enforced |
| Reduced motion | Assertion that transitions are disabled under the media query | test | planned |
| Forced colors | Playwright with `forcedColors: "active"` on key screens (the `forced-colors` project) | test | enforced |
| Reflow | Screenshot assertions at 320 px and 400% zoom | test | planned |
| Semantics | `eslint-plugin-vuejs-accessibility`, `vue/no-v-html` (`pnpm lint`) | check | enforced |

Automated tools catch perhaps a third of real problems. The keyboard-only
journey test is the one that catches the rest, and a **manual screen-reader pass
on the board and the form is a release gate** for any change to either —
recorded in the pull request, not automated, because nothing automated can tell you that
an announcement was incomprehensible.
