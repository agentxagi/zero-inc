ALTER TABLE "issues" ADD COLUMN "reviewer_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "original_assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "review_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "review_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "review_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "review_verdict" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "total_reviewed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "total_review_approved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "total_review_rejected" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
