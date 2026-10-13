-- The FK target for every "this must be a real IANA name" column (docs/03
-- §3.4). A CHECK cannot do this job: CHECK expressions must be immutable and
-- cannot contain a subquery, which rules out both `now() AT TIME ZONE tz` and
-- a lookup in `pg_timezone_names`.
--
-- Snapshotted at migration time rather than queried live: a FOREIGN KEY needs
-- a table to point at, and `pg_timezone_names` is a view, not a table. Refresh
-- by a later migration that re-runs the INSERT when tzdata is bumped in the
-- image — this table is a cache of that view, not a live mirror of it.
CREATE TABLE timezones (
  name text PRIMARY KEY
);

INSERT INTO timezones (name) SELECT name FROM pg_timezone_names;

-- Reference data, not tenant data: no org_id, and the API never writes it.
REVOKE ALL ON timezones FROM evp_api;
GRANT SELECT ON timezones TO evp_api;

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('timezones', 'accountability', 'reference data with no personal content; an FK target, not a record about anyone');
