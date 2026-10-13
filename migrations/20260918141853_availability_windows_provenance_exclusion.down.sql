ALTER TABLE availability_windows
  DROP CONSTRAINT availability_windows_participation_id_provenance_period_excl;

ALTER TABLE availability_windows
  ADD CONSTRAINT availability_windows_participation_id_period_excl
  EXCLUDE USING gist (participation_id WITH =, period WITH &&);
