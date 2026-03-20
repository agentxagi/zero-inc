ALTER TABLE "agents" ADD COLUMN "total_completed" integer DEFAULT 0 NOT NULL;
ALTER TABLE "agents" ADD COLUMN "total_reopened" integer DEFAULT 0 NOT NULL;
ALTER TABLE "agents" ADD COLUMN "total_blocked" integer DEFAULT 0 NOT NULL;
ALTER TABLE "agents" ADD COLUMN "quality_score" integer DEFAULT 100 NOT NULL;
ALTER TABLE "agents" ADD COLUMN "quality_streak" integer DEFAULT 0 NOT NULL;
ALTER TABLE "agents" ADD COLUMN "last_reopen_reasons" jsonb DEFAULT '[]' NOT NULL;
