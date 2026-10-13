-- Two things a volunteer has to know about a zone before ticking it in the
-- `missions` question (ADR-0036), and that only the coordinator can say.
--
-- **checked_by_default.** Most missions (bar, gate, cleaning) can be done by
-- anyone who turns up. For those the form ticks the box, and a volunteer
-- unticks whatever they would rather not do. A few (sound, rigging, first
-- aid) need a skill the coordinator cannot check from a form. For those a
-- pre-ticked box would turn "didn't read the list" into "can run the desk".
-- Those zones ask for an explicit tick. The default is `true` because that is
-- the common case, and an existing zone that nobody has reviewed should keep
-- behaving the way the form has offered missions so far.
--
-- **adults_only.** Some zones are no place for a minor (the bar, night
-- security). The form collects no birthdate, so this column refuses nobody.
-- It is information shown on the option, and such an option is never
-- pre-ticked, whatever `checked_by_default` says. A minor ticking it is a
-- choice they made in front of the label, not a default they missed.
--
-- **Zones only**, like the map data in `…093312`. A post is a job inside a
-- zone ("the till" inside "Bar"), and a post that is open to minors inside an
-- adults-only zone would just be wrong. Posts take their zone's values when
-- the missions are folded (`evp_db::forms::mission_rows`). The column on a
-- post holds the neutral value rather than NULL. That keeps both NOT NULL with
-- a plain DEFAULT, so every existing INSERT that names neither column still
-- writes a valid row.
ALTER TABLE locations
  ADD COLUMN checked_by_default boolean NOT NULL DEFAULT true,
  ADD COLUMN adults_only        boolean NOT NULL DEFAULT false;

ALTER TABLE locations
  ADD CONSTRAINT locations_posts_have_no_form_flags
    CHECK (kind = 'zone' OR (checked_by_default AND NOT adults_only));

COMMENT ON COLUMN locations.checked_by_default IS
  'Whether the volunteer form''s missions question offers this zone already ticked. false for a technical mission a volunteer must opt into. Zones only; a post holds true and takes its zone''s value.';
COMMENT ON COLUMN locations.adults_only IS
  'Whether this zone is for volunteers aged 18 or over. Shown on the form, never enforced there; such a mission is never pre-ticked. Zones only; a post holds false and takes its zone''s value.';
