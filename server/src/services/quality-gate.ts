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

export type QualityState = "excellent" | "good" | "fair" | "poor" | "critical" | "warming_up";

export interface AgentQualityInfo {
  totalCompleted: number;
  totalReopened: number;
  totalBlocked: number;
  qualityScore: number;
  qualityState: QualityState;
  qualityBadge: string;
  qualityStreak: number;
  qualityAttempts: number;
  qualityAutoAssign: boolean;
  lastReopenReasons: string[];
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

const POINTS_PASS = 10;
const POINTS_BLOCKER = -15;
const POINTS_WARNING = -3;
const POINTS_INFO = 0;
const MAX_WINDOW = 20;
const MIN_ATTEMPTS_FOR_SCORE = 5;

// ---------------------------------------------------------------------------
// Pure scoring functions
// ---------------------------------------------------------------------------

export function calculateScore(points: number[], streak: number): number {
  if (points.length < MIN_ATTEMPTS_FOR_SCORE) return -1; // warming up

  let weightedEarned = 0;
  let weightedPossible = 0;

  for (let i = 0; i < points.length; i++) {
    const weight = 1.0 - i * 0.03;
    weightedEarned += points[i] * weight;
    weightedPossible += POINTS_PASS * weight;
  }

  let finalScore = weightedPossible > 0 ? (weightedEarned / weightedPossible) * 100 : 0;
  finalScore = Math.max(0, finalScore);

  // Streak bonus
  if (streak >= 10) finalScore = Math.min(100, finalScore * 1.1);
  else if (streak >= 5) finalScore = Math.min(100, finalScore * 1.05);

  return Math.round(finalScore * 10) / 10;
}

export function getQualityState(score: number, attempts: number): {
  state: QualityState;
  badge: string;
  autoAssign: boolean;
} {
  if (attempts < MIN_ATTEMPTS_FOR_SCORE) {
    return { state: "warming_up", badge: "\uD83D\uDD35", autoAssign: true };
  }
  if (score >= 90) return { state: "excellent", badge: "\uD83D\uDFE2", autoAssign: true };
  if (score >= 70) return { state: "good", badge: "\uD83D\uDFE1", autoAssign: true };
  if (score >= 50) return { state: "fair", badge: "\uD83D\uDFE0", autoAssign: true };
  if (score >= 30) return { state: "poor", badge: "\uD83D\uDD34", autoAssign: false };
  return { state: "critical", badge: "\u26D4", autoAssign: false };
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

  // --- Agent quality score (v2) ---

  async function recordCompletion(agentId: string, result: QualityGateResult): Promise<void> {
    const [agent] = await db
      .select({
        totalCompleted: agents.totalCompleted,
        totalReopened: agents.totalReopened,
        qualityPoints: agents.qualityPoints,
        qualityScore: agents.qualityScore,
        qualityStreak: agents.qualityStreak,
        lastReopenReasons: agents.lastReopenReasons,
      })
      .from(agents)
      .where(eq(agents.id, agentId));

    if (!agent) return;

    // Determine points from gate result
    let points: number;
    const hasBlocker = result.checks.some((c) => !c.pass && c.severity === "blocker");
    const hasWarning = result.checks.some((c) => !c.pass && c.severity === "warning");

    if (hasBlocker) {
      points = POINTS_BLOCKER;
    } else if (hasWarning) {
      points = POINTS_WARNING;
    } else if (result.passed) {
      points = POINTS_PASS;
    } else {
      points = POINTS_INFO;
    }

    // Build new qualityPoints array (most recent first, max 20)
    const existingPoints: number[] = Array.isArray(agent.qualityPoints) ? agent.qualityPoints : [];
    const newPoints = [points, ...existingPoints].slice(0, MAX_WINDOW);

    // Update streak: pass (+10) continues streak, anything else resets
    const qualityStreak = points >= POINTS_PASS ? (agent.qualityStreak ?? 0) + 1 : 0;

    // Update legacy counters
    const totalCompleted = (agent.totalCompleted ?? 0) + 1;
    const totalReopened = points >= POINTS_PASS
      ? agent.totalReopened ?? 0
      : (agent.totalReopened ?? 0) + 1;

    // Update reopen reasons: keep last 10
    let lastReopenReasons: string[] = Array.isArray(agent.lastReopenReasons)
      ? [...agent.lastReopenReasons]
      : [];
    if (points < POINTS_PASS) {
      const failReasons = result.checks
        .filter((c) => !c.pass)
        .map((c) => c.message);
      lastReopenReasons = [...failReasons, ...lastReopenReasons].slice(0, 10);
    }

    // Calculate v2 score — keep existing DB value during warmup
    const score = calculateScore(newPoints, qualityStreak);
    const dbScore = score >= 0 ? Math.round(score) : (agent.qualityScore ?? 100);

    await db
      .update(agents)
      .set({
        totalCompleted,
        totalReopened,
        qualityScore: dbScore,
        qualityPoints: newPoints,
        qualityStreak,
        lastReopenReasons,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));
  }

  async function getAgentQualityScore(agentId: string): Promise<AgentQualityInfo | null> {
    const [agent] = await db
      .select({
        totalCompleted: agents.totalCompleted,
        totalReopened: agents.totalReopened,
        totalBlocked: agents.totalBlocked,
        qualityScore: agents.qualityScore,
        qualityPoints: agents.qualityPoints,
        qualityStreak: agents.qualityStreak,
        lastReopenReasons: agents.lastReopenReasons,
      })
      .from(agents)
      .where(eq(agents.id, agentId));

    if (!agent) return null;

    const points: number[] = Array.isArray(agent.qualityPoints) ? agent.qualityPoints : [];
    const streak = agent.qualityStreak ?? 0;
    const score = calculateScore(points, streak);
    const displayScore = score >= 0 ? score : (agent.qualityScore ?? 100);
    const { state, badge, autoAssign } = getQualityState(score, points.length);

    return {
      totalCompleted: agent.totalCompleted ?? 0,
      totalReopened: agent.totalReopened ?? 0,
      totalBlocked: agent.totalBlocked ?? 0,
      qualityScore: displayScore,
      qualityState: state,
      qualityBadge: badge,
      qualityStreak: streak,
      qualityAttempts: points.length,
      qualityAutoAssign: autoAssign,
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
