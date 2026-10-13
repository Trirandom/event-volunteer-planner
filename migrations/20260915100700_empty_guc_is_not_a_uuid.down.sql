-- Restores the raw casts. Reversible, and deliberately written out so that the
-- author of the next policy can see what the broken form looked like.
ALTER POLICY organizations_tenant_isolation ON organizations
  USING      (id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_org_id', true)::uuid);

ALTER POLICY memberships_tenant_isolation ON memberships
  USING      (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER POLICY memberships_self_read ON memberships
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

ALTER POLICY organizations_member_read ON organizations
  USING (EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.org_id = organizations.id
       AND m.user_id = current_setting('app.current_user_id', true)::uuid
  ));
