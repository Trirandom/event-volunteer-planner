DELETE FROM retention_scope WHERE table_name = 'shifts'::regclass;
DROP TRIGGER IF EXISTS events_period_covers_shifts_check ON events;
DROP FUNCTION IF EXISTS events_period_covers_shifts();
DROP TRIGGER IF EXISTS shifts_within_event_check ON shifts;
DROP FUNCTION IF EXISTS shifts_within_event();
DROP TRIGGER IF EXISTS shifts_bump_version ON shifts;
DROP TABLE IF EXISTS shifts;
