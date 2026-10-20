-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Tristan Grunert and contributors
DROP POLICY audit_backoffice_append ON audit_log;
DROP POLICY memberships_backoffice ON memberships;
DROP POLICY organizations_backoffice_create ON organizations;
DROP POLICY organizations_backoffice_read ON organizations;
