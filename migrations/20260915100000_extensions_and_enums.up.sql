-- Extensions and the enums M0 needs.
--
-- All four extensions are *trusted* in PostgreSQL 17, so evp_migrator can
-- create them without being superuser (docs/03 §3.1). They are created here,
-- in the first migration, because citext is a column type used by the very
-- next one: an extension is not a feature, it is a precondition.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- No 'volunteer' value: volunteers do not authenticate (ADR-0008). Adding one
-- later is an ALTER TYPE, which is deliberately harder than getting it right.
CREATE TYPE member_role AS ENUM ('owner', 'coordinator', 'zone_lead');
