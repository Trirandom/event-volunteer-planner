DELETE FROM retention_scope WHERE table_name = 'operations'::regclass;
DROP TABLE IF EXISTS operations;
