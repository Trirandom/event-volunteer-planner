-- Who a person is, and how they prove it.
--
-- `users` and `identities` are deliberately NOT tenant-scoped and carry no
-- `org_id`: one person may belong to several organisations, so identity is
-- global and *authorisation* is what is tenant-scoped (docs/03). They are
-- therefore exempt from the uniform RLS policy, and cross-user reads are
-- prevented in the session extractor instead. The CI check that enforces RLS
-- enumerates tables with an `org_id` column, which these do not have.
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  -- citext, so 'Marie@example.org' and 'marie@example.org' are one account.
  -- An address that differs only in case is the same mailbox everywhere that
  -- matters, and treating them as two accounts is how duplicate owners happen.
  email         citext NOT NULL UNIQUE,
  display_name  text   NOT NULL,
  locale        text   NOT NULL DEFAULT 'fr',
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- One user may have several identities: a password (this milestone), an emailed
-- magic link, and any OIDC provider the deployment configured (ADR-0014).
CREATE TABLE identities (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The `id` of a provider declared in providers.toml, 'email' for magic links,
  -- or 'password'. IMMUTABLE once used: renaming a provider orphans its
  -- identities.
  provider      text NOT NULL,
  -- The provider's stable subject — usually the `sub` claim, NOT the address,
  -- because emails change and `sub` does not. For 'email' and 'password' it is
  -- the address itself, which is the best stable subject available when we are
  -- the authority.
  subject       text NOT NULL,
  email_at_link citext,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,

  -- Argon2id PHC string: algorithm, parameters and salt travel with the hash,
  -- so raising the cost later does not invalidate existing hashes — they are
  -- verified at the parameters they were written with, and rewritten on next
  -- successful login. Nullable because it is meaningless for every other
  -- provider, and the CHECK below is what stops that nullability becoming a
  -- password identity with no password.
  password_hash text,

  UNIQUE (provider, subject),
  UNIQUE (user_id, provider),

  -- Both directions, deliberately. `password_hash IS NOT NULL` alone would
  -- permit a 'password' row with no hash, which would be an account that
  -- cannot be logged into but silently occupies the unique slot; the equality
  -- also forbids storing a hash against an OIDC identity, where it would be a
  -- credential nobody knows exists.
  CONSTRAINT identities_password_hash_iff_password
    CHECK ((provider = 'password') = (password_hash IS NOT NULL))
);
CREATE INDEX ON identities (user_id);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('users',      'accountability', 'who acted; attribution outlives the event'),
  ('identities', 'accountability', 'how they proved it; needed to explain an audit entry');
