# ADR-0052 — A post is a role within its zone's shifts, not a schedule of its own

**Status:** Accepted · **Date:** 2026-11-17
**Amends:** docs/03 §3.4 (`locations`, `shifts`) and §3.6 (`assignments`),
docs/02 §5 and docs/05 §2 (supporting constraints)

## Context

Locations nest one level: a zone contains posts (docs/01 §5, docs/03 §3.4).
Until now the schema let a shift sit on either, and the boards took that at
its word. A post was a mission of its own: its own line on the shift board,
cut on its own, staffed on its own line on the assignation board, and sorted
alphabetically, so "Bar manager" landed far from "Bar".

That is not how a post is worked. A *Bar manager* works the bar's hours, the
same hours as everyone else behind the bar. Coordinators planning Soundclash
26 asked for three things:

- a zone's posts appear with their zone, on both boards;
- a post has the same shifts as its zone, so the two share one row;
- a volunteer on a post counts as one of the zone's volunteers: the zone's
  min/max is the whole zone, and the post's people come out of it.

The last point is what the bounds already said. The migration that added
`min_volunteers`/`max_volunteers` defines a zone's floor as "the whole bar
area never below twelve". Only the boards ignored it, because a post's people
sat on a different shift from the zone's.

## Decision

**Shifts live on zones.** A post has no shifts of its own. A constraint
trigger refuses a shift on a post (`23514`, constraint `shift_on_post`), on
insert and on a move.

**An assignment can name a post.** `assignments.post_id` is nullable. Null
means the volunteer works the zone, with no particular role. Otherwise it is
a post of *the shift's zone*. A composite foreign key `(post_id, org_id)`
keeps it in the tenant. A constraint trigger in both directions keeps it in
the zone: on the assignment (setting `post_id` or `shift_id`) and on the
shift (moving it to another location while tagged placements hang off it),
`23514`, constraint `assignment_post_outside_zone`. Deleting a post sets
`post_id` to null (`ON DELETE SET NULL (post_id)`). The volunteer stays on
the zone's shift, which is what they still are.

**Counting.** A zone's `min_volunteers`/`max_volunteers` count every live
placement on its shift, posts included. A post's bounds are the part of that
reserved for the role. On one slot:

- each post shows `max(post min, people on it)` seats, its required ones
  first;
- the zone's own (role-less) seats are what is left of the zone's floor:
  `max(0, zone min − Σ max(post min, people on the post))`;
- nothing is offered past the zone's ceiling, nor past a post's.

Where the zone has said nothing, the shift's `required_count`/`max_count`
stand in for its bounds, as before. These are board readings, not schema
rules: whether a roster meets them stays soft-warning territory (ADR-0007).

**Existing post shifts are folded onto their zone** by a migration. A post
shift whose period equals one of its zone's shifts merges into that one, and
its placements move across with `post_id` set. Otherwise the shift itself
moves to the zone and its placements are tagged. No placement is dropped:
the exclusion constraint already guarantees a volunteer could not be on both
the post's shift and an identical zone shift.

**The boards show one row per zone.** On the shift board the zone's posts are
named in its label, with their bounds, and the bars are the zone's. On the
assignation board a slot's seats are its posts' seats, then the zone's own,
and each post keeps the same lines in every slot of a lane: the row header
names the post once, level with them, the way the spreadsheet's merged cells
did, and a slot with fewer of that post's people leaves the line empty
rather than let a role-less seat rise into it. Assigning into a post seat
sends its `post_id`.

## Alternatives considered

**Keep post shifts and mirror the zone's cuts onto them.** No schema change.
Rejected: it is two records of one schedule, kept equal by the client. A cut
made through the API, a failed fan-out or a concurrent edit leaves them
disagreeing, and the counting rule then has to sum across shifts that are
"the same" only by convention. ADR-0029 rejected exactly this kind of
alignment layer for patterns.

**A post as a skill or tag on the volunteer.** Rejected: being bar manager is
a fact about one shift, not about the person. The same volunteer runs the
bar on Friday and pours on Saturday.

**Leave old post shifts alone and refuse only new ones.** Rejected: both
boards would have to draw the old shape for ever, next to the new one, and
the zone count would silently miss those placements.

**Refuse moving a tagged shift, or clear its tags?** Clearing would drop a
role a coordinator set, without saying so. The trigger refuses instead. The
board never moves a shift between zones, so this is the API's edge case.

## Consequences

- A post-level shift pattern (`locations.shift_pattern_id` on a post) no
  longer means anything: there is nothing to generate on a post.
  `shifts/generate` on a post is refused by the same trigger.
- `docs/03`'s note that a zone's bounds are "never a sum over its posts" still
  holds. They are not derived from the posts. Posts are carved out of them.
- The `operations` rows of shifts that were folded keep pointing at the post.
  Nothing reads them yet (undo is not built), and the migration says so.
- A zone lead's scope (`zone_lead_scopes`, not built) gets simpler: scoping to
  a zone now covers every shift whose people it may place.
