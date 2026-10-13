-- The retention registry (ADR-0026).
--
-- Every table that holds anything about a person declares which retention tier
-- it belongs to, here, in the migration that creates it. The registry exists
-- rather than a convention because CI enumerates pg_class and fails on a table
-- with no tier: the fourth person to add a table, who has not read the README,
-- cannot forget.
--
-- `regclass` rather than `text` is the load-bearing choice — PostgreSQL
-- resolves the name to an OID at INSERT time, so a row naming a table that does
-- not exist is rejected, and a later DROP is refused while the row remains.
-- A registry that can name a table that was deleted two years ago is not a
-- registry.
CREATE TABLE retention_scope (
  table_name regclass PRIMARY KEY,
  tier       text NOT NULL CHECK (tier IN ('event','pool','accountability','ephemeral')),
  reason     text NOT NULL CHECK (length(btrim(reason)) > 0)
);

-- The registry is metadata, not tenant data: the API never reads it and must
-- not write it. The default grant from docker/db/init/10-grants.sql is
-- therefore wrong here, and is revoked in the same migration that creates the
-- table, per migrations/README.md.
REVOKE ALL ON retention_scope FROM evp_api;
