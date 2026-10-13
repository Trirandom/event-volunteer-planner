DELETE FROM retention_scope WHERE table_name IN ('users'::regclass, 'identities'::regclass);
DROP TABLE IF EXISTS identities;
DROP TABLE IF EXISTS users;
