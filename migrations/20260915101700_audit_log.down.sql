DELETE FROM retention_scope WHERE table_name = 'audit_log'::regclass;
DROP TABLE IF EXISTS audit_log;
