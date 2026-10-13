COMMENT ON COLUMN events.public_period IS
  'When the event is open to the public. NULL while it is still the whole of `period`; set to the period as it was the first time the operational window grew past it.';
