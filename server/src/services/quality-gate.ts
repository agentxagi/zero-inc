import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agents, heartbeatRuns, issueComments, issueWorkProducts, issues } from "@zeroinc/db";
import { DEFAULT_QUALITY_GATE_CONFIG, type QualityGateConfig } from "@zeroinc/shared";

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
  title: string;
  originKind: string | null;
  status: string;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  executionLockedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

const CANONICAL_OUTPUT_ROOT = "/opt/paperclip/outputs/";
const LEGACY_OUTPUT_PREFIXES = ["/root/clawd/"];
const OUTPUT_REQUIRED_TITLE_KEYWORDS = [
  "content",
  "analytics",
  "engagement",
  "tweet",
  "thread",
  "report",
  "metrics",
];
const STRUCTURED_DELIVERABLE_PREFIXES = new Set([
  "BUG",
  "FEATURE",
  "CODE",
  "INFRA",
  "SHIP",
  "ENTERPRISE",
  "OPEN SOURCE",
  "BUILD",
  "DOCS",
  "PRODUCT",
]);
const STRUCTURED_DELIVERABLE_TITLE_KEYWORDS = [
  "feature",
  "bug",
  "deploy",
  "readme",
  "landing",
  "quickstart",
  "auth",
  "enterprise",
  "documentation",
  "docs",
];
const QUALIFYING_WORK_PRODUCT_STATUSES = new Set([
  "active",
  "ready_for_review",
  "approved",
  "merged",
  "closed",
]);

function extractIssuePrefix(title: string): string | null {
  const match = title.match(/^\s*\[([^\]]+)\]/);
  return match ? match[1]!.trim().toUpperCase() : null;
}

