ALTER TABLE IF EXISTS forms DROP CONSTRAINT IF EXISTS forms_live_version_same_form_fk;
ALTER TABLE IF EXISTS forms DROP CONSTRAINT IF EXISTS forms_live_version_fk;
DELETE FROM retention_scope WHERE table_name::text IN ('form_questions', 'form_versions', 'forms');
DROP TABLE IF EXISTS form_questions;
DROP TABLE IF EXISTS form_versions;
DROP FUNCTION IF EXISTS bump_etag_version();
DROP TABLE IF EXISTS forms;
