-- The wayfinding `address` added in 20260917130000 is deliberately prose for
-- someone already on site ("Halle 3, quai ouest, next to the freight lift").
-- That migration's own comment flagged what it was *not* doing: "geocoding it
-- is a decision for whenever a map exists". A map now exists — the briefing
-- email and a courier need a point a router or a search engine can resolve,
-- and a field with no street frontage only ever has one: GPS.
--
-- Two independent, both-optional columns rather than one: a venue usually has
-- a postal address a courier can type into any map; open ground during
-- build/strike often has neither a door number nor a name a stranger could
-- search for, only a pin someone dropped standing in it. Neither implies the
-- other, so a coordinator fills whichever the site actually has — sometimes
-- both, sometimes neither.
--
-- **Per event, not per festival, like `address` beside it** — the same site
-- can be entered from a different gate on different days.
--
-- **Zones only.** A post is a job inside a zone a volunteer is already
-- standing in ("the till" inside "Bar"); routing them to a point is the
-- zone's job, and a post that disagreed with its own zone's coordinates would
-- just be wrong. `locations_hierarchy` already enforces the zone/post split
-- structurally, so this reuses that shape instead of inventing another one.
ALTER TABLE locations
  ADD COLUMN exact_address text,
  ADD COLUMN latitude      double precision,
  ADD COLUMN longitude     double precision;

ALTER TABLE locations
  ADD CONSTRAINT locations_exact_address_not_blank
    CHECK (exact_address IS NULL OR btrim(exact_address) <> ''),
  ADD CONSTRAINT locations_latitude_in_range
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT locations_longitude_in_range
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  ADD CONSTRAINT locations_latitude_longitude_together
    CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT locations_posts_have_no_map_data
    CHECK (kind = 'zone' OR (exact_address IS NULL AND latitude IS NULL AND longitude IS NULL));

COMMENT ON COLUMN locations.exact_address IS
  'A postal address a map or a courier can resolve on its own — distinct from address, which is wayfinding prose for someone already on site. NULL when the site has none (open ground) or none has been entered yet. Zones only.';
COMMENT ON COLUMN locations.latitude IS
  'Decimal degrees, WGS 84. Set together with longitude, typically for a site with no postal address to give instead. Zones only.';
COMMENT ON COLUMN locations.longitude IS
  'Decimal degrees, WGS 84. Set together with latitude. Zones only.';
