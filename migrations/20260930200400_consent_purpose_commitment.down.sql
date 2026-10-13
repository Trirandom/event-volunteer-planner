-- PostgreSQL cannot drop a value from an enum. Rebuilding the type is the only
-- way back, and it fails — as it should — while any question still carries
-- 'commitment': delete those questions (or their draft versions) first if this
-- is ever run for real.
ALTER TYPE consent_purpose RENAME TO consent_purpose_old;
CREATE TYPE consent_purpose AS ENUM ('processing', 'pool_retention');
DROP INDEX IF EXISTS form_one_consent_per_purpose;
ALTER TABLE form_questions
  DROP CONSTRAINT IF EXISTS form_question_pool_consent_optional,
  ALTER COLUMN consent_purpose TYPE consent_purpose
    USING consent_purpose::text::consent_purpose;
ALTER TABLE form_questions ADD CONSTRAINT form_question_pool_consent_optional CHECK (
  consent_purpose IS DISTINCT FROM 'pool_retention' OR is_required = false
);
CREATE UNIQUE INDEX form_one_consent_per_purpose
  ON form_questions (form_version_id, consent_purpose)
  WHERE kind = 'consent';
DROP TYPE consent_purpose_old;
