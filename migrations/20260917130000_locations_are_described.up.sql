-- One concern: a mission gets the two things a coordinator has to tell a
-- volunteer before they can work it — what the job is, and where to stand.
--
-- Both lived in the Google Sheet this replaces, in the free-text column beside
-- each poste, and both are lost today: `locations` records a name, a colour and
-- a slot division, so "Bar" arrives at a volunteer as the word "Bar". The
-- briefing email, the printed roster and the volunteer's own schedule all need
-- more than that, and a coordinator currently keeps it somewhere else.
--
-- **Per event, not per festival**, like every other column on this table. A
-- mission's description is festival-wide in a coordinator's head and four rows
-- in the schema (ADR-0032), and that is deliberate: Open Air's bar is behind
-- the main stage and Dub & 2step's bar is in the club, so the one field the
-- days genuinely disagree about is this one. The admin app folds the rows back
-- into one mission and writes the same value to each (`plan/missionCatalog.ts`),
-- which is a UI affordance and stays one — the schema is not the place to
-- pretend four posts are one.
--
-- **`text`, unbounded, and no structure.** An address here is what somebody
-- would say out loud to a volunteer who is lost — "Halle 3, quai ouest, next to
-- the freight lift" — not a postal record. Splitting it into street/city/postal
-- code would be a form nobody can fill for a field in a warehouse, and
-- geocoding it is a decision for whenever a map exists, not for the column that
-- would have to be migrated first.
ALTER TABLE locations
  ADD COLUMN description text,
  ADD COLUMN address     text;

-- Blank is not a third state. A coordinator clearing the field means "there is
-- nothing to say here", which is `NULL`; an empty string would be a second way
-- to spell it, and every reader downstream would need to know both. The API
-- normalises before it writes and this refuses whatever gets past it.
ALTER TABLE locations
  ADD CONSTRAINT locations_description_not_blank
    CHECK (description IS NULL OR btrim(description) <> ''),
  ADD CONSTRAINT locations_address_not_blank
    CHECK (address IS NULL OR btrim(address) <> '');

COMMENT ON COLUMN locations.description IS
  'What the job is, in a coordinator''s words — briefing text for the volunteers assigned to it. NULL when nothing has been said.';
COMMENT ON COLUMN locations.address IS
  'Where to stand, as you would say it to someone who is lost. Free text, not a postal record; NULL when the mission name is location enough.';
