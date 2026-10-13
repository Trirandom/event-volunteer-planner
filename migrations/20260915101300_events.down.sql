DELETE FROM retention_scope WHERE table_name = 'events'::regclass;
DROP TRIGGER IF EXISTS events_bump_version ON events;
DROP TABLE IF EXISTS events;
