DELETE FROM retention_scope WHERE table_name = 'organizations'::regclass;
DROP TABLE IF EXISTS organizations;
