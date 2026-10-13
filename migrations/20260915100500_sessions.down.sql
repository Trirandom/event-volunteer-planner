DELETE FROM retention_scope WHERE table_name = 'sessions'::regclass;
DROP TABLE IF EXISTS sessions;
