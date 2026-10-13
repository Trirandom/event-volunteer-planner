DROP INDEX IF EXISTS submissions_by_form_version;
ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_form_has_locale,
  DROP CONSTRAINT IF EXISTS submissions_locale_known,
  DROP CONSTRAINT IF EXISTS submissions_form_version_fk,
  DROP COLUMN IF EXISTS locale,
  DROP COLUMN IF EXISTS form_version_id;
