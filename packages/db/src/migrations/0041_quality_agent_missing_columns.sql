ALTER TABLE "agents" ADD COLUMN "quality_state" text NOT NULL DEFAULT 'warming-up';
ALTER TABLE "agents" ADD COLUMN "quality_badge" text NOT NULL DEFAULT 'warming-up';
ALTER TABLE "agents" ADD COLUMN "quality_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "agents" ADD COLUMN "quality_auto_assign" boolean NOT NULL DEFAULT true;
