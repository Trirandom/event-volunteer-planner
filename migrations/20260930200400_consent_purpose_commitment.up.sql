-- A third consent purpose, 'commitment' (ADR-0040): the volunteer confirms they
-- take part unpaid, on the organisation's behalf, within the missions they are
-- given. Required and exactly one per published version, like 'processing';
-- both are conditions on a set of rows, so both are checked at publish, and
-- `form_one_consent_per_purpose` already caps it at one per version.
--
-- `ADD VALUE` runs inside the migration's transaction (PostgreSQL 12+); the
-- new value is only unusable until that transaction commits, and nothing here
-- uses it.
ALTER TYPE consent_purpose ADD VALUE 'commitment';
