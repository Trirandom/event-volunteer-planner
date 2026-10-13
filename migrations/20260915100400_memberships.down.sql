DELETE FROM retention_scope WHERE table_name = 'memberships'::regclass;
DROP TABLE IF EXISTS memberships;
