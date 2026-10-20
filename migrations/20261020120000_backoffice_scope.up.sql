-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Tristan Grunert and contributors
--
-- The deployment operator's scope (ADR-0045): `app.backoffice = 'on'`, set with
-- `set_config(..., true)` by the one extractor that has checked
-- EVP_BACKOFFICE_KEY, and by nothing else.
--
-- Permissive policies, so each one *widens* exactly the commands it names and
-- nothing more. What it deliberately leaves out is the point of doing this in
-- the schema rather than with a BYPASSRLS role: volunteers, events, forms and
-- every other tenant table stay invisible to the backoffice, and a reviewer can
-- see that here instead of auditing every handler.
--
-- The predicate is an equality against a literal, not a cast: a GUC another
-- transaction left as '' on this pooled connection (see 20260915100700) must
-- read as closed, and '' = 'on' is false where ''::uuid would raise.

-- List and create. No UPDATE: renaming is the owner's, through the tenant
-- policy. No DELETE: it cascades through every event the tenant ever ran.
CREATE POLICY organizations_backoffice_read ON organizations FOR SELECT
  USING (current_setting('app.backoffice', true) = 'on');
CREATE POLICY organizations_backoffice_create ON organizations FOR INSERT
  WITH CHECK (current_setting('app.backoffice', true) = 'on');

-- Assign, change role, unassign: the whole reason the backoffice exists.
CREATE POLICY memberships_backoffice ON memberships
  USING      (current_setting('app.backoffice', true) = 'on')
  WITH CHECK (current_setting('app.backoffice', true) = 'on');

-- Append only, like every other writer: the backoffice records what it did
-- against the organisation it did it to, and cannot read the log back.
CREATE POLICY audit_backoffice_append ON audit_log FOR INSERT
  WITH CHECK (current_setting('app.backoffice', true) = 'on');
