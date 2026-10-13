-- Every policy predicate must survive an *empty* session variable, not just a
-- missing one.
--
-- `current_setting('app.current_org_id', true)` returns NULL only while the
-- variable has never been set on that backend. Once `set_config(..., true)` has
-- run inside any transaction, the variable continues to exist for the life of
-- the connection and reverts to the **empty string** at commit — not to unset.
-- `''::uuid` is not NULL; it is SQLSTATE 22P02, `invalid input syntax for type
-- uuid`.
--
-- With a connection pool that is not a rare case, it is the normal one. A
-- request that scopes itself to an organisation leaves `app.current_org_id`
-- empty on that pooled connection, and the next request to borrow it — a
-- login, which deliberately sets only `app.current_user_id` — fails with a 500
-- inside a policy it never mentioned. Which request breaks depends on which
-- connection it draws, so it presents as an intermittent fault in an unrelated
-- endpoint.
--
-- NULLIF restores the intended reading: unset and empty both mean "no scope",
-- and a policy with no scope matches nothing rather than raising.
ALTER POLICY organizations_tenant_isolation ON organizations
  USING      (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER POLICY memberships_tenant_isolation ON memberships
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER POLICY memberships_self_read ON memberships
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY organizations_member_read ON organizations
  USING (EXISTS (
    SELECT 1
      FROM memberships m
     WHERE m.org_id  = organizations.id
       AND m.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  ));
