-- The first-party form's authoring side (docs/03 §3.11, docs/09): a form,
-- its immutable published versions and their questions. One concern — what
-- a coordinator writes and publishes — so the three tables travel together:
-- a version cannot exist without its form, and a question without its
-- version.
--
-- Scoped to a festival, a standalone event, or neither (ADR-0035). The
-- 'missions' kind is ADR-0036; untargeted custom questions and
-- `is_sensitive` are ADR-0037.
--
-- NOT here, although docs/03 §3.11 describes them beside these tables:
-- `form_invite_tokens`, the `submissions.form_version_id` /
-- `invite_token_id` / `locale` columns, `participation_missions` and
-- `participation_answers`. Nothing issues a token link or accepts a public
-- submission yet, and a table with no code path to write it is schema nobody
-- can test (docs/13 §2) — the same reasoning the intake migration
-- (`…150000`) gives for its absent mapping tables. They land with the public
-- form.
--
-- Beyond the docs/03 DDL, and why:
--   * `forms.updated_at`, so `bump_version()` (migration `…101200`) serves
--     this table as it serves the others with an ETag.
--   * `form_versions.etag_version` and its own trigger. `version` on that
--     table is the version *number* the coordinator sees (1, 2, …), so the
--     draft's concurrency token for `PUT`/`publish` (docs/04, `etag_version`)
--     needs a column of its own.
--   * `form_one_draft`: "409 if a draft already exists" (docs/04) held by a
--     partial unique index, so two coordinators clicking "new version" at
--     once cannot both win.
--   * `forms_live_version_same_form_fk`: the documented
--     `forms_live_version_fk` carries `org_id` and stops a cross-tenant live
--     version, and nothing else — a form could go live on *another form's*
--     version within one organisation. The second composite key closes that.
--   * `forms_default_locale_known` and `form_versions_published_together`,
--     both one-line statements of what the API already assumes.

CREATE TABLE forms (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The form's scope (ADR-0035): a festival (the normal case), a standalone
  -- event, or neither — pool recruitment, no availability, no participation.
  festival_id  uuid,
  event_id     uuid,
  slug         citext NOT NULL,         -- the public URL segment
  name         text NOT NULL,
  -- the version served right now; NULL while only drafts exist
  live_version_id uuid,
  public_open  boolean NOT NULL DEFAULT true,   -- token links keep working when false
  captcha      text CHECK (captcha IN ('none','turnstile','hcaptcha')) DEFAULT 'none',
  prefill_from_previous_event boolean NOT NULL DEFAULT false,
  default_locale text NOT NULL DEFAULT 'fr',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1,
  UNIQUE (org_id, slug),
  UNIQUE (id, org_id),
  FOREIGN KEY (festival_id, org_id) REFERENCES festivals(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, org_id)    REFERENCES events(id, org_id)    ON DELETE CASCADE,
  CONSTRAINT forms_one_scope CHECK (num_nonnulls(festival_id, event_id) <= 1),
  CONSTRAINT forms_default_locale_known CHECK (default_locale IN ('fr', 'en'))
);
CREATE INDEX ON forms (org_id, festival_id);
CREATE INDEX ON forms (org_id, event_id);

CREATE TRIGGER forms_bump_version
  BEFORE UPDATE ON forms
  FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms FORCE ROW LEVEL SECURITY;
CREATE POLICY forms_tenant_isolation ON forms
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('forms', 'accountability', 'form configuration; no personal data');

CREATE TABLE form_versions (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  form_id      uuid NOT NULL,
  version      int  NOT NULL,           -- the number the coordinator sees
  published_at timestamptz,             -- NULL: still a draft, still editable
  published_by uuid REFERENCES users(id),
  privacy_notice_version text,          -- recorded with each consent answer
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The draft's ETag, bumped on every UPDATE of the row. A `PUT` of the
  -- question list always touches the row, so it always moves this.
  etag_version int NOT NULL DEFAULT 1,
  UNIQUE (form_id, version),
  UNIQUE (id, org_id),
  UNIQUE (id, form_id),                 -- anchor for forms_live_version_same_form_fk
  FOREIGN KEY (form_id, org_id) REFERENCES forms(id, org_id) ON DELETE CASCADE,
  CONSTRAINT form_versions_published_together CHECK (
    (published_at IS NULL) = (published_by IS NULL)
  )
);
-- One draft at a time: a second one would be a second, divergent answer to
-- "what goes live next".
CREATE UNIQUE INDEX form_one_draft ON form_versions (form_id) WHERE published_at IS NULL;

