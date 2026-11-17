# ADR-0050 — A coordinator is offered sixteen event colours, chosen to be told apart

**Status:** Accepted · **Date:** 2026-11-17
**Amends:** the palette contract in `packages/shared/src/eventColors.ts`
(offered count, and the values of indices 0–15)

## Context

`eventColors.ts` holds 64 colours. Each one clears 4.5:1 against both black and
white, and that rule pins all of them to one relative luminance (≈0.179). The
only things left to vary are hue and chroma. The picker offered the first 32.

The sequence was built by stepping 13/32 of the way round the hue wheel per
index. That keeps *consecutive* indices apart, but index 5 lands 65/32 turns
from index 0, which is one thirty-second of a turn. `#e40079` and `#e8005a`
are 0.047 apart in OKLab, two or three just-noticeable differences, and a
coordinator reported days 1 and 6 of a festival as "the same pink". At one
luminance, 32 hues cannot all be told apart. The muted half was already left
out of the picker for the same reason.

## Decision

- **The picker offers 16 colours** (`eventColorChoiceCount = 16`), in one row.
- **Indices 0–15 are regenerated in place** as the 16 colours, among those
  that pass the contrast gate, with the largest smallest pairwise OKLab
  distance. A chroma floor (C ≥ 0.09) keeps out the near-greys a pure
  farthest-point search drifts toward, which read as "disabled" on a board.
  Index 0 is kept, so the first day of every existing festival keeps its colour.
- **The order is farthest-point**: each index is the remaining colour farthest
  from everything before it. The server hands a new day the lowest index its
  siblings are not using, so the first *n* colours are what an *n*-day
  festival gets, and every prefix has to be as spread out as the set allows.
- `eventColors.test.ts` gates it: every offered pair at least 0.09 apart in
  OKLab, and the first four at least 0.2 apart.
- Indices 16–63 keep their values. The column still admits 64, and an event
  holding one of them keeps it, shown as an extra swatch (`eventColorChoices`).

Result: the closest offered pair goes from 0.047 to 0.093, and the first four
from 0.164 to 0.232.

## Alternatives considered

**Relax the contrast rule to 3:1 (graphics) and use lightness as a second
axis.** That would allow many more distinct colours. Rejected for now: the
rule exists because an event colour ends up as text and as a chip behind
text of either polarity, and nothing stops a coordinator doing that. It is
the better lever if 16 ever proves too few.

**Keep the values and offer a hand-picked subset of the 64.** Rejected. New
events get the lowest free index, so the first indices have to be the good
ones. A subset scattered through the list would leave the server handing out
colours the picker does not offer.

**Append 16 new colours at 64–79 and leave 0–15 alone.** This recolours
nothing, but it needs a migration widening the `CHECK`, a change to the
server's allocation range, and it leaves the bad colours as the ones the
server hands out first. Rejected: the values were wrong, and a wrong value
is corrected in place.

**Keep indices 0 and 1.** Tried. The best set then has a closest pair of
0.073, against 0.093 with only index 0 kept. Not worth one fewer recoloured
day.

## Consequences

- **Events on indices 1–15 are redrawn in their new colours.** This is the
  intended effect. Siblings stay distinct from each other, because the
  indices do not change, only the colours behind them.
- Events on 16–31 were offered and no longer are. They keep their colour,
  shown as the extra "current colour" swatch, until someone picks another.
- A festival with more than 16 days gets indices from the unoffered range,
  which are drawable but closer to the first 16. The server's allocation
  range is unchanged.
- Under colour-vision deficiency, equal-luminance colours collapse toward one
  axis, so some pairs will still be confusable. The event's name sits next to
  its colour wherever both appear, and that is what carries identity
  (docs/14 §2).
