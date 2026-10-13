DELETE FROM retention_scope WHERE table_name = 'assignments'::regclass;
DROP TRIGGER IF EXISTS assignments_period_sync ON assignments;
DROP FUNCTION IF EXISTS assignments_sync_period();
DROP TRIGGER IF EXISTS assignments_bump_version ON assignments;
DROP TABLE IF EXISTS assignments;
DROP TYPE IF EXISTS assignment_status;
