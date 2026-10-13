-- The volunteer pool (docs/03 §3.3). One concern: the person, independent of
-- any one event — `participations` is what links them to an edition, and
-- lands in its own migration next.
--
-- `skills` and `volunteer_skills` are NOT here. Nothing in this vertical
-- slice reads or writes a skill: there is no assignment engine yet to consult
-- one, and a table with no code path touching it is schema nobody can test
-- (docs/13 §2). They land with the milestone that assigns by skill.
--
-- `unaccent()` is STABLE, not IMMUTABLE — it depends on a dictionary, so
-- PostgreSQL refuses it in a generated column. `immutable_unaccent` is the
-- standard wrapper that names the dictionary explicitly, safe because the
-- dictionary is pinned right there (docs/03 §3.1). It was not needed until
-- now, which is why it is migrated here rather than back in
-- `20260915100000_extensions_and_enums`.
CREATE FUNCTION immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
$$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

CREATE TABLE volunteers (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Reserved. Volunteers do not authenticate in v1 (ADR-0008); this is the
  -- attachment point if that is ever revisited. Always NULL for now.
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The roster label, stored exactly as given, never parsed. Required. The
  -- pool contains mononyms, stage names, emoji and 4-token names: ADR-0012.
  display_name  text NOT NULL,
  -- generated, for search and fuzzy matching only — never displayed, never an
  -- identity.
  display_name_norm text NOT NULL
    GENERATED ALWAYS AS (
      lower(regexp_replace(immutable_unaccent(display_name), '\s+', ' ', 'g'))
    ) STORED,
  sort_name     text,          -- optional, so 'SURNAME Firstname' can sort sensibly
  -- Name parts are ASKED by the form as separate questions, never derived by
  -- splitting display_name (ADR-0012). NULL for the legacy CSV import.
  first_name    text,          -- what we greet them by
  last_name     text,          -- disambiguates two volunteers sharing a first name
  email         citext,
  phone         text,
  tshirt_size   text CHECK (tshirt_size IN ('XS','S','M','L','XL','XXL','3XL')),
  -- Special-category-adjacent: free text that may reveal religion or health,
  -- so retaining it needs *explicit* consent (ADR-0021). Coordinators only,
  -- excluded from default exports.
  dietary       text,
  notes         text,          -- standing notes. VISIBLE to the volunteer in their export
  is_active     boolean NOT NULL DEFAULT true,
  -- Columns a coordinator has edited by hand. Intake never overwrites these.
  locked_fields text[] NOT NULL DEFAULT '{}',
  -- Per-channel opt-out, adopted from the spreadsheet's isEmailDisabled /
  -- isSmsDisabled flags. Respected by the publish worker.
  notify_email  boolean NOT NULL DEFAULT true,
  notify_sms    boolean NOT NULL DEFAULT true,
  locale        text NOT NULL DEFAULT 'fr',   -- emails, SMS and PDF are rendered in this
  -- Pool retention consent (ADR-0018). NULL means event-scoped only: this
  -- record is anonymised one month after the event, like everything else.
  pool_consent_at      timestamptz,
  pool_consent_version text,
  pool_consent_expires timestamptz,           -- last contact + org policy, recomputed on contact
  is_core_team         boolean NOT NULL DEFAULT false,  -- coordinator marker, not a consent gate
  anonymized_at timestamptz,   -- GDPR erasure: PII nulled, row kept for audit integrity
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  UNIQUE (id, org_id),                                  -- anchor for composite FKs
  -- An address identifies at most one volunteer in an organisation (ADR-0028).
  -- NULL is permitted any number of times: a volunteer with no email is
  -- supported, and is maintained by a coordinator.
  CONSTRAINT volunteers_email_unique_per_org UNIQUE (org_id, email)
);
CREATE INDEX ON volunteers (org_id) WHERE is_active;
CREATE INDEX volunteers_name_trgm ON volunteers
  USING gin (display_name_norm gin_trgm_ops);   -- pool search + fuzzy reconciliation
-- "who else in this org shares this first name?" — drives surname disambiguation
CREATE INDEX volunteers_first_name ON volunteers (org_id, lower(first_name))
  WHERE first_name IS NOT NULL;

CREATE TRIGGER volunteers_bump_version
  BEFORE UPDATE ON volunteers
  FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE volunteers ENABLE ROW LEVEL SECURITY;
ALTER TABLE volunteers FORCE ROW LEVEL SECURITY;
CREATE POLICY volunteers_tenant_isolation ON volunteers
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('volunteers', 'pool', 'the person; kept only by pool consent');
