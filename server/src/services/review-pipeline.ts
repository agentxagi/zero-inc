import { and, eq, inArray, ne, sql, desc } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agents, issueComments, issues } from "@zeroinc/db";
import { REVIEW_LANE_DEFAULT_SLA_HOURS, type ReviewLane } from "@zeroinc/shared";
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
  laneReviewerRoles: Partial<Record<ReviewLane, string[]>>;
  laneSlaHours: Partial<Record<ReviewLane, number>>;
}

const DEFAULT_REVIEW_LANE_REVIEWER_ROLES: Readonly<Record<ReviewLane, string[]>> = {
  code: ["qa", "code_reviewer", "reviewer", "cto"],
  security: ["security", "secops", "qa", "code_reviewer", "cto"],
  ux: ["designer", "ux", "qa", "pm"],
  ops: ["devops", "sre", "qa", "cto"],
};

export const DEFAULT_REVIEW_PIPELINE_CONFIG: Required<ReviewPipelineConfig> = {
  enabled: true,
  requireReview: true,
  autoAssignReviewer: true,
  maxReviewCycles: 3,
  reviewerRoles: ["qa", "code_reviewer"],
  laneReviewerRoles: {
    code: [...DEFAULT_REVIEW_LANE_REVIEWER_ROLES.code],
    security: [...DEFAULT_REVIEW_LANE_REVIEWER_ROLES.security],
    ux: [...DEFAULT_REVIEW_LANE_REVIEWER_ROLES.ux],
    ops: [...DEFAULT_REVIEW_LANE_REVIEWER_ROLES.ops],
  },
  laneSlaHours: {
    code: REVIEW_LANE_DEFAULT_SLA_HOURS.code,
    security: REVIEW_LANE_DEFAULT_SLA_HOURS.security,
    ux: REVIEW_LANE_DEFAULT_SLA_HOURS.ux,
    ops: REVIEW_LANE_DEFAULT_SLA_HOURS.ops,
  },
};

const REVIEW_REQUIRED_TITLE_PATTERNS = [
  /\[(bug|feature|code)\]/i,
  /^(bug|feature|code)\s*[:\-]/i,
];
const SECURITY_REVIEW_PATTERNS = [
  /\[security\]/i,
  /\[auth\]/i,
  /\bsecurity\b/i,
  /\bauth(entication|orization)?\b/i,
  /\bpermission(s)?\b/i,
  /\bjwt\b/i,
  /\btoken\b/i,
  /\boauth\b/i,
  /\bvuln(erability)?\b/i,
];
const UX_REVIEW_PATTERNS = [
  /\[ux\]/i,
  /\[ui\]/i,
  /\[design\]/i,
  /\bux\b/i,
  /\bui\b/i,
  /\bdesign\b/i,
  /\bonboarding\b/i,
  /\ba11y\b/i,
  /\baccessibility\b/i,
  /\bcopy\b/i,
];
const OPS_REVIEW_PATTERNS = [
  /\[ops\]/i,
  /\[infra\]/i,
  /\[sre\]/i,
  /\bops\b/i,
  /\binfra\b/i,
  /\bdeploy(ment)?\b/i,
  /\bdocker\b/i,
  /\bsystemd\b/i,
  /\bruntime\b/i,
  /\bwatchdog\b/i,
  /\bmonitor(ing)?\b/i,
  /\bsre\b/i,
];

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

function normalizeReviewText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function inferReviewLaneForIssue(issue: {
  title?: string | null;
  description?: string | null;
}): ReviewLane {
  const text = `${normalizeReviewText(issue.title)}\n${normalizeReviewText(issue.description)}`;
  if (SECURITY_REVIEW_PATTERNS.some((pattern) => pattern.test(text))) return "security";
  if (UX_REVIEW_PATTERNS.some((pattern) => pattern.test(text))) return "ux";
  if (OPS_REVIEW_PATTERNS.some((pattern) => pattern.test(text))) return "ops";
  return "code";
}

export function reviewSlaHoursForLane(
  lane: ReviewLane,
  laneSlaHours?: Partial<Record<ReviewLane, number>> | null,
): number {
  const configured = laneSlaHours?.[lane];
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.round(configured);
  }
  return REVIEW_LANE_DEFAULT_SLA_HOURS[lane];
}

export function reviewSlaDueAtForLane(
  lane: ReviewLane,
  reviewRequestedAt: Date | null | undefined,
  laneSlaHours?: Partial<Record<ReviewLane, number>> | null,
): Date | null {
  if (!reviewRequestedAt) return null;
  const hours = reviewSlaHoursForLane(lane, laneSlaHours);
  return new Date(reviewRequestedAt.getTime() + hours * 60 * 60 * 1000);
}

