-- One concern: `events.period` becomes the *operational* window, and the
-- public window it used to be gets a column of its own.
--
-- Until now the two were the same thing, and that is what made the mission
-- board refuse to grow a bar past the end of the day: every bar is born
-- spanning its whole event, a shift may not fall outside its event (one of the
-- six hard rules, docs/02 §5), so the outward drag had nowhere to go. But a
-- coordinator pulling a bar past closing time is not making a mistake — they
-- are saying the bar staff start before the doors open and the technique crew
-- leave after they close. The operational window is genuinely wider than the
-- public one, and the schema said it was not.
--
-- So the board may now widen `period`, and when it does, whatever the period
-- was at that moment is kept as `public_period`: the hours the event is open
-- to the public, which is what the doors, the programme and the volunteer form
-- all mean by "the event". NULL means the two are still the same — nothing has
-- pushed past the published times yet — rather than "unknown", so no backfill
-- is needed and no existing row changes meaning.
ALTER TABLE events ADD COLUMN public_period tstzrange;

-- Same shape as `events_period_valid`, plus containment: the public window is
-- a *part of* the operational one. Expressible as a CHECK because both bounds
-- live on this row, unlike the shift-inside-event rule next door, which has to
-- be a constraint trigger because its bound is on another table.
--
-- The containment half also stops the other direction quietly: a period
-- shrunk back inside the published times is refused here, in the same breath
-- as `events_period_covers_shifts` refuses one shrunk away from its shifts.
ALTER TABLE events ADD CONSTRAINT events_public_period_valid CHECK (
  public_period IS NULL OR (
    NOT isempty(public_period)
    AND lower(public_period) IS NOT NULL
    AND upper(public_period) IS NOT NULL
    AND public_period <@ period
  )
);

COMMENT ON COLUMN events.public_period IS
  'When the event is open to the public. NULL while it is still the whole of `period`; set to the period as it was the first time the operational window grew past it.';
