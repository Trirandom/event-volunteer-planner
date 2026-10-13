-- One concern: an event gets a colour, so a festival's days can be told apart
-- wherever they are drawn together — the mission board, the day strip, and the
-- chips on a printed roster.
--
-- **An index, not a hex.** The palette is 64 colours chosen so that each one
-- clears 4.5:1 against both black and white (`packages/shared/src/eventColors.ts`,
-- gated by the test beside it), which is what lets the same value be a chip
-- background under text of either polarity *and* a text colour on either
-- ground. A `text` column holding `#rrggbb` would accept a colour that fails
-- that, from the API or from a hand-written UPDATE, and the guarantee would
-- last exactly as long as nobody tried. A smallint with a range CHECK cannot
-- hold an inaccessible colour, because it cannot hold a colour at all — the
-- palette resolves it, and the palette is proved.
--
-- The cost is that the list's order is now schema: entry 7 may be corrected,
-- never moved, and the module says so. Widening past 64 is a new migration
-- that widens this CHECK.
ALTER TABLE events ADD COLUMN color smallint;

-- Existing rows get spread across the palette rather than all landing on one
-- colour, which is the same thing a fresh event gets and for the same reason:
-- a festival whose six days are six shades of the same pink is a festival with
-- no colour coding. Per organisation, so two tenants' events do not have to
-- share a counter, and by `created_at` so the answer does not depend on the
-- order the rows happen to come back in.
--
-- **The backfill cannot see a single row without this.** `events` is
-- `FORCE ROW LEVEL SECURITY`, which is precisely the clause that stops the
-- owner being exempt, and `evp_migrator` is deliberately `NOSUPERUSER
-- NOBYPASSRLS` — so the tenant policy applies to this statement too, and its
-- `app.current_org_id` is unset here and always will be. A migrator session
-- belongs to no organisation. The UPDATE would therefore match nothing,
-- silently, and `SET NOT NULL` below is the only reason that failure is loud.
--
-- Lifting FORCE for the length of one transaction is the narrow fix: it
-- changes nothing for `evp_api`, which is not the owner and is subject to the
-- policy either way, and it is restored before this migration commits. Any
-- future migration that touches rows of a tenant table needs the same two
-- lines, for the same reason.
ALTER TABLE events NO FORCE ROW LEVEL SECURITY;

WITH spread AS (
  SELECT id,
         (row_number() OVER (PARTITION BY org_id ORDER BY created_at, id) - 1) % 64 AS color
    FROM events
)
UPDATE events SET color = spread.color FROM spread WHERE events.id = spread.id;

ALTER TABLE events FORCE ROW LEVEL SECURITY;

ALTER TABLE events
  ALTER COLUMN color SET NOT NULL,
  ADD CONSTRAINT events_color_in_palette CHECK (color >= 0 AND color < 64);

-- No DEFAULT: `insert_event` picks the lowest index the event's siblings are
-- not already using, which a column default cannot express and which is the
-- whole point — "the next colour" has to mean "one not in use here", not "the
-- same colour every event in this database starts with".
COMMENT ON COLUMN events.color IS
  'Index into the 64-colour event palette in packages/shared/src/eventColors.ts. Assigned on insert from the indices this event''s siblings are not using; changeable by hand.';
