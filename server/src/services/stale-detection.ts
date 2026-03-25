import { eq, and, sql, lte, gt, isNull, ne } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { issues, agents, issueComments } from "@zeroinc/db";
import { governanceSettingsService, DEFAULT_GOVERNANCE_SETTINGS, type GovernanceSettings } from "./governance-settings.js";
import { logger } from "../middleware/logger.js";

interface StaleIssue {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  startedAt: Date | null;
}

const HUMAN_BLOCKER_KEYWORDS = [
  "twitter_auth_token",
  "twitter_ct0",
  "auth token",
  "not_authenticated",
  "authentication",
  "credential",
  "cookie",
  "manual",
  "board user",
  "who can unblock",
  "needs human",
  "human action",
  "requires access",
  "api key",
];

interface StaleAction {
  issueId: string;
  companyId: string;
  action: "warn" | "block" | "escalate" | "ping_reviewer" | "flag_qa" | "comment" | "auto_approve_orphan";
  reason: string;
  newStatus?: string;
  escalateToAgentId?: string | null;
  escalateToUserId?: string | null;
}

export interface StaleDetectionWakeupDeps {
  wakeup: (agentId: string, opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    contextSnapshot?: Record<string, unknown>;
  }) => Promise<unknown>;
}

export function staleDetectionService(db: Db, wakeupDeps?: StaleDetectionWakeupDeps) {
  const gov = governanceSettingsService(db);
  const LOCAL_BOARD_USER_ID = "local-board";

  async function detect(): Promise<StaleAction[]> {
    const settings = await gov.get();
    const now = new Date();
    const actions: StaleAction[] = [];

    // 1. Stale in_progress > warn threshold → comment warning
    const warnThreshold = new Date(now.getTime() - settings.staleInProgressWarnMinutes * 60 * 1000);
    const warnIssues = await findStaleIssues("in_progress", warnThreshold);
    for (const issue of warnIssues) {
      // Only warn if not already blocked (i.e., hasn't hit the block threshold yet)
      const blockThreshold = new Date(now.getTime() - settings.staleInProgressBlockMinutes * 60 * 1000);
      if (issue.updatedAt < blockThreshold) continue; // will be handled by block rule

      const recentStaleComment = await hasRecentStaleComment(issue.id, "stale-warn");
      if (recentStaleComment) continue;

      actions.push({
        issueId: issue.id,
        companyId: issue.companyId,
        action: "warn",
        reason: `Task has been in_progress for ${settings.staleInProgressWarnMinutes} minutes without update.`,
      });
    }

    // 2. Stale in_progress > block threshold → mark blocked, ping assignee
    const blockThreshold = new Date(now.getTime() - settings.staleInProgressBlockMinutes * 60 * 1000);
    const blockIssues = await findStaleIssues("in_progress", blockThreshold);
    for (const issue of blockIssues) {
      actions.push({
        issueId: issue.id,
        companyId: issue.companyId,
        action: "block",
        reason: `Task has been in_progress for ${settings.staleInProgressBlockMinutes} minutes without update. Automatically blocked.`,
        newStatus: "blocked",
      });
    }

    // 3. Stale blocked > escalate threshold → auto-escalate to CTO
    const escalateThreshold = new Date(now.getTime() - settings.staleBlockedEscalateMinutes * 60 * 1000);
    const escalateIssues = await findStaleIssues("blocked", escalateThreshold);
    for (const issue of escalateIssues) {
      const recentStaleComment = await hasRecentStaleComment(issue.id, "stale-escalate");
      if (recentStaleComment) continue;

      const requiresHumanInput = await hasHumanBlockerSignal(issue.id);
      // Find CTO for this company
      const cto = await findCompanyCTO(issue.companyId);
      const ctoInvokable = cto ? isInvokableEscalationAgentStatus(cto.status) : false;
      const assignToBoard = requiresHumanInput || !ctoInvokable;
      actions.push({
        issueId: issue.id,
        companyId: issue.companyId,
        action: "escalate",
        reason: requiresHumanInput
          ? `Blocked task has had no escalation for ${settings.staleBlockedEscalateMinutes} minutes. Human input is required based on blocker context — assigning to board user ${LOCAL_BOARD_USER_ID}.`
          : ctoInvokable
          ? `Blocked task has had no escalation for ${settings.staleBlockedEscalateMinutes} minutes. Escalating to CTO. Reassigning to ${cto?.name}.`
          : `Blocked task has had no escalation for ${settings.staleBlockedEscalateMinutes} minutes. No invokable CTO available — assigning to board user ${LOCAL_BOARD_USER_ID}.`,
        ...(assignToBoard
          ? { escalateToAgentId: null, escalateToUserId: LOCAL_BOARD_USER_ID }
          : { escalateToAgentId: cto!.id, escalateToUserId: null }),
      });
    }

    // 4. Stale in_review > ping threshold → check reviewer eligibility, then ping or auto-approve
    const reviewThreshold = new Date(now.getTime() - settings.staleInReviewPingMinutes * 60 * 1000);
    const reviewIssues = await findStaleIssues("in_review", reviewThreshold);
    for (const issue of reviewIssues) {
      // Check if the assigned reviewer is eligible
      const reviewer = await findReviewerEligibility(issue.id);
      if (reviewer === "no_reviewer" || reviewer === "bad_reviewer") {
        // No reviewer or ineligible reviewer — auto-approve the task
        const recentStaleComment = await hasRecentStaleComment(issue.id, "stale-auto-approve");
        if (recentStaleComment) continue;

        actions.push({
          issueId: issue.id,
          companyId: issue.companyId,
          action: "auto_approve_orphan",
          reason: reviewer === "no_reviewer"
            ? `Task has been in_review for ${settings.staleInReviewPingMinutes} minutes with no reviewer assigned. Auto-approving.`
            : `Task has been in_review for ${settings.staleInReviewPingMinutes} minutes with an ineligible reviewer (terminated/error/autoAssign disabled). Auto-approving.`,
          newStatus: "done",
        });
        continue;
      }

      // Reviewer is eligible — just ping them
      const recentStaleComment = await hasRecentStaleComment(issue.id, "stale-review-ping");
      if (recentStaleComment) continue;

      actions.push({
        issueId: issue.id,
        companyId: issue.companyId,
        action: "ping_reviewer",
        reason: `Task has been in_review for ${settings.staleInReviewPingMinutes} minutes without reviewer action.`,
      });
    }

    // 5. Done with 0 quality points > threshold → flag for QA
    const qaThreshold = new Date(now.getTime() - settings.staleDoneNoQualityMinutes * 60 * 1000);
    const doneNoQualityIssues = await findDoneIssuesNoQuality(qaThreshold);
    for (const issue of doneNoQualityIssues) {
      const recentStaleComment = await hasRecentStaleComment(issue.id, "stale-qa-flag");
      if (recentStaleComment) continue;

      actions.push({
        issueId: issue.id,
        companyId: issue.companyId,
        action: "flag_qa",
        reason: `Task marked done for ${settings.staleDoneNoQualityMinutes} minutes without quality points. Flagging for QA review.`,
      });
    }

    return actions;
  }

  async function applyActions(actions: StaleAction[]): Promise<void> {
    for (const action of actions) {
      try {
        await applyAction(action);
      } catch (err) {
        logger.warn({ err, issueId: action.issueId, action: action.action }, "stale detection: failed to apply action");
      }
    }
  }

  async function run(): Promise<{ actions: StaleAction[] }> {
    const actions = await detect();
    if (actions.length > 0) {
      logger.info({ count: actions.length }, "stale detection: applying actions");
      await applyActions(actions);
    }
    return { actions };
  }

  // --- Internal helpers ---

  async function findStaleIssues(status: string, thresholdDate: Date): Promise<StaleIssue[]> {
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        updatedAt: issues.updatedAt,
        startedAt: issues.startedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.status, status),
          lte(issues.updatedAt, thresholdDate),
          isNull(issues.hiddenAt),
        ),
      )
      .limit(100);
  }

  async function findDoneIssuesNoQuality(thresholdDate: Date): Promise<StaleIssue[]> {
    // Find done issues completed before threshold where the assignee agent has 0 quality points
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        updatedAt: issues.updatedAt,
        startedAt: issues.startedAt,
      })
      .from(issues)
      .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .where(
        and(
          eq(issues.status, "done"),
          lte(issues.updatedAt, thresholdDate),
          isNull(issues.hiddenAt),
          sql`(${agents.qualityPoints} IS NULL OR jsonb_array_length(${agents.qualityPoints}) = 0)`,
        ),
      )
      .limit(100);
  }

  async function hasRecentStaleComment(issueId: string, tag: string): Promise<boolean> {
    // Check if there's a stale-detection comment in the last 60 minutes
    const threshold = new Date(Date.now() - 60 * 60 * 1000);
    const result = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          gt(issueComments.createdAt, threshold),
          sql`${issueComments.body} LIKE ${`%[stale:${tag}]%`}`,
        ),
      )
      .limit(1);
    return result.length > 0;
  }

  async function hasHumanBlockerSignal(issueId: string): Promise<boolean> {
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .limit(5);

    const haystack = rows
      .map((row) => (row.body ?? "").toLowerCase())
      .join("\n");
    return HUMAN_BLOCKER_KEYWORDS.some((keyword) => haystack.includes(keyword));
  }

  function isInvokableEscalationAgentStatus(status: string): boolean {
    return status === "idle" || status === "running";
  }

  async function findCompanyCTO(companyId: string): Promise<{ id: string; name: string; status: string } | null> {
    const result = await db
      .select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.role, "cto"),
          ne(agents.status, "terminated"),
          ne(agents.status, "pending_approval"),
        ),
      )
      .limit(1);
    return result[0] ?? null;
  }

  // Check if the assigned reviewer on an in_review task is eligible to review.
  // Returns "no_reviewer" if reviewerAgentId is null, "bad_reviewer" if the
  // reviewer is terminated/error/has autoAssign disabled, or "eligible".
  async function findReviewerEligibility(issueId: string): Promise<"no_reviewer" | "bad_reviewer" | "eligible"> {
    const [issue] = await db
      .select({ reviewerAgentId: issues.reviewerAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);

    if (!issue?.reviewerAgentId) return "no_reviewer";

    const [reviewer] = await db
      .select({ status: agents.status, qualityAutoAssign: agents.qualityAutoAssign })
      .from(agents)
      .where(eq(agents.id, issue.reviewerAgentId))
      .limit(1);

    if (!reviewer) return "bad_reviewer";
    if (reviewer.status === "terminated" || reviewer.status === "error") return "bad_reviewer";
    if (!reviewer.qualityAutoAssign) return "bad_reviewer";

    return "eligible";
  }

  async function applyAction(action: StaleAction): Promise<void> {
    const systemActor = { agentId: undefined, userId: undefined };

    switch (action.action) {
      case "warn": {
        await db.insert(issueComments).values({
          companyId: action.companyId,
          issueId: action.issueId,
          authorAgentId: null,
          authorUserId: null,
          body: `[stale:stale-warn] ${action.reason}\n\n_Auto-detected by stale detection._`,
        });
        await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, action.issueId));
        break;
      }
      case "block": {
        await db.insert(issueComments).values({
          companyId: action.companyId,
          issueId: action.issueId,
          authorAgentId: null,
          authorUserId: null,
          body: `[stale:block] ${action.reason}\n\n_Auto-detected by stale detection._`,
        });
        if (action.newStatus) {
          await db.update(issues).set({ status: action.newStatus, updatedAt: new Date() }).where(eq(issues.id, action.issueId));
        }
        break;
      }
      case "escalate": {
        await db.insert(issueComments).values({
          companyId: action.companyId,
          issueId: action.issueId,
          authorAgentId: null,
          authorUserId: null,
          body: `[stale:stale-escalate] ${action.reason}\n\n_Auto-detected by stale detection._`,
        });

        const [currentIssue] = await db
          .select({ assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId })
          .from(issues)
          .where(eq(issues.id, action.issueId))
          .limit(1);

        const patch: Partial<typeof issues.$inferInsert> = { updatedAt: new Date() };
        if (action.escalateToAgentId && currentIssue?.assigneeAgentId !== action.escalateToAgentId) {
          patch.assigneeAgentId = action.escalateToAgentId;
          patch.assigneeUserId = null;
        } else if (action.escalateToUserId && currentIssue?.assigneeUserId !== action.escalateToUserId) {
          patch.assigneeUserId = action.escalateToUserId;
          patch.assigneeAgentId = null;
        }

        await db.update(issues).set(patch).where(eq(issues.id, action.issueId));

        if (action.escalateToAgentId && wakeupDeps?.wakeup) {
          void wakeupDeps.wakeup(action.escalateToAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "stale_blocked_escalation",
            payload: { issueId: action.issueId },
            contextSnapshot: { issueId: action.issueId, source: "stale_detection" },
          }).catch(() => {});
        }
        break;
      }
      case "ping_reviewer": {
        await db.insert(issueComments).values({
          companyId: action.companyId,
          issueId: action.issueId,
          authorAgentId: null,
          authorUserId: null,
          body: `[stale:stale-review-ping] ${action.reason}\n\n_Auto-detected by stale detection._`,
        });
        await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, action.issueId));

        // Wake the reviewer agent so they actually process the review
        if (wakeupDeps?.wakeup) {
          const [issue] = await db
            .select({ reviewerAgentId: issues.reviewerAgentId })
            .from(issues)
            .where(eq(issues.id, action.issueId))
            .limit(1);
          if (issue?.reviewerAgentId) {
            void wakeupDeps.wakeup(issue.reviewerAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "stale_review_ping",
              payload: { issueId: action.issueId },
              contextSnapshot: { issueId: action.issueId, source: "stale_detection" },
            }).catch(() => {});
          }
        }
        break;
      }
      case "flag_qa": {
        await db.insert(issueComments).values({
          companyId: action.companyId,
          issueId: action.issueId,
          authorAgentId: null,
          authorUserId: null,
          body: `[stale:stale-qa-flag] ${action.reason}\n\n_Auto-detected by stale detection._`,
        });
        break;
      }
      case "auto_approve_orphan": {
        await db.insert(issueComments).values({
          companyId: action.companyId,
          issueId: action.issueId,
          authorAgentId: null,
          authorUserId: null,
          body: `[stale:stale-auto-approve] ${action.reason}\n\n_Auto-detected by stale detection._`,
        });
        if (action.newStatus) {
          await db.update(issues).set({
            status: action.newStatus,
            reviewVerdict: "approved",
            reviewerAgentId: null,
            completedAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(issues.id, action.issueId));
        }
        break;
      }
    }
  }

  return {
    detect,
    applyActions,
    run,
  };
}

export type StaleDetectionService = ReturnType<typeof staleDetectionService>;
