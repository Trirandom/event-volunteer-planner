#!/bin/bash
# Roles and database ownership. Runs once, as the superuser, on an empty data
# directory — the postgres entrypoint executes everything in /docker-entrypoint-
# initdb.d in filename order and never runs it again. A re-run means `just
# db-reset`, which drops the volume.
#
# This file exists because the tenant-isolation guarantee in docs/02 §4 is a
# property of *who connects*, not of the queries. Row-Level Security is bypassed
# silently by a superuser, by BYPASSRLS, and by the owner of the table being
# read. So the API must connect as a role that is none of those three, and that
# separation has to be established before the first table exists — retrofitting
# it means auditing every table and every grant.
#
# Two roles, one job each:
#   evp_migrator  owns the database and every object in it; runs `sqlx migrate`
#   evp_api       owns nothing, creates nothing, and is subject to every policy

# Deliberately not `set -u`. The postgres entrypoint *sources* this file when it
# is not executable — a real case, since the execute bit does not survive every
# checkout — and a `set -u` left switched on would then apply to the rest of the
# entrypoint, which reads unset variables freely. `set -e` and `pipefail` are
# already on there, so setting them again is harmless; every variable below is
# expanded with an explicit default instead.
set -eo pipefail

# Secrets are files in production (compose `secrets`) and plain values in dev,
# following the same *_FILE convention the postgres image uses for its own
# password. Reading the file here keeps the value out of `docker inspect`.
read_secret() {
  local name="$1" file_var="${1}_FILE"
  if [ -n "${!file_var:-}" ]; then
    if [ ! -r "${!file_var}" ]; then
      echo "db-init: ${file_var} is set to '${!file_var}' but it is not readable" >&2
      exit 1
    fi
    cat "${!file_var}"
  elif [ -n "${!name:-}" ]; then
    printf '%s' "${!name}"
  else
    echo "db-init: neither ${name} nor ${file_var} is set" >&2
    exit 1
  fi
}

MIGRATOR_PASSWORD="$(read_secret EVP_DB_MIGRATOR_PASSWORD)"
API_PASSWORD="$(read_secret EVP_DB_API_PASSWORD)"

# Passwords are passed as psql variables, never interpolated into the SQL text,
# so a password containing a quote cannot terminate the statement. :'name' quotes
# and escapes as a string literal.
psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -v migrator_password="$MIGRATOR_PASSWORD" \
     -v api_password="$API_PASSWORD" \
     -v dbname="$POSTGRES_DB" <<-'EOSQL'

	-- Neither role may create databases or roles, and neither is a superuser.
	-- NOBYPASSRLS is the default and is stated anyway: it is the one attribute
	-- that would silently void every policy in the schema, so it should be
	-- visible here rather than inferred from its absence.
	CREATE ROLE evp_migrator LOGIN PASSWORD :'migrator_password'
	  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

	CREATE ROLE evp_api LOGIN PASSWORD :'api_password'
	  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

	-- The migrator owns the database, so it owns the `public` schema through
	-- pg_database_owner and can create the extensions the schema needs. All four
	-- (btree_gist, citext, pg_trgm, unaccent) are *trusted* in PostgreSQL 17,
	-- which is what lets docs/03 §3.1 create them from a migration rather than
	-- needing a superuser step here.
	ALTER DATABASE :"dbname" OWNER TO evp_migrator;

	-- UTC at the database level, so a session that forgets to set it still reads
	-- correctly (docs/16 §1). The application sets it per pooled connection too;
	-- this is the backstop, not the mechanism.
	ALTER DATABASE :"dbname" SET timezone TO 'UTC';

	-- No ambient connect right. Access is granted, not inherited from PUBLIC.
	REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
	GRANT CONNECT ON DATABASE :"dbname" TO evp_migrator, evp_api;
EOSQL

echo "db-init: roles evp_migrator and evp_api created"
