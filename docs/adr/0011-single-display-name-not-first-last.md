# ADR-0011 — A volunteer has one display name, not a first and last name

**Status:** **Superseded by [ADR-0012](0012-name-parts-asked-not-parsed.md)** · **Date:** 2026-09-10

> The evidence below stands: name parts must never be *parsed* out of a
> combined field. The conclusion drawn from it was too broad. Optional
> `first_name` and `last_name`, **asked directly by our form** rather than
> derived, are needed for greetings and for telling two volunteers with the
> same first name apart. See ADR-0012.

## Context

[03 — Data model](../03-data-model.md) originally gave `volunteers` a required
`first_name` and `last_name`, and [08 — Volunteer intake](../08-volunteer-intake.md)
offered a `split` transform as the way to populate them from a form's single
"Prénom et nom" field. I noted that splitting would mangle
`"Jean-Pierre de la Tour"` and accepted it, on the grounds that a preview would
make the mangling visible.

Then the real pool arrived: 75 volunteers from the existing spreadsheet
([10 — Prior art](../10-prior-art-spreadsheet.md)). The name shapes in it are:

- `SURNAME Firstname` — and `Firstname surname`, and `Firstname SURNAME`
- bare mononyms with no surname at all: `Jo`, `Kev`, `Sami`, `Lily`
- stage and scene names: `Gibson`, `Moustache`, `Zoravel`, `Poerava`
- a name with an emoji: `Camille 🐚`
- a parenthesised nickname: `Chaumette Ludo (Ptilud)`
- a dot inside a given name: `Papadakis Iris.Edna`
- three and four tokens: `Karim BELKACEM TERRIER`, `Damien Krebs Full D`
- a DJ name appended: `Elyne lavigne djcolibri`
- particles: `Le Goff Antoine`, `Alba De sousa`
- hyphenated compounds: `Souvannarath Marie-Aline`, `Neumann Nûr-Eddine`

A first/last split is not merely lossy here. It is wrong for a *majority* of
the pool, and for the mononyms it would have to invent a surname or reject a
volunteer who has given a perfectly usable name.

Two further facts settle it. The spreadsheet's own logic treats the whole name
as one opaque string (`cleanNameToLowerCase`), so it never needed the split.
And the data contains two people whose name differs only by whitespace or
casing between sheets — evidence that even the *unsplit* string is a poor
identifier, let alone its parsed halves.

## Decision

`volunteers.display_name` is the canonical name: required, stored verbatim as
the volunteer wrote it, never parsed.

```sql
display_name       text NOT NULL,          -- exactly as given. Never parsed.
display_name_norm  text NOT NULL,          -- generated: casefolded, whitespace-collapsed,
                                           -- accents stripped. For search and match only.
first_name         text,                   -- optional, coordinator-entered
last_name          text,                   -- optional, coordinator-entered
sort_name          text,                   -- optional, for alphabetical listing
```

- Sorting uses `coalesce(sort_name, display_name_norm)`, so a coordinator can
  make `SURNAME Firstname` sort sensibly without the schema pretending to know
  which token is which.
- `display_name_norm` is a generated column and exists **only** for search and
  fuzzy matching. It is never displayed, and it is not an identity.
- Identity remains the surrogate key. `display_name_norm` feeds the trigram
  step of the reconciliation ladder
  ([08 §6](../08-volunteer-intake.md#6-identity-reconciliation)) and nothing
  else.
- The form asks one name question. `split` remains available as an intake
  transform for foreign sources that genuinely have two columns, but it is no
  longer the recommended path and no longer the default.

## Alternatives considered

**Keep first/last required, split on import.** Rejected on the evidence above:
wrong for most of this pool, and impossible for mononyms.

**Keep first/last, optional and nullable, with `display_name` generated from
them.** Inverts the dependency the wrong way — the authored value would be the
parsed halves and the displayed value derived, so a mononym or an emoji name
still has nowhere to live.

**Structured name parts** (given, family, particle, suffix, preferred). The
thorough answer, and genuinely correct for international names. Rejected as
disproportionate: this is a volunteer roster of a few hundred people, the
output is a printed shift sheet and an email greeting, and nothing in the
domain needs to know which part is the family name.

**Normalise on the way in** — enforce a canonical `SURNAME Firstname` shape.
Rejected: it discards the name a volunteer chose, including scene names that
are the only name their colleagues know them by. The printed roster would then
be less useful on site than the spreadsheet's.

## Consequences

- Every name in the existing pool imports verbatim, with no mangling and no
  rejections.
- Volunteers known only by a stage name are first-class.
- Alphabetical listing needs `sort_name` for names written surname-last, which
  is a coordinator task for the few cases that matter. Default ordering on
  `display_name_norm` is imperfect and accepted.
- "Group by family" and "find siblings" are not supported. Nobody asked for
  them.
- Fuzzy matching operates on the whole normalised string rather than on a
  surname, which slightly weakens it — a match on `display_name_norm` is
  broader than a match on a family name would be. Mitigated by the existing
  rule that a name match alone never auto-merges: a second corroborating field
  is always required.
- Email greetings use `display_name` whole, so a volunteer may be greeted
  "Bonjour SURNAME Firstname". Acceptable, and fixable per volunteer by
  filling `first_name`.
