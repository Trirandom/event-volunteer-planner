# ADR-0041: Zones say how the form offers them (pre-ticked, 18+)

**Status:** Accepted · **Date:** 2026-10-08
**Amends:** [ADR-0036](0036-missions-question.md) (options gain two stamped
flags), docs/03 §3.4 (`locations` gains two columns) and docs/04 (locations
and form option shapes).

## Context

The `missions` question (ADR-0036) offers every mission unticked. For a
festival, that gets things backwards. Most missions (bar, gate, cleaning,
catering) can be done by anyone who turns up. Coordinators would rather have
volunteers untick the few they refuse than tick the many they would accept.
A few missions are different: sound, rigging, first aid, driving. They need a
skill nobody can check from a form. A pre-ticked box there would turn
"didn't read the list" into "can run the desk".

Some zones are also unsuitable for minors (the bar, night security). The form
collects no birthdate, so the planner cannot refuse anyone on age. It can make
sure a volunteer sees the restriction before ticking.

## Decision

**Two zone-only columns on `locations`, stamped onto the missions options.**

- `checked_by_default boolean NOT NULL DEFAULT true`: the form offers the
  mission already ticked. `false` marks a mission a volunteer must opt into.
- `adults_only boolean NOT NULL DEFAULT false`: the mission is for volunteers
  aged 18 or over. The form shows a badge. Such a mission is **never
  pre-ticked**, whatever `checked_by_default` says. Nothing is refused: a
  minor who ticks it has made a choice in front of the label, and the
  coordinator sees it at assignment.
- **Zones only.** A post is a job inside its zone and takes its zone's flags.
  The post row holds the neutral values (`locations_posts_have_no_form_flags`),
  so every existing INSERT stays valid without naming the columns.
- **Folding.** A mission folded across days (ADR-0036) is adults-only if
  *any* of its zones is, and pre-ticked only if *all* are and none is
  adults-only. One technical day is enough to make the whole option opt-in,
  because a single box covers every day.
- **Stamped, never sent.** Each `missions` option stores `checked_by_default`
  and `adults_only`. The server sets them from the zones on every draft `PUT`
  and again at publish, and ignores what the client sends. The zones are the
  only place a coordinator decides this, so the form builder cannot disagree
  with the missions page. Publishing freezes them with the rest of the
  options, like a renamed mission's label.
- **Old versions are unchanged.** An option frozen before this ADR has
  neither key. Both read `false`, which is how that version was offered.

## Alternatives considered

**A per-option toggle in the form builder.** That puts the decision on the
form instead of the mission, so every new form would ask it again. It also
lets two forms of one festival disagree about whether "Son" is technical.

**Collecting a birthdate and refusing 18+ missions to minors.** A birthdate is
personal data the planner otherwise has no use for (docs/10). The form
cannot verify it either, so the refusal would only be as good as the
volunteer's honesty, which the badge already relies on. A built-in "I am 18 or
older" question that disables 18+ missions stays possible later without
revisiting this.

**Nullable columns, NULL on posts.** That is more faithful than a neutral
value. But every INSERT that creates a zone would then need to name both
columns, and the seed, the worked example and the dump do not.

## Consequences

- One migration (`…093000`), one named `CHECK`, two columns.
- A zone flagged after publish does not change the live form until a new
  version is published (ADR-0036's versioning rule).
- The flags are information for the volunteer, not constraints on
  assignment. A soft `adults_only_mission` warning can be added under
  ADR-0007 once the planner knows anyone's age.
