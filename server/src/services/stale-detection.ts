import { eq, and, sql, lte, gt, isNull } from "drizzle-orm";
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

interface StaleAction {
  issueId: string;
  companyId: string;
  action: "warn" | "block" | "escalate" | "ping_reviewer" | "flag_qa" | "comment";
  reason: string;
  newStatus?: string;
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

      // Find CTO for this company
      const cto = await findCompanyCTO(issue.companyId);
      actions.push({
        issueId: issue.id,
        companyId: issue.companyId,
        action: "escalate",
        reason: `Blocked task has had no escalation for ${settings.staleBlockedEscalateMinutes} minutes. Escalating to CTO.${cto ? ` Reassigning to ${cto.name}.` : " No CTO agent found — commenting instead."}`,
        ...(cto ? { newStatus: "blocked" } : {}),
      });
    }

    // 4. Stale in_review > ping threshold → ping reviewer
    const reviewThreshold = new Date(now.getTime() - settings.staleInReviewPingMinutes * 60 * 1000);
    const reviewIssues = await findStaleIssues("in_review", reviewThreshold);
    for (const issue of reviewIssues) {
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

  async function findCompanyCTO(companyId: string): Promise<{ id: string; name: string } | null> {
    const result = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.role, "cto"),
          eq(agents.status, "active"),
        ),
      )
      .limit(1);
    return result[0] ?? null;
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
    }
  }

  return {
    detect,
    applyActions,
    run,
  };
}

export type StaleDetectionService = ReturnType<typeof staleDetectionService>;
