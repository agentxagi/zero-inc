ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "blocked_by_human" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "human_action_type" text,
  ADD COLUMN IF NOT EXISTS "human_resolution_hint" text,
  ADD COLUMN IF NOT EXISTS "human_blocked_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "human_sla_due_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "human_resolved_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "human_resolution_evidence" text,
  ADD COLUMN IF NOT EXISTS "human_resolution_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "human_resolution_by_agent_id" uuid REFERENCES "agents"("id");

CREATE INDEX IF NOT EXISTS "issues_company_human_queue_idx"
  ON "issues" ("company_id", "blocked_by_human", "status", "human_sla_due_at");
