-- Three of the six hard rules (docs/02 §5, docs/05 §2), all on `assignments`.
-- One concern: nobody can be in two places at once, nobody is on the same
-- shift twice, and nobody who has declined or withdrawn holds a placement.
--
-- Separate from the migration that creates the table because this is the file
-- a reviewer must actually read (migrations/README.md): the table is storage,
-- these are the guarantee. Every one of them is enforced here rather than in a
-- handler, so the answer to "can this be bypassed?" is no, rather than "not
-- through the endpoint I looked at".

-- HARD INVARIANT: one volunteer is never in two places at once, across every
-- event in the deployment and not only within one. Keyed off the denormalised
-- `volunteer_id`/`period` because an exclusion constraint cannot join; the
-- previous migration's composite FK and sync trigger are what make that copy
-- trustworthy.
--
-- `WHERE (status <> 'cancelled')` because a cancelled row is history: it says
-- somebody *was* rostered here, and history must not block the replacement.
ALTER TABLE assignments
  ADD CONSTRAINT assignments_no_double_booking
  EXCLUDE USING gist (volunteer_id WITH =, period WITH &&)
  WHERE (status <> 'cancelled');

-- HARD INVARIANT: no duplicate placement on the same shift. A partial unique
-- index rather than an EXCLUDE — every operator here is equality, so a B-tree
-- does the job at a fraction of a GiST index's cost (docs/03 §3.6).
CREATE UNIQUE INDEX assignments_one_per_shift
  ON assignments (shift_id, volunteer_id) WHERE status <> 'cancelled';

-- Moving a shift moves its live assignments, which is what makes the drag on
-- the shift board fail loudly if it would double-book somebody rather than
-- silently leaving a roster that no longer matches the hours worked. The
-- exclusion constraint above is what raises; this trigger is what puts the
-- rows in front of it.
CREATE FUNCTION shifts_propagate_period() RETURNS trigger AS $$
BEGIN
  IF NEW.period IS DISTINCT FROM OLD.period THEN
    UPDATE assignments SET period = NEW.period
     WHERE shift_id = NEW.id AND status <> 'cancelled';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER shifts_period_propagate
  AFTER UPDATE OF period ON shifts
  FOR EACH ROW EXECUTE FUNCTION shifts_propagate_period();

-- HARD INVARIANT: a declined or withdrawn participant cannot hold an
-- assignment. Not expressible as a CHECK — the status it depends on is on
-- another table — and needed in both directions, because the interesting case
-- is not assigning a withdrawn volunteer but *withdrawing* one who is already
-- on the roster (docs/03 §3.6).
CREATE FUNCTION assignments_participant_assignable() RETURNS trigger AS $$
DECLARE st participation_status;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  SELECT p.status INTO st FROM participations p WHERE p.id = NEW.participation_id;
  IF st NOT IN ('invited', 'confirmed') THEN
    RAISE EXCEPTION 'participation % is %, so it cannot hold an assignment',
      NEW.participation_id, st
      USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawn_participant';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER assignments_participant_assignable_check
  AFTER INSERT OR UPDATE OF participation_id, status ON assignments
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assignments_participant_assignable();

-- The other direction: withdrawing somebody who still holds live assignments
-- is refused rather than quietly leaving them on the roster. The coordinator
-- cancels the assignments first, and that is the action that republishes.
CREATE FUNCTION participations_withdrawal_is_clean() RETURNS trigger AS $$
DECLARE live int;
BEGIN
  IF NEW.status IN ('declined', 'withdrawn') THEN
    SELECT count(*) INTO live FROM assignments a
     WHERE a.participation_id = NEW.id AND a.status <> 'cancelled';
    IF live > 0 THEN
      RAISE EXCEPTION 'participation % still holds % assignment(s)', NEW.id, live
        USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawn_participant';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER participations_withdrawal_check
  AFTER UPDATE OF status ON participations
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION participations_withdrawal_is_clean();
