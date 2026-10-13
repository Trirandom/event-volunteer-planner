-- Append-only: who changed what (docs/03 §3.9, docs/12). `org_id` is
-- nullable — some rows are deployment-level, e.g. account linking on a
-- `users` row before any organisation is chosen — so it cannot carry the
-- uniform tenant policy: a policy of the form `org_id = current_setting(...)`
-- never matches NULL, which would make deployment-level rows invisible and
-- unwritable.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label text,
  subject_volunteer_id uuid,   -- FK added when volunteers (M1) lands
  operation_id uuid REFERENCES operations(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  before      jsonb,
  after       jsonb,
  request_id  text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (org_id, occurred_at DESC);
CREATE INDEX ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX ON audit_log (subject_volunteer_id) WHERE subject_volunteer_id IS NOT NULL;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Tenant rows are the tenant's; deployment-level rows can be written but are
-- not readable through a tenant session. No UPDATE or DELETE policy at all —
-- an audit log the audited party can rewrite is not an audit log, and that is
-- also why the default grant is narrowed below.
CREATE POLICY audit_tenant_read ON audit_log FOR SELECT
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY audit_append ON audit_log FOR INSERT
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              OR org_id IS NULL);

-- docker/db/init/10-grants.sql hands evp_api SELECT/INSERT/UPDATE/DELETE on
-- every table evp_migrator creates. Wrong here by design (docs/03, migrations
-- README): a compromised handler must not be able to rewrite history.
REVOKE UPDATE, DELETE ON audit_log FROM evp_api;

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('audit_log', 'accountability', 'who changed what');
