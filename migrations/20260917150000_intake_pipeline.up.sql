-- The intake pipeline's provenance tables (docs/03 §3.10). One concern:
-- knowing where a volunteer's data came from and when — `intake_sources`,
-- `submission_batches`, `submissions` and `submission_payloads` travel
-- together because `submissions` cannot exist without the first two (its
-- `source_id` and `batch_id` are NOT NULL) and `submission_payloads` is the
-- other half of `submissions`, split into its own table only so that expiring
-- the verbatim answers is a DELETE rather than an UPDATE (docs/03 §3.10).
--
-- Migrated before `availability_windows`, which carries a foreign key to
-- `submissions` — and after `volunteers`, which `submissions.volunteer_id`
-- references.
--
-- `intake_fields`, `intake_field_mappings`, `intake_slot_options` and
-- `intake_value_mappings` are NOT here: they back the column-mapping UI for a
-- *live* CSV/webhook/API source, and nothing in M0's worked example goes
-- through that UI. `evp_db::catalog::create_example` writes
-- `volunteers` / `participations` / `availability_windows` rows directly, the
-- same way it already writes festivals/events/locations/shifts, and records
-- exactly the `intake_sources` / `submission_batches` / `submissions` /
-- `submission_payloads` rows that write would have left as its provenance
-- trail. A mapping table with no mapping UI to write to it would be schema
-- nobody could test (docs/13 §2); they land with the milestone that builds
-- that UI.
CREATE TYPE intake_source_kind AS ENUM ('csv_upload', 'google_sheet', 'webhook', 'api', 'internal_form');
CREATE TYPE submission_state   AS ENUM ('received', 'needs_review', 'applied', 'rejected', 'superseded');
-- 'token': arrived through a per-volunteer form link, so identity is certain
CREATE TYPE match_kind         AS ENUM ('token', 'exact_email', 'fuzzy_confirmed', 'manual', 'new');

CREATE TABLE intake_sources (
  id       uuid PRIMARY KEY,
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id uuid,                        -- NULL: not scoped to a single event
  kind     intake_source_kind NOT NULL,
  name     text NOT NULL,

  -- kind-specific settings: spreadsheet_id, sheet range, provider, header_row…
  config   jsonb NOT NULL DEFAULT '{}',
  -- HMAC verification needs the secret itself, so it is encrypted, not hashed
  webhook_secret_encrypted bytea,
  -- API keys are only ever compared, so they are hashed and shown once
  api_key_hash             bytea,

  -- hash of the sorted set of external_keys last seen; drift detection
  schema_fingerprint bytea,
  -- poll cursor for sheet sources
  last_row           int,
  last_polled_at     timestamptz,
  last_submission_at timestamptz,

  -- reconciliation tuning, per source
  fuzzy_threshold    real NOT NULL DEFAULT 0.85 CHECK (fuzzy_threshold BETWEEN 0 AND 1),
  is_active          boolean NOT NULL DEFAULT true,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 1,
  UNIQUE (id, org_id),
  UNIQUE (org_id, name),
  FOREIGN KEY (event_id, org_id) REFERENCES events(id, org_id) ON DELETE CASCADE,
  CONSTRAINT intake_sources_webhook_has_secret CHECK (
    kind <> 'webhook' OR webhook_secret_encrypted IS NOT NULL
  ),
  CONSTRAINT intake_sources_api_has_key CHECK (
    kind <> 'api' OR api_key_hash IS NOT NULL
  )
);

