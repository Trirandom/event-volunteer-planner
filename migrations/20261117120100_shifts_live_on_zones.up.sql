-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- One concern: shifts live on zones, and a post is a role within them
-- (ADR-0052). Existing post shifts are folded onto their zone first, then a
-- trigger refuses any new one.
--
-- **The fold loses no placement.** A post shift whose period equals one of its
-- zone's shifts merges into it: its placements move across, tagged with the
-- post, and the emptied post shift is deleted. The exclusion constraint
-- already guarantees no live volunteer was on both, since the two periods are
-- the same. Any other post shift moves to the zone whole, and its placements
-- are tagged where they stand. That may leave the zone with two overlapping
-- shifts, which the schema permits and the board draws as one bar.
--
-- The `operations` rows of folded shifts still name the post as their
-- location. Nothing reads them yet (undo is not built), and rewriting
-- history to match would make it a record of something that never happened.
--
-- **FORCE is lifted for the fold**, for the reason `…120100_events_color`
-- gives: a migrator session belongs to no organisation, so under FORCE these
-- statements would see no row and fold nothing, silently. It is restored
-- before this migration commits.
ALTER TABLE locations   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE shifts      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE assignments NO FORCE ROW LEVEL SECURITY;

-- Re-shift and tag in one UPDATE. The placement trigger checks the post
-- against the shift the placement ends up on, and tagging a placement while
-- it is still on the post's own shift would be refused: that shift's location
-- is the post, not the post's zone.
CREATE TEMPORARY TABLE post_shift_merges ON COMMIT DROP AS
SELECT ps.id AS post_shift_id, zs.id AS zone_shift_id, p.id AS post_id
  FROM shifts ps
  JOIN locations p ON p.id = ps.location_id AND p.kind = 'post'
  JOIN LATERAL (
    SELECT z.id FROM shifts z
     WHERE z.location_id = p.parent_id AND z.org_id = ps.org_id AND z.period = ps.period
     ORDER BY z.id
     LIMIT 1
  ) zs ON true;

UPDATE assignments a
   SET shift_id = m.zone_shift_id, post_id = m.post_id
  FROM post_shift_merges m
 WHERE a.shift_id = m.post_shift_id;

DELETE FROM shifts s USING post_shift_merges m WHERE s.id = m.post_shift_id;

-- What is left on a post has no twin on its zone. Move the shift, then tag
-- its placements: the other order would trip the shift-side check.
CREATE TEMPORARY TABLE post_shift_moves ON COMMIT DROP AS
SELECT s.id AS shift_id, p.id AS post_id, p.parent_id AS zone_id
  FROM shifts s
  JOIN locations p ON p.id = s.location_id AND p.kind = 'post';

UPDATE shifts s SET location_id = m.zone_id
  FROM post_shift_moves m WHERE s.id = m.shift_id;

UPDATE assignments a SET post_id = m.post_id
  FROM post_shift_moves m WHERE a.shift_id = m.shift_id;

ALTER TABLE assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE shifts      FORCE ROW LEVEL SECURITY;
ALTER TABLE locations   FORCE ROW LEVEL SECURITY;

-- A trigger and not a CHECK because the kind lives on the location's row.
-- Both statements a shift can reach a post by, inserting and moving. A
-- location's kind and parent cannot change through the API, so the location
-- side needs no twin.
CREATE FUNCTION shifts_on_zones() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM locations l
     WHERE l.id = NEW.location_id AND l.org_id = NEW.org_id AND l.kind = 'post'
  ) THEN
    RAISE EXCEPTION 'location % is a post; a post works its zone''s shifts', NEW.location_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'shift_on_post';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER shifts_on_zones_check
  AFTER INSERT OR UPDATE OF location_id ON shifts
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION shifts_on_zones();
