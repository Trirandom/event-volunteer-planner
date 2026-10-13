-- The first-party form as an intake source (docs/08 §9): each form gets one
-- `intake_sources` row of kind `internal_form`, and each public submission
-- arrives as a batch of one, the way a webhook call would.
--
-- `intake_sources` had no way to say *which* form a source is. A name
-- convention would have been matched on prose; this is a composite foreign
-- key like every other, plus the two rules that make it mean something:
--   * `intake_sources_internal_has_form` — an `internal_form` source names its
--     form, and no other kind does.
--   * `intake_sources_one_per_form` — one source per form, so the lazy
--     "create the source on the first submission" in
--     `evp_db::public_forms::record_submission` is race-free: two first
--     submissions arriving together meet on this index (`ON CONFLICT … DO
--     NOTHING`) rather than creating two sources.
--
-- `ON DELETE CASCADE` matches `event_id` on the same table: the source, its
-- batches and its submissions go with the form — which, once published, only
-- happens when its festival or event is deleted.
--
-- `submission_batches.trigger` gains `form`. None of the five existing
-- values is true of a volunteer pressing «Envoyer»: it is not an upload, a
-- poll, a provider webhook, a caller holding an API key, or a replay.
ALTER TABLE intake_sources
  ADD COLUMN form_id uuid,
  ADD CONSTRAINT intake_sources_form_fk
    FOREIGN KEY (form_id, org_id) REFERENCES forms(id, org_id) ON DELETE CASCADE,
  ADD CONSTRAINT intake_sources_internal_has_form
    CHECK ((kind = 'internal_form') = (form_id IS NOT NULL));

CREATE UNIQUE INDEX intake_sources_one_per_form ON intake_sources (form_id)
  WHERE form_id IS NOT NULL;

ALTER TABLE submission_batches
  DROP CONSTRAINT submission_batches_trigger_check,
  ADD CONSTRAINT submission_batches_trigger_check
    CHECK (trigger IN ('upload', 'poll', 'webhook', 'api', 'replay', 'form'));
