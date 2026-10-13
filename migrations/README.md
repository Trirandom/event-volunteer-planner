# Migrations

Ordered `.sql` files applied by `sqlx migrate`, checksummed, forward-only.
The schema in [`docs/03 — Data model`](../docs/03-data-model.md) is milestone
work. The migrations here cover what is built so far — M0 through the
first-party form — and each later milestone brings its own. A migration
written ahead of the feature it serves is a migration written against a guess.

## The rules

- **Forward-only, immutable once applied, never edited.** `sqlx migrate` stores
  a checksum per version; editing an applied file makes every deployment that
  already ran it refuse to migrate. A mistake is corrected by a new migration
  ([docs/11 §4](../docs/11-engineering-standards.md#4-sql-and-migrations)).
- **Additive by default.** A migration that drops a column or a table, or that
  could otherwise lose data, needs an explicit reviewer sign-off noted in the
  pull request.
- **Reversible pairs.** Scaffold with `just migrate-new <name>`, which runs
  `sqlx migrate add -r <name>` and produces `<version>_<name>.up.sql` and
  `.down.sql`. The `down` file is written even though production never runs it:
  writing it is what forces the author to notice that a migration is not
  reversible, and to say so.
- **The suite runs against a database built from migrations alone**, never from
  a hand-maintained schema dump. A dump that has drifted from the migrations is
  a dump that passes tests the deployment will fail.
- **One concern per migration.** "Add the shifts table" and "add the exclusion
  constraint that makes double-booking impossible" are two, because the second
  is the one a reviewer must read.

## Who runs them, and as whom

The `migrate` service runs as **`evp_migrator`**, the database owner, and
exits. The `api` service waits on `service_completed_successfully` and connects
as **`evp_api`**, which owns nothing, is `NOSUPERUSER` and `NOBYPASSRLS`
([docs/06 §2](../docs/06-local-development.md#the-two-database-roles)).

Those three attributes are the entire tenant-isolation guarantee: Row-Level
Security is bypassed silently by a superuser, by `BYPASSRLS`, and by the owner
of the table being read. The API must be none of the three, which is why
migrations are a separate step with a separate role rather than something the
API does at boot.

Both roles exist before any migration runs — `docker/db/init/` creates them as
superuser on an empty data directory — so a migration may reference them by
name without creating them. The four extensions (`btree_gist`, `citext`,
`pg_trgm`, `unaccent`) are *trusted* in PostgreSQL 17, so `evp_migrator` can
`CREATE EXTENSION` them from a migration without being superuser
([docs/03 §3.1](../docs/03-data-model.md#31-extensions-and-enums)).

### Grants are a default, and two kinds of table must override it

`ALTER DEFAULT PRIVILEGES` in `docker/db/init/10-grants.sql` gives `evp_api`
`SELECT / INSERT / UPDATE / DELETE` on every table `evp_migrator` creates, at
creation time. That is what stops a migration written in two years producing a
table nobody remembered to grant.

It is the wrong default in exactly two situations, and both are the migration
author's responsibility **in the same migration that creates the table**:

- **`audit_log` is append-only.** It must
  `REVOKE UPDATE, DELETE ON audit_log FROM evp_api;` so that a compromised
  handler cannot rewrite history
  ([docs/12 §3](../docs/12-security.md#3-the-database-boundary)).
- **A table the API must not see at all** — anything reachable only by the
  migrator or by a `SECURITY DEFINER` function — must revoke the whole default
  grant. Leaving it is a privilege the RLS policies were never written to
  constrain.

A grant that is wrong is invisible until someone exploits it, so it belongs in
the migration next to the table, not in a follow-up.

## Every tenant table, in its own migration

A table carrying `org_id` is not finished until, in the same file:

1. `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` **and**
   `FORCE ROW LEVEL SECURITY;` — `ENABLE` alone still exempts the owner.
2. A policy with both `USING` and `WITH CHECK`. `USING` alone permits *writing*
   a row into another tenant.
3. Composite foreign keys carrying `org_id`, so a cross-tenant reference is a
   foreign-key violation rather than a policy question.
4. A `retention_scope` row declaring the table's tier
   ([ADR-0026](../docs/adr/0026-retention-scope-is-a-table-registry.md)).

A test that enumerates `pg_class` and fails on a table with `org_id` and no
policy, or with no retention tier, is planned so that the fourth person to add
a table, who has not read this file, cannot forget. Today only the form tables
are asserted (`crates/evp-db/tests/forms.rs`).

## Testing a migration

Every hard constraint gets a test that **attempts the violation** and asserts
the specific SQLSTATE — `23P01` for an exclusion constraint, `23505` for a
unique index, `23503` for a foreign key. A constraint nobody tried to break is
a constraint you are guessing about
([docs/13 §2](../docs/13-testing-and-tdd.md#2-where-test-first-is-mandatory)).

The database tests run against the migrated dev database, each inside one
transaction that is rolled back (`crates/evp-db/tests/catalog.rs` explains why
not `sqlx::test`), so they exercise the migrations rather than a snapshot of
what they were believed to produce.

## Scaffolding and applying

```
just migrate-new add-organizations   # sqlx migrate add -r add-organizations
just db-reset                        # drop, recreate, migrate
```

Applied in a container by the `migrate` service, whose command is `evp migrate`
rather than `sqlx migrate run`. The reason is the `_FILE` convention: a
connection URL embeds a password, so production passes
`EVP_MIGRATION_DATABASE_URL_FILE`, and `sqlx-cli` knows only `DATABASE_URL`.
Routing the migration through the binary that already implements that
convention keeps one implementation of it rather than two
([docs/17 §Configuration](../docs/17-backend-stack.md)). `sqlx` is still on
`PATH` in that image, which is what `migrate add` uses.