CREATE FUNCTION bump_etag_version() RETURNS trigger AS $$
BEGIN
  NEW.etag_version := OLD.etag_version + 1;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER form_versions_bump_etag_version
  BEFORE UPDATE ON form_versions
  FOR EACH ROW EXECUTE FUNCTION bump_etag_version();

ALTER TABLE form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY form_versions_tenant_isolation ON form_versions
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('form_versions', 'accountability', 'the frozen question sets submissions are read against; no personal data');

CREATE TABLE form_questions (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  form_version_id uuid NOT NULL,
  kind         form_question_kind NOT NULL,
  -- Which consent this is, for kind = 'consent' only (ADR-0025). 'processing'
  -- is mandatory to submit; 'pool_retention' is optional and may never be
  -- marked required, because a consent that costs you something is not freely
  -- given.
  consent_purpose consent_purpose,
  -- Where the answer goes: a domain column (docs/09 §1, "Built-in
  -- questions"). NULL for 'section', 'availability', 'missions' and
  -- 'consent', which have their own destinations; for 'multi_choice' mapped to
  -- skills, where the target is per-option; and for a custom question, whose
  -- answer is kept per participation (ADR-0037).
  target_path  text,
  -- {"fr": "...", "en": "..."} for label, help text, and each option label
  label        jsonb NOT NULL,
  help_text    jsonb,
  -- [{value, label{}, skill_id?}]. For 'missions', value is the folded
  -- mission name key and the list is frozen at publish (ADR-0036).
  options      jsonb,
  is_required  boolean NOT NULL DEFAULT false,
  -- Excluded from default exports and hidden from zone leads (ADR-0037).
  is_sensitive boolean NOT NULL DEFAULT false,
  position     int NOT NULL,
  UNIQUE (form_version_id, position),
  UNIQUE (id, org_id),
  FOREIGN KEY (form_version_id, org_id) REFERENCES form_versions(id, org_id) ON DELETE CASCADE,
  CONSTRAINT form_question_options CHECK (
    (kind IN ('single_choice','multi_choice','missions')) = (options IS NOT NULL)
  ),
  -- ADR-0037: a question may be untargeted (a custom question), except that
  -- email and phone always feed the contact columns, and the kinds with their
  -- own destination never carry one.
  CONSTRAINT form_question_target CHECK (
    CASE
      WHEN kind IN ('email','phone') THEN target_path IS NOT NULL
      WHEN kind IN ('section','availability','missions','consent') THEN target_path IS NULL
      ELSE true
    END
  ),
  CONSTRAINT form_question_target_known CHECK (
    target_path IS NULL OR target_path IN (
      'volunteer.first_name','volunteer.last_name','volunteer.email',
      'volunteer.phone','volunteer.tshirt_size','volunteer.dietary','volunteer.notes')
  ),
  CONSTRAINT form_question_consent_purpose CHECK (
    (kind = 'consent') = (consent_purpose IS NOT NULL)
  ),
  -- the optional consent must stay optional; see ADR-0025
  CONSTRAINT form_question_pool_consent_optional CHECK (
    consent_purpose IS DISTINCT FROM 'pool_retention' OR is_required = false
  )
);
-- an availability picker is a whole-form control, not a repeatable question
CREATE UNIQUE INDEX form_one_availability ON form_questions (form_version_id)
  WHERE kind = 'availability';
CREATE UNIQUE INDEX form_one_missions ON form_questions (form_version_id)
  WHERE kind = 'missions';
-- a target is written at most once per version
CREATE UNIQUE INDEX form_one_question_per_target ON form_questions (form_version_id, target_path)
  WHERE target_path IS NOT NULL;
-- at most one consent question per purpose per version. That the 'processing'
-- one is PRESENT is a condition on a set of rows, so it is validated at publish.
CREATE UNIQUE INDEX form_one_consent_per_purpose
  ON form_questions (form_version_id, consent_purpose)
  WHERE kind = 'consent';

ALTER TABLE form_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY form_questions_tenant_isolation ON form_questions
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('form_questions', 'accountability', 'question wording and options; configuration, no personal data');

-- Added once form_versions exists, since the two tables reference each other.
ALTER TABLE forms ADD CONSTRAINT forms_live_version_fk
  FOREIGN KEY (live_version_id, org_id) REFERENCES form_versions(id, org_id);
ALTER TABLE forms ADD CONSTRAINT forms_live_version_same_form_fk
  FOREIGN KEY (live_version_id, id) REFERENCES form_versions(id, form_id);
