-- Server-side sessions. The cookie carries a random token and nothing else:
-- no claims, no user id, no signature to verify. Revocation is then a row
-- update rather than a key rotation that logs out every user at once
-- (docs/12, T5).
CREATE TABLE sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the cookie value, never the value. A database dump must not be
  -- enough to log in as anybody (docs/12, T8). SHA-256 rather than Argon2 is
  -- correct *here* and wrong for passwords: this input is >=32 CSPRNG bytes,
  -- so there is no dictionary to stretch against, and the hash is on the path
  -- of every authenticated request.
  token_hash      bytea NOT NULL UNIQUE,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  -- Idle expiry is derived from this at read time rather than stored as a
  -- deadline, so changing the idle window takes effect for existing sessions
  -- instead of only for new ones.
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  absolute_expiry timestamptz NOT NULL,
  revoked_at      timestamptz,
  user_agent      text,
  ip              inet
);

-- Partial: the lookup that matters is "this user's live sessions", for the
-- device list and for revoke-all. Revoked rows are kept for the audit trail
-- and deliberately excluded from the index rather than from the table.
CREATE INDEX ON sessions (user_id) WHERE revoked_at IS NULL;

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('sessions', 'ephemeral', 'live login state; expires by itself and is swept');
