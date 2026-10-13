-- One concern: an assignment's participation must be for the edition the shift
-- is worked at.
--
-- Not covered by anything in the two migrations before it. `event_id` on an
-- assignment is taken from its *shift* by `assignments_sync_period`, and the
-- composite keys already there police tenancy — so within one organisation a
-- volunteer who signed up for Friday could be rostered onto a Saturday shift,
-- and every constraint would be satisfied. That is not a clash the exclusion
-- constraint can see: it is one participation too few, and it would surface as
-- somebody receiving a schedule for a day they never agreed to work.
--
-- Expressible as a foreign key because `participations` already carries the
-- anchor for it: `UNIQUE (id, event_id)`. A check in the application layer
-- would answer the same question one transaction later than the write.
ALTER TABLE assignments
  ADD CONSTRAINT assignments_participation_is_this_edition
  FOREIGN KEY (participation_id, event_id)
  REFERENCES participations(id, event_id) ON DELETE CASCADE;
