-- How the unauthenticated form route finds its organisation (docs/04
-- §"Public and unauthenticated", docs/12 §9 items 1 and 6).
--
-- `GET/POST /api/v1/public/forms/{slug}` arrive with no session and no org in
-- the URL, so there is nothing to set `app.current_org_id` from — and the row
-- that would say which organisation it is, `forms`, is itself behind the
-- tenant policy. Something has to widen exactly one read.
--
-- docs/03 §4 anticipates a `SECURITY DEFINER` resolver for capability URLs.
-- It does not work here as written, and would be the wrong shape if it did:
--
--   * `forms` is `FORCE ROW LEVEL SECURITY`, which binds its owner too. A
--     definer function owned by `evp_migrator` sees no rows with no org set,
--     so it would need a policy of its own anyway — and a policy granted to
--     `evp_migrator` would widen every migration and every `evp-db` test,
--     which run as that role.
--   * It moves the rule into a function body the next reader of these
--     policies will not think to open. Migration `…100600` rejected a definer
--     function for the same reason and kept its widening in a policy; this
--     follows that precedent.
--
-- The widening, and why it is safe:
--
--   * **SELECT only.** Permissive policies are ORed, so INSERT, UPDATE and
--     DELETE stay governed by `forms_tenant_isolation` alone.
--   * **One named slug.** The request must say which slug it means, through
--     `app.public_form_slug`, set with `set_config(…, true)` — `SET LOCAL` —
--     by `evp_db::public_forms::resolve` and by nothing else. Tenant requests
--     never set it, so for them this policy matches nothing; an unset or
--     empty variable matches nothing (the `NULLIF` from `…100700`).
--   * **Only what is already public.** A form is visible through it only
--     while it is live and `public_open` — precisely when `GET /f/{slug}`
--     serves it to anyone. Drafts, never-published and closed forms stay
--     invisible, which is what makes a closed form and an unknown slug the
--     same `404` (docs/09 §5). `forms_public_slug` (`…200000`) makes the match
--     at most one row deployment-wide.
--   * **`forms` only.** No other table gains a policy. Once the handler has
--     the row's `org_id` it sets `app.current_org_id` (again `SET LOCAL`) and
--     reads the version, its questions and the events under the ordinary
--     tenant policies, so everything past this one row is exactly as
--     isolated as any coordinator request.
--
-- The columns a matching row exposes beyond `org_id`/`id` are the form's own
-- configuration (name, scope ids, captcha choice, locale); `forms` holds no
-- personal data (its `retention_scope` row says so).
CREATE POLICY forms_public_slug_read ON forms FOR SELECT
  USING (
    slug = NULLIF(current_setting('app.public_form_slug', true), '')::citext
    AND live_version_id IS NOT NULL
    AND public_open
  );
