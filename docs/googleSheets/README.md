# Prior art — the Google Sheets system

The working system this project replaces: the Apps Script sources from
*Soundclash 26*. The exported sheets they ran against are not published. Kept as reference, because the design decisions in
`docs/` are answers to problems this system either solved or ran into.

Analysis and what it changed in the design:
**[10 — Prior art: the spreadsheet](../10-prior-art-spreadsheet.md)**

## Contents

| File | What it does |
| --- | --- |
| `gen-dropdown-menu.js` | Per-column data validation: each time slot's dropdown lists volunteers available then |
| `gen-dropdown-menu-strict.js` | Per-**cell** validation from a precomputed `_dropdowns` sheet, keyed on (mission × slot). The sophisticated version. |
| `recap-formula.js` | `VOLUNTEER_SUMMARY` custom functions — scan the assignment grid for a name, merge contiguous slots of the same mission |
| `send-email.js` | Per-volunteer schedule email. SHA-256 change detection, first-vs-follow-up templates, dry run, test mode, script lock, sender-account lock |
| `send-sms.js` | Same over SMS, via OVH (Twilio alternative included) |
| `optimize-sms-text.js` | GSM-7 transliteration, to keep a message inside one paid segment |
| `gen-ics.js` | ICS calendar invite generation |
| `gen-global-planning.js` | Exports the planning sheet as a landscape PDF via the Sheets export URL |
| `utils.js` | Name normalisation, sheet-cell logging, date helpers |
| `example_data/*.csv` | The seven sheets, exported and pseudonymised. **Not in this repository** — gitignored, kept by the maintainer as the evidence behind [10](../10-prior-art-spreadsheet.md) and ADR-0012 |

## Sheets

| Sheet | Role |
| --- | --- |
| `réponses` | Raw Google Form responses |
| `dispo` / `somme dispo` | Volunteers × slots availability matrix, with a per-volunteer total |
| `matrice dispo` | Missions × slots eligibility |
| `_dropdowns` | The two above, flattened: one column of eligible names per (mission, slot) pair |
| `assignation` | The planning grid — missions × slots, each cell a validated volunteer name |
| `récap assignation` / `récap bénévoles` / `récap par jour` | Read-only pivots |
| `emails` | Control panel: send flags, templates, per-volunteer digests and opt-outs |

## Privacy

The sheet export is not published (see above); this section records how the
maintainer's copy was prepared, because docs/10 and ADR-0012 cite it as
evidence. **That data is pseudonymised.** It contained 75 identifiable
volunteers.

- All 75 names were replaced with invented ones, consistently across all seven
  sheets. No original name remains.
- Replacements deliberately preserve the *shape* of the originals — token
  counts, `ALLCAPS` and lowercase surnames, mononyms, emoji, stage names,
  parenthesised nicknames, particles, accents — because that variety is the
  evidence behind the identity decisions in
  [ADR-0012](../adr/0012-name-parts-asked-not-parsed.md).
- Two real defects were preserved on purpose: one person appears with a double
  space in one sheet and a single space in another, and another with a
  different surname casing. These are the exact reason name-as-identity fails.
- Contact addresses were replaced with `example.org` ones.
- Phone and email columns were already empty in the export.
- Credentials in the scripts were already replaced with `__secret__` by the
  author.

The organisation and event names were kept — they are not personal data and
they make the material readable.
