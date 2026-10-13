-- How many volunteers a mission takes, as a coordinator would say it on the
-- phone: "Bar needs at least four, never more than eight." Until now that
-- lived only on each shift (`required_count`/`max_count`), which is the right
-- place for a number that changes between the Friday-night rush and the
-- Sunday-morning lull, and the wrong place for the mission's own standing
-- answer, which a coordinator types once per mission and which no single
-- shift owns.
--
-- **Both nullable, independently.** NULL is "nobody has said", not zero and
-- not unbounded: a zone lead often knows the floor ("never fewer than two on
-- the gate") long before anyone has worked out a ceiling, and the reverse is
-- just as common for a post with a fixed number of tills. A sentinel value
-- for either would be a number some code eventually trusts.
--
-- **smallint.** A mission with more than 32767 volunteers is not a mission,
-- it is the event; the narrow type is the schema saying so rather than a
-- storage economy.
--
-- **Zones and posts alike** — unlike the map data in `…093312`. A zone's
-- bounds are the zone's own statement ("the whole bar area never below
-- twelve"), not a sum of its posts', and neither is derived from the other;
-- keeping them independent columns on the same row means a zone and a post
-- are staffed against numbers of the same shape.
--
-- **The bounds are hard, their meaning is soft.** Only what is plainly
-- incoherent is refused here: a negative floor, a ceiling of nothing (a
-- mission nobody may staff is a mission to delete, not to cap at zero), and a
-- ceiling below the floor. Whether a given staffing *meets* the bounds is a
-- soft warning for `evp-domain` to compute and a coordinator to override
-- (ADR-0007) — real events run on exceptions.
ALTER TABLE locations
  ADD COLUMN min_volunteers smallint CHECK (min_volunteers >= 0),
  ADD COLUMN max_volunteers smallint CHECK (max_volunteers >= 1);

-- Named, unlike the two column checks above, because it is the one the API
-- reads by name: a PATCH that sends only one side is compared against the
-- stored other side before the round trip, and a concurrent writer that
-- slips between that read and the UPDATE lands here — where the constraint
-- name is what lets the error mapping say which rule was broken.
ALTER TABLE locations
  ADD CONSTRAINT locations_volunteer_bounds_ordered
    CHECK (min_volunteers IS NULL OR max_volunteers IS NULL OR max_volunteers >= min_volunteers);

COMMENT ON COLUMN locations.min_volunteers IS
  'The fewest volunteers this mission should be staffed with. NULL when nobody has said. Zones and posts alike; never derived from a zone''s posts.';
COMMENT ON COLUMN locations.max_volunteers IS
  'The most volunteers this mission may take. NULL when nobody has said. At least 1, and at least min_volunteers when both are known.';