export function reviewSlaStateForDueAt(
  dueAt: Date | null | undefined,
  now: Date = new Date(),
): "overdue" | "due_soon" | "on_track" | "no_sla" {
  if (!dueAt) return "no_sla";
  const minutesRemaining = Math.floor((dueAt.getTime() - now.getTime()) / (60 * 1000));
  if (minutesRemaining < 0) return "overdue";
  if (minutesRemaining <= 120) return "due_soon";
  return "on_track";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function reviewPipelineService(db: Db, wakeupDeps?: ReviewPipelineWakeupDeps) {
  // --- Config resolution ---

  function resolveConfig(companyConfig?: Partial<ReviewPipelineConfig> | null): Required<ReviewPipelineConfig> {
    if (!companyConfig) return { ...DEFAULT_REVIEW_PIPELINE_CONFIG };
    const laneReviewerRoles: Record<ReviewLane, string[]> = {
      code: companyConfig.laneReviewerRoles?.code ?? [...DEFAULT_REVIEW_PIPELINE_CONFIG.laneReviewerRoles.code!],
      security:
        companyConfig.laneReviewerRoles?.security ?? [...DEFAULT_REVIEW_PIPELINE_CONFIG.laneReviewerRoles.security!],
      ux: companyConfig.laneReviewerRoles?.ux ?? [...DEFAULT_REVIEW_PIPELINE_CONFIG.laneReviewerRoles.ux!],
      ops: companyConfig.laneReviewerRoles?.ops ?? [...DEFAULT_REVIEW_PIPELINE_CONFIG.laneReviewerRoles.ops!],
    };
    const laneSlaHours: Record<ReviewLane, number> = {
      code: reviewSlaHoursForLane("code", companyConfig.laneSlaHours ?? null),
      security: reviewSlaHoursForLane("security", companyConfig.laneSlaHours ?? null),
      ux: reviewSlaHoursForLane("ux", companyConfig.laneSlaHours ?? null),
      ops: reviewSlaHoursForLane("ops", companyConfig.laneSlaHours ?? null),
    };
    return {
      enabled: companyConfig.enabled ?? DEFAULT_REVIEW_PIPELINE_CONFIG.enabled,
      requireReview: companyConfig.requireReview ?? DEFAULT_REVIEW_PIPELINE_CONFIG.requireReview,
      autoAssignReviewer: companyConfig.autoAssignReviewer ?? DEFAULT_REVIEW_PIPELINE_CONFIG.autoAssignReviewer,
      maxReviewCycles: companyConfig.maxReviewCycles ?? DEFAULT_REVIEW_PIPELINE_CONFIG.maxReviewCycles,
      reviewerRoles: companyConfig.reviewerRoles ?? DEFAULT_REVIEW_PIPELINE_CONFIG.reviewerRoles,
      laneReviewerRoles,
      laneSlaHours,
    };
  }

  // --- Auto-assign reviewer ---

  async function assignReviewer(
    issueId: string,
    config: Required<ReviewPipelineConfig>,
    laneHint?: ReviewLane,
  ): Promise<string | null> {
    const [issue] = await db
      .select({
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(eq(issues.id, issueId));

    if (!issue) return null;
    const lane = laneHint ?? inferReviewLaneForIssue({ title: issue.title, description: issue.description });
    const preferredRoles = config.laneReviewerRoles[lane] ?? config.reviewerRoles;

    // Find an available reviewer: prefer agent with a reviewer role, fallback to any available
    let reviewerAgentId: string | null = null;

    async function findByRoles(roles: string[]): Promise<string | null> {
      if (!Array.isArray(roles) || roles.length === 0) return null;
      const [matched] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, issue.companyId),
            ne(agents.status, "terminated"),
            ne(agents.status, "error"),
            ne(agents.id, issue.assigneeAgentId ?? ""),
            inArray(agents.role, roles),
            eq(agents.qualityAutoAssign, true),
          ),
        )
        .limit(1);
      return matched?.id ?? null;
    }

    reviewerAgentId = await findByRoles(preferredRoles);
    if (!reviewerAgentId && preferredRoles !== config.reviewerRoles) {
      reviewerAgentId = await findByRoles(config.reviewerRoles);
    }
    if (!reviewerAgentId) {
      reviewerAgentId = await findByRoles(DEFAULT_REVIEW_LANE_REVIEWER_ROLES.code);
    }

    if (reviewerAgentId) {
      // no-op
    } else {
      // Smart fallback: pick the most qualified available agent (by qualityScore)
      // Exclude the assignee, terminated/error agents, and agents with autoAssign disabled
      const [fallback] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, issue.companyId),
            ne(agents.status, "terminated"),
            ne(agents.status, "error"),
            ne(agents.id, issue.assigneeAgentId ?? ""),
            eq(agents.qualityAutoAssign, true),
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
        payload: { issueId, lane },
        contextSnapshot: { issueId, source: "review_pipeline", lane },
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
      .select({
        reviewVerdict: issues.reviewVerdict,
        originKind: issues.originKind,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);

    // Review gate only applies to BUG/FEATURE/CODE work. Routine and
    // operational tasks should complete without entering review queue.
    const title = typeof existing?.title === "string" ? existing.title.trim() : "";
    const reviewLane = inferReviewLaneForIssue({
      title: existing?.title,
      description: existing?.description,
    });
    const isRoutineExecution = existing?.originKind === "routine_execution";
    const isReviewCategory =
      title.length === 0
        ? true
        : REVIEW_REQUIRED_TITLE_PATTERNS.some((pattern) => pattern.test(title));
    if (isRoutineExecution || !isReviewCategory) {
      return false;
    }

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

    // Auto-assign reviewer first — if no reviewer is available, fall back to done
    let reviewerId: string | null = null;
    if (config.autoAssignReviewer) {
      reviewerId = await assignReviewer(issueId, config, reviewLane);
    }

    if (reviewerId) {
      // Reviewer assigned — set status to in_review
      await db
        .update(issues)
        .set({
          status: "in_review",
          reviewCount: sql`${issues.reviewCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));
      return true;
    }

    // No reviewer available — leave as done, post a warning comment
    await db
      .insert(issueComments)
      .values({
        companyId: (await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId)).limit(1))[0]?.companyId ?? "",
        issueId,
        body:
          "## Review Skipped\n\n" +
          `No available reviewer found for lane \`${reviewLane}\`. Task approved without review.`,
      });

    return false;
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