function requiresStructuredDeliverable(issue: Pick<IssueContext, "title" | "originKind">): boolean {
  if (issue.originKind === "routine_execution") return true;
  const prefix = extractIssuePrefix(issue.title ?? "");
  if (prefix && STRUCTURED_DELIVERABLE_PREFIXES.has(prefix)) return true;
  const titleLower = (issue.title ?? "").toLowerCase();
  return (
    OUTPUT_REQUIRED_TITLE_KEYWORDS.some((keyword) => titleLower.includes(keyword)) ||
    STRUCTURED_DELIVERABLE_TITLE_KEYWORDS.some((keyword) => titleLower.includes(keyword))
  );
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
  if (points.length === 0) return 100; // no data yet

  // Score starts at 100 and adjusts per attempt
  // +10 pass: +0 (neutral — this is expected behavior)
  // -15 blocker: -8 (significant penalty)
  // -3 warning: -2 (minor penalty)
  // 0 info: -1 (slight penalty for not being a clean pass)
  let score = 100;

  for (let i = 0; i < points.length; i++) {
    const recency = 1.0 - i * 0.02; // recent attempts weigh more
    if (points[i] >= POINTS_PASS) {
      // Clean pass: no change (expected behavior)
    } else if (points[i] <= POINTS_BLOCKER) {
      score -= 8 * recency; // blocker: heavy penalty
    } else if (points[i] <= POINTS_WARNING) {
      score -= 2 * recency; // warning: minor penalty
    } else {
      score -= 1 * recency; // info: tiny penalty
    }
  }

  // Streak bonus: consecutive passes recover score
  if (streak >= 10) score += 5;
  else if (streak >= 5) score += 3;
  else if (streak >= 3) score += 1;

  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
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
      requireVerificationEvidence:
        companyConfig.requireVerificationEvidence ?? DEFAULT_QUALITY_GATE_CONFIG.requireVerificationEvidence,
      autoReopen: companyConfig.autoReopen ?? DEFAULT_QUALITY_GATE_CONFIG.autoReopen,
    };
  }

  // --- Individual checks ---

  function normalizePendingComment(pendingCommentBody?: string | null): string | null {
    if (typeof pendingCommentBody !== "string") return null;
    const trimmed = pendingCommentBody.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  async function checkCommentRequired(
    issue: IssueContext,
    pendingCommentBody?: string | null,
  ): Promise<QualityCheckResult> {
    const pendingComment = normalizePendingComment(pendingCommentBody);
    if (pendingComment) {
      return {
        pass: true,
        message: "Completion comment provided in request payload.",
        severity: "info",
      };
    }

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

  async function checkVerificationEvidence(
    issue: IssueContext,
    requireAsBlocker: boolean,
    pendingCommentBody?: string | null,
  ): Promise<QualityCheckResult> {
    // Fetch all comments for this issue (reverse chronological)
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(sql`${issueComments.createdAt} DESC`)
      .limit(5);

    // Look for verification evidence in the latest comments
    const verificationKeywords = [
      "verification", "verified", "curl", "npm test", "tsc", "screenshot",
      "http 200", "all passing", "grep", "diff", "confirmed", "checked",
      "tested", "response", "status code", "deployed to", "uploaded to",
      "file exists", "agent-browser",
    ];

    const pendingComment = normalizePendingComment(pendingCommentBody);
    const bodyLower = [pendingComment ?? "", ...comments.map((c) => (c.body ?? "").toLowerCase())].join(" ");

    const hasLegacyOutputPath = LEGACY_OUTPUT_PREFIXES.some((prefix) =>
      bodyLower.includes(prefix.toLowerCase()),
    );
    if (hasLegacyOutputPath) {
      return {
        pass: false,
        message:
          `Legacy output path detected in completion evidence. Use ${CANONICAL_OUTPUT_ROOT} for deliverables.`,
        severity: "blocker",
      };
    }

    const titleLower = (issue.title ?? "").toLowerCase();
    const requiresOutputPath =
      issue.originKind === "routine_execution" ||
      OUTPUT_REQUIRED_TITLE_KEYWORDS.some((keyword) => titleLower.includes(keyword));
    if (requiresOutputPath && !bodyLower.includes(CANONICAL_OUTPUT_ROOT.toLowerCase())) {
      return {
        pass: false,
        message:
          `Deliverable path missing. Operational/content work must publish outputs under ${CANONICAL_OUTPUT_ROOT}.`,
        severity: "blocker",
      };
    }

    const hasVerification = verificationKeywords.some(kw => bodyLower.includes(kw));

    const hasStructuredFormat =
      bodyLower.includes("### verification") ||
      bodyLower.includes("### output") ||
      bodyLower.includes("### what was done") ||
      bodyLower.includes("## done");

    if (hasVerification || hasStructuredFormat) {
      return {
        pass: true,
        message: `Verification evidence found (${hasStructuredFormat ? "structured format" : "keywords"}).`,
        severity: "info",
      };
    }

    if (requireAsBlocker) {
      return {
        pass: false,
        message: "No verification evidence found. Agent must include proof of work (curl results, test output, file checks, screenshots, etc.) before marking the task as done.",
        severity: "blocker",
      };
    }

    // Warning (not blocker) — soft enforcement
    return {
      pass: true,
      message: "Completion comment lacks verification evidence. Consider adding proof of work (curl results, test output, file checks).",
      severity: "warning",
    };
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

  async function checkStructuredDeliverable(issue: IssueContext): Promise<QualityCheckResult> {
    if (!requiresStructuredDeliverable(issue)) {
      return {
        pass: true,
        message: "Structured deliverable not required for this task category.",
        severity: "info",
      };
    }

    const products = await db
      .select({
        id: issueWorkProducts.id,
        type: issueWorkProducts.type,
        status: issueWorkProducts.status,
        title: issueWorkProducts.title,
      })
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.companyId, issue.companyId), eq(issueWorkProducts.issueId, issue.id)))
      .limit(20);

    const qualifying = products.filter((product) =>
      QUALIFYING_WORK_PRODUCT_STATUSES.has(String(product.status ?? "").toLowerCase()),
    );

    if (qualifying.length === 0) {
      return {
        pass: false,
        message:
          "No structured work product attached. Add at least one /api/issues/:id/work-products entry before marking this task as done.",
        severity: "blocker",
      };
    }

    const summary = qualifying
      .slice(0, 3)
      .map((product) => `${product.type}:${product.status}`)
      .join(", ");
    return {
      pass: true,
      message: `Structured deliverable evidence found (${qualifying.length} work product(s): ${summary}).`,
      severity: "info",
    };
  }

  async function checkNoStaleLock(issue: IssueContext): Promise<QualityCheckResult> {
    // No lock fields set — lock is properly released
    if (!issue.executionLockedAt && !issue.executionRunId) {
      return { pass: true, message: "Execution lock properly released.", severity: "info" };
    }
    // Lock fields are present — verify the execution run is still active.
    // A stale timestamp from a completed/failed run should not block completion.
    if (issue.executionRunId) {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, issue.executionRunId))
        .limit(1);
      if (run && (run.status === "queued" || run.status === "running")) {
        return {
          pass: false,
          message: "Execution lock is still held. The checkout was not properly released before completion.",
          severity: "blocker",
        };
      }
      // Run is completed/failed/missing — stale lock, treat as released
      return { pass: true, message: "Execution lock stale (run finished) — treating as released.", severity: "info" };
    }
    // executionLockedAt is set but executionRunId is null — orphaned timestamp, clear it
    return { pass: true, message: "Execution lock orphaned (no run) — treating as released.", severity: "info" };
  }

  // --- Main gate ---

  async function runChecks(
    issue: IssueContext,
    config: Required<QualityGateConfig>,
    options?: { pendingCommentBody?: string | null },
  ): Promise<QualityGateResult> {
    if (!config.enabled) {
      return { passed: true, checks: [] };
    }

    const checks: QualityCheckResult[] = [];

    // Mandatory checks
    if (config.requireComment) {
      checks.push(await checkCommentRequired(issue, options?.pendingCommentBody));
    }
    checks.push(
      await checkVerificationEvidence(issue, config.requireVerificationEvidence, options?.pendingCommentBody),
    );
    checks.push(await checkStructuredDeliverable(issue));
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

    // Calculate v2 score — always real, even during warmup
    const score = calculateScore(newPoints, qualityStreak);
    const dbScore = Math.round(score);
    const { state: qualityState, badge: qualityBadge, autoAssign: qualityAutoAssign } =
      getQualityState(score, newPoints.length);

    await db
      .update(agents)
      .set({
        totalCompleted,
        totalReopened,
        qualityScore: dbScore,
        qualityState,
        qualityBadge,
        qualityAutoAssign,
        qualityPoints: newPoints,
        qualityStreak,
        qualityAttempts: newPoints.length,
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
    const displayScore = Math.round(score);
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
