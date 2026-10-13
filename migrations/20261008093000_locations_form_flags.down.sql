ALTER TABLE locations
  DROP CONSTRAINT locations_posts_have_no_form_flags;

ALTER TABLE locations
  DROP COLUMN adults_only,
  DROP COLUMN checked_by_default;
