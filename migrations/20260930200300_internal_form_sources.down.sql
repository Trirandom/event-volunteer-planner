-- Not reversible without loss once a form has received a submission: those
-- batches carry trigger 'form', which the restored CHECK refuses. Delete them
-- (and their submissions, by cascade) first if this is ever run for real.
ALTER TABLE submission_batches
  DROP CONSTRAINT IF EXISTS submission_batches_trigger_check,
  ADD CONSTRAINT submission_batches_trigger_check
    CHECK (trigger IN ('upload', 'poll', 'webhook', 'api', 'replay'));
DROP INDEX IF EXISTS intake_sources_one_per_form;
ALTER TABLE intake_sources
  DROP CONSTRAINT IF EXISTS intake_sources_internal_has_form,
  DROP CONSTRAINT IF EXISTS intake_sources_form_fk,
  DROP COLUMN IF EXISTS form_id;
