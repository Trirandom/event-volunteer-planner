DELETE FROM retention_scope WHERE table_name = 'locations'::regclass;
DROP TRIGGER IF EXISTS locations_bump_version ON locations;
DROP TABLE IF EXISTS locations;
DROP TYPE IF EXISTS location_kind;
