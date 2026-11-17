-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Loses which post each volunteer held. They stay on the zone's shift.
DROP TRIGGER shifts_keep_post_holders_in_zone_check ON shifts;
DROP FUNCTION shifts_keep_post_holders_in_zone();
DROP TRIGGER assignments_post_in_zone_check ON assignments;
DROP FUNCTION assignments_post_in_zone();
ALTER TABLE assignments DROP COLUMN post_id;
