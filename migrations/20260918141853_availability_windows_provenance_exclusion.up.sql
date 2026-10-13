-- `PUT .../participations/{id}/availability` (docs/04 §"Participation and
-- availability") is a coordinator's full replace of their own hand-entered
-- windows — scoped to `declared_by IS NOT NULL` rows, never touching a
-- submission-derived row, which is the volunteer's original answer and must
-- stay exactly as submitted (`crates/evp-db/src/submissions.rs`,
-- `PlanSubmissionsView.vue` read it verbatim).
--
-- The original exclusion constraint has no notion of that split: it refuses
-- ANY overlap for a participation regardless of provenance, so a coordinator
-- correcting "available all day" (submitted) to "unavailable in the
-- afternoon" (declared) — the exact scenario an override exists for — would
-- be rejected by a constraint that was only ever meant to catch an
-- unresolved contradiction *within one provenance*. Two declared windows (or
-- two submitted ones) still cannot overlap; a declared window overlapping a
-- submitted one is not a contradiction, it is the override, and which one
-- wins at a given instant is a read-time question for the API/roster layer,
-- not something this constraint should ever have decided.
--
-- Scoped with a plain boolean expression rather than a new stored column:
-- `declared_by IS NOT NULL` already partitions the two provenances (the
-- `availability_has_provenance` CHECK guarantees it is never both or
-- neither), so a materialised copy of that fact would be one more place for
-- the two to drift. `btree_gist` (migration `20260915100000`) supplies the
-- `=` operator class this needs for a boolean term in a GiST exclusion.
ALTER TABLE availability_windows
  DROP CONSTRAINT availability_windows_participation_id_period_excl;

ALTER TABLE availability_windows
  ADD CONSTRAINT availability_windows_participation_id_provenance_period_excl
  EXCLUDE USING gist (
    participation_id WITH =,
    (declared_by IS NOT NULL) WITH =,
    period WITH &&
  );
