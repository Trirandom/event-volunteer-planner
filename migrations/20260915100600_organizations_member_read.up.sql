-- The read side of "which organisations may I choose?".
--
-- 20260915100400 gave `memberships` a self-read policy so that
-- `GET /api/v1/auth/me` can answer before an organisation has been chosen.
-- That is only half of it: the answer has to carry each organisation's name and
-- slug, and `organizations` is policed by app.current_org_id, which at that
-- moment is deliberately unset. The join would return nothing, and "no
-- memberships" and "not yet scoped to an org" would be indistinguishable.
--
-- The obvious fix is a SECURITY DEFINER function, and it is the wrong one: it
-- moves the rule out of the schema and into a function body that the next
-- reader of these policies will not think to look at. This keeps it here and
-- says exactly the same thing — a member may read the organisations they are a
-- member of.
--
-- The subquery is itself subject to RLS, and that is what makes it safe rather
-- than a hole: it can only see the rows `memberships_self_read` permits, which
-- are this user's own. A caller cannot use it to confirm somebody else's
-- membership.
--
-- FOR SELECT only. PostgreSQL ORs permissive policies, so this widens reads and
-- leaves INSERT, UPDATE and DELETE governed solely by the tenant policy: a
-- member may see their organisation without being able to write to it outside a
-- properly scoped request.
CREATE POLICY organizations_member_read ON organizations FOR SELECT
  USING (EXISTS (
    SELECT 1
      FROM memberships m
     WHERE m.org_id  = organizations.id
       AND m.user_id = current_setting('app.current_user_id', true)::uuid
  ));
