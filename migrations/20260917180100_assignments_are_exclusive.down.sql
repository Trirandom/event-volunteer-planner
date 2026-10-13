DROP TRIGGER IF EXISTS participations_withdrawal_check ON participations;
DROP FUNCTION IF EXISTS participations_withdrawal_is_clean();
DROP TRIGGER IF EXISTS assignments_participant_assignable_check ON assignments;
DROP FUNCTION IF EXISTS assignments_participant_assignable();
DROP TRIGGER IF EXISTS shifts_period_propagate ON shifts;
DROP FUNCTION IF EXISTS shifts_propagate_period();
DROP INDEX IF EXISTS assignments_one_per_shift;
ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_no_double_booking;
