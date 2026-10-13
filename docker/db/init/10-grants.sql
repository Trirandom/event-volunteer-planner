-- Baseline privileges. Runs once, as the superuser, immediately after
-- 00-roles.sh, on an empty database: there are no tables yet, so everything
-- here is about what will be true of tables that do not exist.
--
-- That is the point. `ALTER DEFAULT PRIVILEGES` fixes the grant a table gets at
-- the moment it is created, so a migration added in two years' time produces a
-- table the API can already read without anybody remembering to grant it. The
-- alternative — a GRANT at the end of every migration — is a rule that holds
-- until the first person forgets, and the failure is discovered in production
-- as a permission denied on a route nobody tested.

-- No \connect: the postgres entrypoint already runs this file against
-- POSTGRES_DB as the superuser.

-- PostgreSQL 15+ already removes CREATE on `public` from PUBLIC. Stated anyway,
-- because this is the line that stops the API role from creating a table that
-- would then be owned by it — and an owner is not subject to its own RLS
-- policies unless the table is FORCE'd. A table the API owns is a table with no
-- tenant boundary.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL   ON SCHEMA public FROM evp_api;
GRANT  USAGE ON SCHEMA public TO   evp_api;

-- Tables the migrator creates from here on are readable and writable by the API
-- role — and by nobody else, since PUBLIC was revoked above. Row-Level Security
-- then decides which *rows* of them it sees; this decides which tables exist to
-- it at all. The two layers are independent and both are required: a missing
-- grant is a 500, a missing policy is a data leak.
ALTER DEFAULT PRIVILEGES FOR ROLE evp_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO evp_api;

ALTER DEFAULT PRIVILEGES FOR ROLE evp_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO evp_api;

-- Two consequences for whoever writes the migrations, because a default is a
-- default and these are the tables where it is wrong:
--
--   * `audit_log` is append-only (docs/03 §3.9). The default above hands the API
--     role UPDATE and DELETE on it, so its migration must REVOKE both. An audit
--     log the audited party can rewrite is not an audit log.
--   * Anything that should be invisible to the API role — a future
--     administrative or key-material table — must have its grant revoked in the
--     same migration that creates it, not later.
--
-- Both are asserted by the privilege test in docs/06 §4 rather than trusted to
-- this comment.
