-- Add audit flag columns to issues table
-- Used by the task audit system to mark questionable completions

ALTER TABLE issues ADD COLUMN IF NOT EXISTS audit_flagged boolean NOT NULL DEFAULT false;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS audit_flagged_at timestamp with time zone;
