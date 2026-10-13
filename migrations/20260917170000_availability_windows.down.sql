DELETE FROM retention_scope WHERE table_name = 'availability_windows'::regclass;
DROP TABLE availability_windows;
DROP TYPE availability_kind;
