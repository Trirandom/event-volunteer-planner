-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Lifts the rule only. The fold is not undone: which zone shift a merged post
-- shift used to be is not recorded, and the placements it carried are on the
-- zone's shift with their post, which is a reading the old schema also held.
DROP TRIGGER shifts_on_zones_check ON shifts;
DROP FUNCTION shifts_on_zones();
