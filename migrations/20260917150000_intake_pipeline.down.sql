DELETE FROM retention_scope WHERE table_name IN (
  'intake_sources'::regclass,
  'submission_batches'::regclass,
  'submissions'::regclass,
  'submission_payloads'::regclass
);
DROP TABLE submission_payloads;
DROP TABLE submissions;
DROP TABLE submission_batches;
DROP TABLE intake_sources;
DROP TYPE match_kind;
DROP TYPE submission_state;
DROP TYPE intake_source_kind;
