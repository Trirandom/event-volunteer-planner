ALTER TABLE locations
  DROP CONSTRAINT locations_volunteer_bounds_ordered;

-- The two unnamed column checks go with their columns.
ALTER TABLE locations
  DROP COLUMN max_volunteers,
  DROP COLUMN min_volunteers;
