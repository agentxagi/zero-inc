import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agents, issues, issueComments } from "@zeroinc/db";
import { logger } from "../middleware/logger.js";

export interface AuditCheckResult {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  assigneeAgentName: string | null;
  qualityScore: number | null;
  durationMinutes: number | null;
  commentCount: number;
  flagged: boolean;
  flagReasons: string[];
}

export interface AuditSummary {
  total: number;
  reviewed: number;
  unreviewed: number;
  flagged: number;
  details: AuditCheckResult[];
}

export function taskAuditService(db: Db) {
  async function runAudit(companyId: string): Promise<AuditSummary> {
    // Get done issues with no review (reviewerAgentId is null)
    const doneIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        assigneeAgentId: issues.assigneeAgentId,
        startedAt: issues.startedAt,
        completedAt: issues.completedAt,
        reviewerAgentId: issues.reviewerAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.status, "done"),
          isNull(issues.reviewerAgentId),
        ),
      )
      .orderBy(issues.completedAt);

    // Batch fetch agent names and quality scores
    const agentIds = [...new Set(doneIssues.map((i) => i.assigneeAgentId).filter((id): id is string => id != null))];
    const agentMap = new Map<string, { name: string; qualityScore: number | null }>();
    if (agentIds.length > 0) {
      const rows = await db
        .select({ id: agents.id, name: agents.name, qualityScore: agents.qualityScore })
        .from(agents)
        .where(
          sql`${agents.id} = ANY(${agentIds})`,
        );
      for (const row of rows) {
        agentMap.set(row.id, { name: row.name, qualityScore: row.qualityScore });
      }
    }

    // Batch fetch comment counts
    const issueIds = doneIssues.map((i) => i.id);
    const commentCounts = new Map<string, number>();
    if (issueIds.length > 0) {
      const rows = await db
        .select({
          issueId: issueComments.issueId,
          count: sql<number>`count(*)`,
        })
        .from(issueComments)
        .where(sql`${issueComments.issueId} = ANY(${issueIds})`)
        .groupBy(issueComments.issueId);
      for (const row of rows) {
        commentCounts.set(row.issueId, Number(row.count));
      }
    }

    const details: AuditCheckResult[] = [];

    for (const issue of doneIssues) {
      const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : null;
      const qualityScore = agent?.qualityScore ?? null;
      const commentCount = commentCounts.get(issue.id) ?? 0;

      let durationMinutes: number | null = null;
      if (issue.startedAt && issue.completedAt) {
        durationMinutes = Math.round(
          (new Date(issue.completedAt).getTime() - new Date(issue.startedAt).getTime()) / 60000,
        );
      }

      const flagReasons: string[] = [];

      // Flag if agent quality score < 50
      if (qualityScore !== null && qualityScore < 50) {
        flagReasons.push(`Low agent quality score: ${qualityScore}`);
      }

      // Flag if duration < 2 minutes (likely didn't do meaningful work)
      if (durationMinutes !== null && durationMinutes < 2) {
        flagReasons.push(`Very short duration: ${durationMinutes}min`);
      }

      // Flag if no comments at all
      if (commentCount === 0) {
        flagReasons.push("No comments");
      }

      // Flag if already audit-flagged, keep the existing flag
      const existing = await db
        .select({ auditFlagged: issues.auditFlagged })
        .from(issues)
        .where(eq(issues.id, issue.id))
        .then((rows) => rows[0] ?? null);

      const flagged = existing?.auditFlagged === true || flagReasons.length > 0;

      details.push({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeAgentName: agent?.name ?? null,
        qualityScore,
        durationMinutes,
        commentCount,
        flagged,
        flagReasons,
      });
    }

    const flagged = details.filter((d) => d.flagged);
    const reviewed = doneIssues.length - details.length;

    logger.info(
      `[task-audit] Audit complete for company ${companyId}: ${details.length} unreviewed, ${flagged.length} flagged`,
    );

    return {
      total: doneIssues.length + reviewed,
      reviewed,
      unreviewed: details.length,
      flagged: flagged.length,
      details,
    };
  }

  async function flagIssue(issueId: string, companyId: string): Promise<boolean> {
    const [updated] = await db
      .update(issues)
      .set({
        auditFlagged: true,
        auditFlaggedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .returning();

    if (updated) {
      // Add audit comment
      const existing = await db
        .select({ assigneeAgentId: issues.assigneeAgentId, identifier: issues.identifier })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      await db.insert(issueComments).values({
        companyId,
        issueId,
        body: "## Task Audit\n\nThis task has been flagged for audit review. Quality checks detected potential issues with the completion.",
      });

      logger.info(`[task-audit] Flagged issue ${existing?.identifier ?? issueId} for audit`);
    }

    return updated !== null && updated !== undefined;
  }

  async function unflagIssue(issueId: string, companyId: string): Promise<boolean> {
    const [updated] = await db
      .update(issues)
      .set({
        auditFlagged: false,
        auditFlaggedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .returning();

    return updated !== null && updated !== undefined;
  }

  return { runAudit, flagIssue, unflagIssue };
}

export type TaskAuditService = ReturnType<typeof taskAuditService>;
