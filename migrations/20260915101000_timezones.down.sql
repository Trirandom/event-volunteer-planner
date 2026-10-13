DELETE FROM retention_scope WHERE table_name = 'timezones'::regclass;
DROP TABLE IF EXISTS timezones;
