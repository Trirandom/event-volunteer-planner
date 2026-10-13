ALTER TABLE locations
  DROP CONSTRAINT locations_posts_have_no_map_data,
  DROP CONSTRAINT locations_latitude_longitude_together,
  DROP CONSTRAINT locations_longitude_in_range,
  DROP CONSTRAINT locations_latitude_in_range,
  DROP CONSTRAINT locations_exact_address_not_blank;

ALTER TABLE locations
  DROP COLUMN longitude,
  DROP COLUMN latitude,
  DROP COLUMN exact_address;
