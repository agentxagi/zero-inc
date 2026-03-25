import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { issueComments, issues } from "@zeroinc/db";
import { governanceSettingsService } from "./governance-settings.js";
import { logger } from "../middleware/logger.js";

interface StaleIssue {
  id: string;
  companyId: string;
}

interface StaleAction {
  issueId: string;
  companyId: string;
  action: "warn";
  reason: string;
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

const IN_PROGRESS_STALE_THRESHOLD_MINUTES = 360;
const STALE_TAG = "stale-in-progress";

export function staleDetectionService(db: Db, _wakeupDeps?: StaleDetectionWakeupDeps) {
  const governance = governanceSettingsService(db);

  async function detect(): Promise<StaleAction[]> {
    // Ensure governance row exists (shared bootstrap behavior).
    await governance.get();

    const thresholdDate = new Date(Date.now() - IN_PROGRESS_STALE_THRESHOLD_MINUTES * 60 * 1000);
    const staleIssues = await findStaleInProgressIssues(thresholdDate);
    const actions: StaleAction[] = [];

    for (const issue of staleIssues) {
      const hasRecentComment = await hasRecentStaleComment(issue.id, STALE_TAG);
      if (hasRecentComment) continue;
      actions.push({
        issueId: issue.id,
        companyId: issue.companyId,
        action: "warn",
        reason:
          `Task has been in_progress for more than ${IN_PROGRESS_STALE_THRESHOLD_MINUTES / 60} hours without update. ` +
          "No automatic status change applied.",
      });
    }

    return actions;
  }

  async function applyActions(actions: StaleAction[]): Promise<void> {
    for (const action of actions) {
      try {
        await applyAction(action);
      } catch (err) {
        logger.warn(
          { err, issueId: action.issueId, action: action.action },
          "stale detection: failed to apply action",
        );
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

  async function findStaleInProgressIssues(thresholdDate: Date): Promise<StaleIssue[]> {
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.status, "in_progress"),
          lte(issues.updatedAt, thresholdDate),
          isNull(issues.hiddenAt),
        ),
      )
      .limit(100);
  }

  async function hasRecentStaleComment(issueId: string, tag: string): Promise<boolean> {
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

  async function applyAction(action: StaleAction): Promise<void> {
    await db.insert(issueComments).values({
      companyId: action.companyId,
      issueId: action.issueId,
      authorAgentId: null,
      authorUserId: null,
      body: `[stale:${STALE_TAG}] ${action.reason}\n\n_Auto-detected by stale detection._`,
    });
  }

  return {
    detect,
    applyActions,
    run,
  };
}

export type StaleDetectionService = ReturnType<typeof staleDetectionService>;

