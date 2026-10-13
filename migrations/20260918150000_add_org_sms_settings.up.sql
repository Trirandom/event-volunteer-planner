-- One organisation's OVH SMS credentials (ADR-0034). One row per org — an
-- OVH account, its service and its sender id belong to that org, not to the
-- deployment — so `org_id` is the primary key rather than a separate
-- surrogate `id` with a unique constraint bolted on: there is never a second
-- row for the same org to distinguish from the first.
--
-- `application_secret_encrypted` and `consumer_key_encrypted` follow the same
-- shape `intake_sources.webhook_secret_encrypted`
-- (`20260917150000_intake_pipeline`) already reserved: encrypted, not hashed,
-- because OVH's request signature needs the plaintext back on every send, not
-- just a comparison. `application_key` is stored in the clear beside them,
-- the same way `intake_sources.api_key_hash` is the secret half of a
-- kind=api source while its identifying half sits in `config` — OVH's
-- Application Key identifies an application, it is not usable to sign a
-- request on its own.
CREATE TABLE org_sms_settings (
  org_id     uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider IN ('ovh')),

  application_key             text  NOT NULL,
  application_secret_encrypted bytea NOT NULL,
  consumer_key_encrypted       bytea NOT NULL,
  service_name                text  NOT NULL,
  sender                      text  NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES users(id)
);

ALTER TABLE org_sms_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_sms_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_sms_settings_tenant_isolation ON org_sms_settings
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('org_sms_settings', 'accountability', 'organisation configuration — an OVH account and sender id, not personal data; the secret and consumer key are encrypted, not personal');
