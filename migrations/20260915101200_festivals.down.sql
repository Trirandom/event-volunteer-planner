DELETE FROM retention_scope WHERE table_name = 'festivals'::regclass;
DROP TRIGGER IF EXISTS festivals_bump_version ON festivals;
DROP TABLE IF EXISTS festivals;
DROP FUNCTION IF EXISTS bump_version();
DROP TYPE IF EXISTS event_status;
