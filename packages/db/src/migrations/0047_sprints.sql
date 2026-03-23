-- Sprint model for ZeroInc governance framework (Phase 5)
-- Adds sprints table and sprint_id to issues for sprint-linked tracking

CREATE TABLE IF NOT EXISTS sprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  description TEXT,
  goal TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  start_date DATE,
  end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sprints_company_idx ON sprints(company_id);
CREATE INDEX IF NOT EXISTS sprints_company_status_idx ON sprints(company_id, status);

-- Add sprint_id to issues table for linking issues to sprints
ALTER TABLE issues ADD COLUMN IF NOT EXISTS sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS issues_company_sprint_idx ON issues(company_id, sprint_id);
