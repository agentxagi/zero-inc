import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { DEFAULT_QUALITY_GATE_CONFIG, type QualityGateConfig } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityCheckResult {
  pass: boolean;
  message: string;
  severity: "blocker" | "warning" | "info";
}

export interface QualityGateResult {
  passed: boolean;
  checks: QualityCheckResult[];
}

interface IssueContext {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  executionLockedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function qualityGateService(db: Db) {
  // --- Config resolution ---

  function resolveConfig(companyConfig?: Partial<QualityGateConfig> | null): Required<QualityGateConfig> {
    if (!companyConfig) return { ...DEFAULT_QUALITY_GATE_CONFIG };
    return {
      enabled: companyConfig.enabled ?? DEFAULT_QUALITY_GATE_CONFIG.enabled,
      requireComment: companyConfig.requireComment ?? DEFAULT_QUALITY_GATE_CONFIG.requireComment,
      requireMinimumDuration:
        companyConfig.requireMinimumDuration ?? DEFAULT_QUALITY_GATE_CONFIG.requireMinimumDuration,
      autoReopen: companyConfig.autoReopen ?? DEFAULT_QUALITY_GATE_CONFIG.autoReopen,
    };
  }

  // --- Individual checks ---

  async function checkCommentRequired(issue: IssueContext): Promise<QualityCheckResult> {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));

    const count = Number(row?.count ?? 0);
    if (count === 0) {
      return {
        pass: false,
        message: "No completion comment found. Agent must describe what was done before marking the task as done.",
        severity: "blocker",
      };
    }
    return { pass: true, message: `Completion comment present (${count} comment${count > 1 ? "s" : ""} on issue).`, severity: "info" };
  }

  async function checkDurationSanity(
    issue: IssueContext,
    minimumDurationSeconds: number,
  ): Promise<QualityCheckResult> {
    if (!issue.startedAt) {
      return {
        pass: true,
        message: "No startedAt timestamp — duration check skipped.",
        severity: "info",
      };
    }

    const now = issue.completedAt ?? new Date();
    const durationMs = now.getTime() - issue.startedAt.getTime();
    const durationSec = durationMs / 1000;

    if (durationSec < minimumDurationSeconds) {
      return {
        pass: false,
        message: `Task completed in ${durationSec.toFixed(1)}s (minimum ${minimumDurationSeconds}s). Likely an error or no-op.`,
        severity: "blocker",
      };
    }
    return {
      pass: true,
      message: `Duration check passed (${durationSec.toFixed(1)}s >= ${minimumDurationSeconds}s minimum).`,
      severity: "info",
    };
  }

  async function checkNoStaleLock(issue: IssueContext): Promise<QualityCheckResult> {
    if (issue.executionLockedAt) {
      return {
        pass: false,
        message: "Execution lock is still held. The checkout was not properly released before completion.",
        severity: "blocker",
      };
    }
    return { pass: true, message: "Execution lock properly released.", severity: "info" };
  }

  // --- Main gate ---

  async function runChecks(
    issue: IssueContext,
    config: Required<QualityGateConfig>,
  ): Promise<QualityGateResult> {
    if (!config.enabled) {
      return { passed: true, checks: [] };
    }

    const checks: QualityCheckResult[] = [];

    // Mandatory checks
    if (config.requireComment) {
      checks.push(await checkCommentRequired(issue));
    }
    checks.push(await checkDurationSanity(issue, config.requireMinimumDuration));
    checks.push(await checkNoStaleLock(issue));

    const blockers = checks.filter((c) => !c.pass && c.severity === "blocker");
    return { passed: blockers.length === 0, checks };
  }

  // --- Agent quality score ---

  async function recordCompletion(agentId: string, passed: boolean, failReasons: string[]): Promise<void> {
    const [agent] = await db
      .select({
        totalCompleted: agents.totalCompleted,
        totalReopened: agents.totalReopened,
        qualityScore: agents.qualityScore,
        qualityStreak: agents.qualityStreak,
        lastReopenReasons: agents.lastReopenReasons,
      })
      .from(agents)
      .where(eq(agents.id, agentId));

    if (!agent) return;

    const totalCompleted = (agent.totalCompleted ?? 0) + 1;
    const totalReopened = passed ? agent.totalReopened ?? 0 : (agent.totalReopened ?? 0) + 1;
    const qualityStreak = passed ? (agent.qualityStreak ?? 0) + 1 : 0;

    // Update reopen reasons: keep last 10
    let lastReopenReasons: string[] = Array.isArray(agent.lastReopenReasons)
      ? [...agent.lastReopenReasons]
      : [];
    if (!passed && failReasons.length > 0) {
      lastReopenReasons = [...failReasons, ...lastReopenReasons].slice(0, 10);
    }

    // Score: (completed - reopened) / completed * 100, floored at 0
    const score = totalCompleted > 0 ? Math.max(0, Math.round(((totalCompleted - totalReopened) / totalCompleted) * 100)) : 100;

    await db
      .update(agents)
      .set({
        totalCompleted,
        totalReopened,
        qualityScore: score,
        qualityStreak,
        lastReopenReasons,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));
  }

  async function getAgentQualityScore(agentId: string): Promise<{
    totalCompleted: number;
    totalReopened: number;
    totalBlocked: number;
    qualityScore: number;
    qualityStreak: number;
    lastReopenReasons: string[];
  } | null> {
    const [agent] = await db
      .select({
        totalCompleted: agents.totalCompleted,
        totalReopened: agents.totalReopened,
        totalBlocked: agents.totalBlocked,
        qualityScore: agents.qualityScore,
        qualityStreak: agents.qualityStreak,
        lastReopenReasons: agents.lastReopenReasons,
      })
      .from(agents)
      .where(eq(agents.id, agentId));

    if (!agent) return null;
    return {
      totalCompleted: agent.totalCompleted ?? 0,
      totalReopened: agent.totalReopened ?? 0,
      totalBlocked: agent.totalBlocked ?? 0,
      qualityScore: agent.qualityScore ?? 100,
      qualityStreak: agent.qualityStreak ?? 0,
      lastReopenReasons: Array.isArray(agent.lastReopenReasons) ? agent.lastReopenReasons : [],
    };
  }

  async function incrementBlockedCount(agentId: string): Promise<void> {
    await db
      .update(agents)
      .set({
        totalBlocked: sql`${agents.totalBlocked} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));
  }

  return {
    resolveConfig,
    runChecks,
    recordCompletion,
    getAgentQualityScore,
    incrementBlockedCount,
  };
}

export type QualityGateService = ReturnType<typeof qualityGateService>;
