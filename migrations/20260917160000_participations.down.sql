DELETE FROM retention_scope WHERE table_name = 'participations'::regclass;
DROP TABLE participations;
DROP TYPE participation_status;
