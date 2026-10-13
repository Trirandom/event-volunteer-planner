DELETE FROM retention_scope WHERE table_name = 'volunteers'::regclass;
DROP TABLE volunteers;
DROP FUNCTION immutable_unaccent(text);