ALTER TABLE intake_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY intake_sources_tenant_isolation ON intake_sources
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE submission_batches (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL,
  source_id  uuid NOT NULL,
  trigger    text NOT NULL CHECK (trigger IN ('upload','poll','webhook','api','replay')),
  file_name  text,
  row_count  int  NOT NULL DEFAULT 0,
  -- 'accepted' | 'held' (new unmapped fields) | 'refused' (required field vanished)
  outcome    text NOT NULL DEFAULT 'accepted'
             CHECK (outcome IN ('accepted','held','refused')),
  drift      jsonb,                       -- {added: [...], removed: [...]}
  stats      jsonb NOT NULL DEFAULT '{}', -- {created, updated, review, rejected}
  created_by uuid REFERENCES users(id),   -- NULL for poll and webhook
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  FOREIGN KEY (source_id, org_id) REFERENCES intake_sources(id, org_id) ON DELETE CASCADE
);

ALTER TABLE submission_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY submission_batches_tenant_isolation ON submission_batches
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE submissions (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  source_id    uuid NOT NULL,
  batch_id     uuid NOT NULL REFERENCES submission_batches(id) ON DELETE CASCADE,
  event_id     uuid,
  -- Provider response id, or for CSV a content hash plus occurrence index.
  -- This is the idempotency key: replaying a source applies nothing new.
  external_id  text NOT NULL,
  -- The verbatim answers live in submission_payloads, one row further out, so
  -- that expiring them is a DELETE rather than an overwrite (ADR-0026). What
  -- stays here is provenance: which source, which version, when, matched how.
  -- `raw_keys` records which fields were present, with no values, so replay
  -- history stays coherent after the payload has gone.
  raw_keys     text[] NOT NULL DEFAULT '{}',
  received_at  timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,               -- the provider's own timestamp, if given

  state        submission_state NOT NULL DEFAULT 'received',
  volunteer_id uuid,                      -- resolved identity; NULL until matched
  match_kind   match_kind,
  match_candidates jsonb,                 -- ranked alternatives, for the review queue
  errors       jsonb,                     -- [{field, code, message}]
  supersedes_id uuid REFERENCES submissions(id) ON DELETE SET NULL,
  reviewed_by  uuid REFERENCES users(id),
  reviewed_at  timestamptz,
  applied_at   timestamptz,

  UNIQUE (source_id, external_id),
  UNIQUE (id, org_id),
  FOREIGN KEY (source_id, org_id)    REFERENCES intake_sources(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, org_id)     REFERENCES events(id, org_id)         ON DELETE CASCADE,
  FOREIGN KEY (volunteer_id, org_id) REFERENCES volunteers(id, org_id)     ON DELETE SET NULL,
  CONSTRAINT submissions_applied_has_volunteer CHECK (
    state <> 'applied' OR (volunteer_id IS NOT NULL AND applied_at IS NOT NULL)
  )
);
CREATE INDEX submissions_review_queue ON submissions (org_id, source_id)
  WHERE state = 'needs_review';
CREATE INDEX submissions_by_volunteer ON submissions (volunteer_id, submitted_at DESC);

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY submissions_tenant_isolation ON submissions
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Exactly what arrived. Never modified, and deleted `submission_raw_days`
-- after receipt (default 30) because its purpose — replay after a mapping
-- fix — is short-lived. Its own table, its own clock: a pool submission
-- belongs to no event, so an event-scoped sweep would never have reached it
-- (ADR-0026).
CREATE TABLE submission_payloads (
  submission_id uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  raw           jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (submission_id, org_id) REFERENCES submissions(id, org_id) ON DELETE CASCADE
);
CREATE INDEX submission_payloads_raw_gin ON submission_payloads USING gin (raw jsonb_path_ops);
CREATE INDEX submission_payloads_age ON submission_payloads (received_at);

ALTER TABLE submission_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_payloads FORCE ROW LEVEL SECURITY;
CREATE POLICY submission_payloads_tenant_isolation ON submission_payloads
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('intake_sources',      'accountability', 'the configuration of one intake channel; holds no personal data'),
  ('submission_batches',  'accountability', 'provenance of an import run'),
  ('submissions',         'accountability', 'provenance: which form, when, matched how'),
  ('submission_payloads', 'ephemeral',      'verbatim answers; replay window only');
