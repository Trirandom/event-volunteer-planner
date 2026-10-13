DELETE FROM retention_scope WHERE table_name IN ('shift_patterns'::regclass, 'shift_pattern_segments'::regclass);
DROP TABLE IF EXISTS shift_pattern_segments;
DROP TABLE IF EXISTS shift_patterns;
DROP FUNCTION IF EXISTS shift_pattern_is_well_formed();
DROP TYPE IF EXISTS pattern_segment_kind;
DROP TYPE IF EXISTS pattern_repeat;
