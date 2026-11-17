-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- One concern: an assignment can say which post of its zone the volunteer
-- holds (ADR-0052). "Alex is bar manager on Bar 18:00–20:00" is one placement
-- on the bar's shift with a role on it, not a placement on a shift of its own:
-- a post works its zone's hours, and a post with separate shifts was a second
-- schedule kept equal to the first only by hand.
--
-- NULL is the ordinary case: the volunteer works the zone, with no particular
-- role.
--
-- **Composite with `org_id`**, like every other reference here, so a post of
-- another tenant is a foreign-key violation and not merely a row RLS hides.
-- `ON DELETE SET NULL (post_id)` because deleting a role does not take anybody
-- off the bar: they are still on its shift, which is what the row then says.
-- (The column list matters. A bare SET NULL would null `org_id` too.)
ALTER TABLE assignments
  ADD COLUMN post_id uuid,
  ADD CONSTRAINT assignments_post_id_org_id_fkey
    FOREIGN KEY (post_id, org_id) REFERENCES locations(id, org_id)
    ON DELETE SET NULL (post_id);

CREATE INDEX ON assignments (post_id) WHERE post_id IS NOT NULL;

-- The post must belong to the shift's zone. A CHECK cannot say it, because
-- both the post's parent and the shift's location live on other rows, so it
-- is a constraint trigger, and like `shift_outside_event` it guards both
-- directions: tagging (or re-shifting) the placement, and moving the shift
-- out from under a tagged one. Moving a shift between zones is refused rather
-- than clearing its tags, because clearing would drop a role a coordinator
-- set without anybody being told.
--
-- A cancelled placement is history and holds no role, so it is checked on
-- neither side: it neither needs a valid post nor pins its shift in place.
CREATE FUNCTION assignments_post_in_zone() RETURNS trigger AS $$
BEGIN
  IF NEW.post_id IS NULL OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM shifts s
      JOIN locations p ON p.parent_id = s.location_id AND p.org_id = s.org_id
     WHERE s.id = NEW.shift_id AND s.org_id = NEW.org_id
       AND p.id = NEW.post_id AND p.kind = 'post'
  ) THEN
    RAISE EXCEPTION 'post % is not a post of the zone shift % is at', NEW.post_id, NEW.shift_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'assignment_post_outside_zone';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER assignments_post_in_zone_check
  AFTER INSERT OR UPDATE OF post_id, shift_id, status ON assignments
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assignments_post_in_zone();

CREATE FUNCTION shifts_keep_post_holders_in_zone() RETURNS trigger AS $$
BEGIN
  IF NEW.location_id IS NOT DISTINCT FROM OLD.location_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM assignments a
      JOIN locations p ON p.id = a.post_id AND p.org_id = a.org_id
     WHERE a.shift_id = NEW.id AND a.org_id = NEW.org_id
       AND a.status <> 'cancelled'
       AND p.parent_id IS DISTINCT FROM NEW.location_id
  ) THEN
    RAISE EXCEPTION 'shift % has volunteers holding posts of its current zone', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'assignment_post_outside_zone';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER shifts_keep_post_holders_in_zone_check
  AFTER UPDATE OF location_id ON shifts
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION shifts_keep_post_holders_in_zone();

COMMENT ON COLUMN assignments.post_id IS
  'The post of the shift''s zone this volunteer holds, or NULL for the zone itself (ADR-0052). Set to NULL when the post is deleted.';
