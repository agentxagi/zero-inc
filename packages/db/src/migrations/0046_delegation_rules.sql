CREATE TABLE "delegation_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" text NOT NULL,
  "description" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "rule_type" text NOT NULL,
  "trigger_on" text NOT NULL DEFAULT 'create',
  "title_pattern" text,
  "match_priority" text,
  "match_status" text,
  "assign_to_agent_id" uuid,
  "assign_to_user_id" text,
  "set_priority" text,
  "set_status" text,
  "comment_body" text,
  "delay_minutes" integer,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "delegation_rules_company_idx" ON "delegation_rules" ("company_id");
CREATE INDEX "delegation_rules_company_enabled_idx" ON "delegation_rules" ("company_id", "enabled");
