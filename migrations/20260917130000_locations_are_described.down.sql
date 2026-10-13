ALTER TABLE locations
  DROP CONSTRAINT locations_address_not_blank,
  DROP CONSTRAINT locations_description_not_blank;

ALTER TABLE locations
  DROP COLUMN address,
  DROP COLUMN description;
