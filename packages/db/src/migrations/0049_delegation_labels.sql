-- Add match_labels column to delegation_rules
-- Allows rules to match on issue labels in addition to title patterns
-- Stored as JSONB array of label name strings

ALTER TABLE delegation_rules ADD COLUMN IF NOT EXISTS match_labels jsonb;
