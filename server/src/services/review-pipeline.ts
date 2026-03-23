import { and, eq, inArray, ne, sql, desc } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agents, issueComments, issues } from "@zeroinc/db";
import type { QualityGateResult } from "./quality-gate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewVerdict = "approved" | "changes_requested";

export interface ReviewFinding {
  severity: "blocker" | "suggestion" | "nit";
  file?: string;
  line?: number;
  message: string;
}

export interface SubmitReviewInput {
  verdict: ReviewVerdict;
  summary?: string;
  findings?: ReviewFinding[];
  questions?: string[];
}

export interface ReviewPipelineConfig {
  enabled: boolean;
  requireReview: boolean;
  autoAssignReviewer: boolean;
  maxReviewCycles: number;
  reviewerRoles: string[];
}

export const DEFAULT_REVIEW_PIPELINE_CONFIG: Required<ReviewPipelineConfig> = {
  enabled: true,
  requireReview: true,
  autoAssignReviewer: true,
  maxReviewCycles: 3,
  reviewerRoles: ["qa", "code_reviewer"],
};

// Wakeup dependency - injected to enable immediate agent notification
export interface ReviewPipelineWakeupDeps {
  wakeup: (agentId: string, opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    contextSnapshot?: Record<string, unknown>;
  }) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function reviewPipelineService(db: Db, wakeupDeps?: ReviewPipelineWakeupDeps) {
  // --- Config resolution ---

  function resolveConfig(companyConfig?: Partial<ReviewPipelineConfig> | null): Required<ReviewPipelineConfig> {
    if (!companyConfig) return { ...DEFAULT_REVIEW_PIPELINE_CONFIG };
    return {
      enabled: companyConfig.enabled ?? DEFAULT_REVIEW_PIPELINE_CONFIG.enabled,
      requireReview: companyConfig.requireReview ?? DEFAULT_REVIEW_PIPELINE_CONFIG.requireReview,
      autoAssignReviewer: companyConfig.autoAssignReviewer ?? DEFAULT_REVIEW_PIPELINE_CONFIG.autoAssignReviewer,
      maxReviewCycles: companyConfig.maxReviewCycles ?? DEFAULT_REVIEW_PIPELINE_CONFIG.maxReviewCycles,
      reviewerRoles: companyConfig.reviewerRoles ?? DEFAULT_REVIEW_PIPELINE_CONFIG.reviewerRoles,
    };
  }

  // --- Auto-assign reviewer ---

  async function assignReviewer(issueId: string, config: Required<ReviewPipelineConfig>): Promise<string | null> {
    const [issue] = await db
      .select({
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));

    if (!issue) return null;

    // Find an available reviewer: prefer agent with a reviewer role, fallback to any available
    let reviewerAgentId: string | null = null;

    const [matched] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, issue.companyId),
          ne(agents.status, "terminated"),
          ne(agents.status, "error"),
          ne(agents.id, issue.assigneeAgentId ?? ""),
          inArray(agents.role, config.reviewerRoles),
        ),
      )
      .limit(1);

    if (matched) {
      reviewerAgentId = matched.id;
    } else {
      // Smart fallback: pick the most qualified available agent (by qualityScore)
      // Exclude the assignee and terminated/error agents
      const [fallback] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, issue.companyId),
            ne(agents.status, "terminated"),
            ne(agents.status, "error"),
            ne(agents.id, issue.assigneeAgentId ?? ""),
          ),
        )
        .orderBy(desc(agents.qualityScore))
        .limit(1);
      reviewerAgentId = fallback?.id ?? null;
    }

    if (!reviewerAgentId) return null;

    await db
      .update(issues)
      .set({
        reviewerAgentId: reviewerAgentId,
        originalAssigneeId: issue.assigneeAgentId,
        reviewRequestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    // Wake the reviewer immediately so they don't wait for timer
    if (wakeupDeps?.wakeup) {
      void wakeupDeps.wakeup(reviewerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "review_assigned",
        payload: { issueId },
        contextSnapshot: { issueId, source: "review_pipeline" },
      }).catch(() => {
        // Ignore wakeup errors — reviewer will still be notified by timer
      });
    }

    return reviewerAgentId;
  }

  // --- Transition to in_review after quality gate passes ---

  async function transitionToReview(
    issueId: string,
    engineerAgentId: string,
    qualityResult: QualityGateResult,
    config: Required<ReviewPipelineConfig>,
  ): Promise<boolean> {
    if (!config.enabled || !config.requireReview) {
      // Review pipeline disabled — let the issue stay as done
      return false;
    }

    // Recovery: if the issue already has an approved review verdict, skip re-review
    // and ensure it's in done status (handles stuck tasks from prior non-atomic updates)
    const [existing] = await db
      .select({ reviewVerdict: issues.reviewVerdict })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);

    if (existing?.reviewVerdict === "approved") {
      await db
        .update(issues)
        .set({
          status: "done",
          completedAt: new Date(),
          reviewerAgentId: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));
      return false;
    }

    // Set status to in_review instead of done
    await db
      .update(issues)
      .set({
        status: "in_review",
        reviewCount: sql`${issues.reviewCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    // Auto-assign reviewer
    if (config.autoAssignReviewer) {
      await assignReviewer(issueId, config);
    }

    return true;
  }

  // --- Submit review verdict ---

  async function submitReview(
    issueId: string,
    reviewerAgentId: string,
    input: SubmitReviewInput,
    config: Required<ReviewPipelineConfig>,
  ): Promise<{ success: boolean; escalated?: boolean; reason?: string }> {
    const [issue] = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        originalAssigneeId: issues.originalAssigneeId,
        reviewCount: issues.reviewCount,
        companyId: issues.companyId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));

    if (!issue) return { success: false, reason: "Issue not found" };
    if (issue.status !== "in_review") return { success: false, reason: "Issue is not in review" };
    if (issue.assigneeAgentId === reviewerAgentId) {
      return { success: false, reason: "Agent cannot review their own work" };
    }

    const reviewCount = issue.reviewCount ?? 0;

    // Post review comment
    const commentBody = buildReviewComment(input);
    await db
      .insert(issueComments)
      .values({
        companyId: issue.companyId,
        issueId,
        authorAgentId: reviewerAgentId,
        body: commentBody,
      });

    // Update reviewer stats
    await db
      .update(agents)
      .set({
        totalReviewed: sql`${agents.totalReviewed} + 1`,
        totalReviewApproved: input.verdict === "approved"
          ? sql`${agents.totalReviewApproved} + 1`
          : agents.totalReviewApproved,
        totalReviewRejected: input.verdict === "changes_requested"
          ? sql`${agents.totalReviewRejected} + 1`
          : agents.totalReviewRejected,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, reviewerAgentId));

    // Atomically set review verdict AND status in a single transaction
    // to prevent the task from getting stuck with an approved verdict but in_review status
    await db.transaction(async (tx) => {
      if (input.verdict === "approved") {
        await tx
          .update(issues)
          .set({
            status: "done",
            completedAt: new Date(),
            reviewCompletedAt: new Date(),
            reviewVerdict: "approved",
            reviewerAgentId: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
      } else {
        await tx
          .update(issues)
          .set({
            reviewCompletedAt: new Date(),
            reviewVerdict: input.verdict,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
      }
    });

    if (input.verdict === "approved") {
      return { success: true };
    }

    // Changes requested — check max cycles
    if (reviewCount >= config.maxReviewCycles) {
      // Escalate: set back to in_progress with escalation comment
      const originalAssigneeId = issue.originalAssigneeId ?? issue.assigneeAgentId;
      await db
        .update(issues)
        .set({
          status: "in_progress",
          assigneeAgentId: originalAssigneeId,
          reviewerAgentId: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      await db
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId,
          body: `## Review Escalated\n\nThis issue has exceeded ${config.maxReviewCycles} review cycles and has been escalated for human review.`,
        });

      return { success: true, escalated: true };
    }

    // Reassign to original engineer
    const originalAssigneeId = issue.originalAssigneeId ?? issue.assigneeAgentId;
    await db
      .update(issues)
      .set({
        status: "in_progress",
        assigneeAgentId: originalAssigneeId,
        reviewerAgentId: null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    // Wake up original engineer so they know to address changes
    if (wakeupDeps?.wakeup && originalAssigneeId) {
      void wakeupDeps.wakeup(originalAssigneeId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "review_changes_requested",
        payload: { issueId },
        contextSnapshot: { issueId, source: "review_pipeline" },
      }).catch(() => {
        // Ignore wakeup errors — engineer will still be notified by timer
      });
    }

    return { success: true };
  }

  // --- Helpers ---

  function buildReviewComment(input: SubmitReviewInput): string {
    const lines: string[] = [];
    lines.push(`## Code Review — ${input.verdict === "approved" ? "Approved" : "Changes Requested"}`);
    if (input.summary) {
      lines.push("");
      lines.push(input.summary);
    }
    if (input.findings && input.findings.length > 0) {
      lines.push("");
      lines.push("### Findings");
      for (const f of input.findings) {
        const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "";
        lines.push(`- **[${f.severity}]** ${loc ? `${loc} — ` : ""}${f.message}`);
      }
    }
    if (input.questions && input.questions.length > 0) {
      lines.push("");
      lines.push("### Questions");
      for (const q of input.questions) {
        lines.push(`- ${q}`);
      }
    }
    return lines.join("\n");
  }

  return {
    resolveConfig,
    assignReviewer,
    transitionToReview,
    submitReview,
  };
}

export type ReviewPipelineService = ReturnType<typeof reviewPipelineService>;
