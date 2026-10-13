DROP TYPE IF EXISTS member_role;

-- The extensions are deliberately NOT dropped. Another database in the same
-- cluster may share them, and DROP EXTENSION cascades to every dependent
-- object — which on a mistake is the whole schema.
