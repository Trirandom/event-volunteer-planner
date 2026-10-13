-- A first-party submission pins the version it answered (docs/03 §3.11,
-- docs/09 §2): its answers are keyed by that version's question ids and are
-- read against that version's questions forever, which is what makes editing
-- a live form safe.
--
-- Two of the three columns docs/03 §3.11 lists. `invite_token_id` and its
-- `submissions_internal_has_version` CHECK wait for `form_invite_tokens`,
-- which does not exist yet — nothing issues a token link, and a foreign key
-- to a table that is not there cannot be written.
--
-- Beyond the docs/03 DDL, and why:
--   * The foreign key carries `org_id`, like every other on a tenant table,
--     so a submission cannot name another organisation's version.
--   * `ON DELETE CASCADE`: a version is only ever deleted with its form (a
--     published version is frozen, and a form with one is refused deletion by
--     the API), and the form's intake source (`…200300`) takes the same
--     submissions with it. A `NO ACTION` key here would race that cascade
--     inside one statement and turn deleting a festival into a 23503.
--   * `locale` is one of the two form locales, and is present whenever the
--     submission came from a form — the form is what asked in one.
ALTER TABLE submissions
  ADD COLUMN form_version_id uuid,
  ADD COLUMN locale text,
  ADD CONSTRAINT submissions_form_version_fk
    FOREIGN KEY (form_version_id, org_id) REFERENCES form_versions(id, org_id) ON DELETE CASCADE,
  ADD CONSTRAINT submissions_locale_known CHECK (locale IS NULL OR locale IN ('fr', 'en')),
  ADD CONSTRAINT submissions_form_has_locale CHECK (form_version_id IS NULL OR locale IS NOT NULL);

CREATE INDEX submissions_by_form_version ON submissions (form_version_id)
  WHERE form_version_id IS NOT NULL;
