import { Router } from "express";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agents, issueLabels, issues, labels } from "@zeroinc/db";
import { dashboardService } from "../services/dashboard.js";
import { productCouncilService } from "../services/product-council.js";
import { issueService } from "../services/issues.js";
import { logActivity } from "../services/activity-log.js";
import { smartAssignerService } from "../services/smart-assigner.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Simple in-memory cache with TTL
const cache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function priorityRank(priority: string | null | undefined): number {
  switch ((priority ?? "").toLowerCase()) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function slaStateForDueAt(dueAt: Date | null) {
  if (!dueAt) {
    return { state: "no_sla" as const, minutesRemaining: null as number | null };
  }
  const minutesRemaining = Math.floor((dueAt.getTime() - Date.now()) / (60 * 1000));
  if (minutesRemaining < 0) {
    return { state: "overdue" as const, minutesRemaining };
  }
  if (minutesRemaining <= 120) {
    return { state: "due_soon" as const, minutesRemaining };
  }
  return { state: "on_track" as const, minutesRemaining };
}

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);
  const council = productCouncilService(db);
  const issuesSvc = issueService(db);

  // Existing route for company dashboard
  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  /**
   * GET /api/dashboard/companies/:companyId/human-queue
   * Dedicated human inbox sorted by SLA/impact for explicit human handoff tasks.
   */
  router.get("/companies/:companyId/human-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const requiresHumanLabelIds = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), sql`lower(${labels.name}) = 'requires_human'`))
      .then((rows) => rows.map((row) => row.id));

    const labeledIssueIds = requiresHumanLabelIds.length > 0
      ? await db
        .select({ issueId: issueLabels.issueId })
        .from(issueLabels)
        .where(and(eq(issueLabels.companyId, companyId), inArray(issueLabels.labelId, requiresHumanLabelIds)))
        .then((rows) => rows.map((row) => row.issueId))
      : [];

    const humanCondition = labeledIssueIds.length > 0
      ? or(eq(issues.blockedByHuman, true), inArray(issues.id, labeledIssueIds))
      : eq(issues.blockedByHuman, true);

    const openIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        humanActionType: issues.humanActionType,
        humanResolutionHint: issues.humanResolutionHint,
        humanBlockedAt: issues.humanBlockedAt,
        humanSlaDueAt: issues.humanSlaDueAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          sql`${issues.status} in ('backlog','todo','in_progress','in_review','blocked')`,
          humanCondition,
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(300);

    const requiresHumanIssueIdSet = new Set(labeledIssueIds);
    const withSla = openIssues.map((row) => {
      const sla = slaStateForDueAt(row.humanSlaDueAt);
      return {
        issueId: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        priority: row.priority,
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
        humanActionType: row.humanActionType,
        humanResolutionHint: row.humanResolutionHint,
        humanBlockedAt: row.humanBlockedAt,
        humanSlaDueAt: row.humanSlaDueAt,
        slaState: sla.state,
        slaMinutesRemaining: sla.minutesRemaining,
        requiresHumanLabel: requiresHumanIssueIdSet.has(row.id),
        updatedAt: row.updatedAt,
      };
    });

    const slaRank: Record<"overdue" | "due_soon" | "on_track" | "no_sla", number> = {
      overdue: 0,
      due_soon: 1,
      on_track: 2,
      no_sla: 3,
    };
    withSla.sort((left, right) => {
      const leftRank = slaRank[left.slaState];
      const rightRank = slaRank[right.slaState];
      if (leftRank !== rightRank) return leftRank - rightRank;

      const leftDue = left.humanSlaDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const rightDue = right.humanSlaDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (leftDue !== rightDue) return leftDue - rightDue;

      const leftPriority = priorityRank(left.priority);
      const rightPriority = priorityRank(right.priority);
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;

      return right.updatedAt.getTime() - left.updatedAt.getTime();
    });

    const response = {
      companyId,
      generatedAt: new Date(),
      total: withSla.length,
      overdue: withSla.filter((item) => item.slaState === "overdue").length,
      dueSoon: withSla.filter((item) => item.slaState === "due_soon").length,
      items: withSla.map(({ updatedAt: _updatedAt, ...item }) => item),
    };

    res.json(response);
  });

  /**
   * GET /api/dashboard/companies/:companyId/agent
   * Machine-readable system state for agent proactive monitoring.
   * Returns tasks by status, agent statuses, stale/blocked alerts,
   * recent completions, and active sprint summary.
   * Cached for 2 minutes to reduce DB load.
   */
  router.get("/companies/:companyId/agent", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const data = await svc.agentSummary(companyId);
      res.json(data);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: errorMessage });
    }
  });

  /**
   * GET /api/dashboard/companies/:companyId/product-council
   * Outcome-oriented planning snapshot used by PM/CTO.
   */
  router.get("/companies/:companyId/product-council", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const maxProposalsRaw = req.query.maxProposals;
      const maxProposals = typeof maxProposalsRaw === "string" ? Number.parseInt(maxProposalsRaw, 10) : undefined;
      const goalId = typeof req.query.goalId === "string" ? req.query.goalId : undefined;
      const ensurePrograms = req.query.ensurePrograms === "true";
      const data = await council.analyze(companyId, {
        goalId: goalId && goalId.length > 0 ? goalId : undefined,
        maxProposals: Number.isFinite(maxProposals) ? maxProposals : undefined,
        ensureMacroPrograms: ensurePrograms,
      });
      res.json(data);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: errorMessage });
    }
  });

  /**
   * POST /api/dashboard/companies/:companyId/product-council/generate
   * Materializes council proposals as backlog/todo issues.
   */
  router.post("/companies/:companyId/product-council/generate", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const body = (req.body ?? {}) as {
        goalId?: string | null;
        maxProposals?: number;
        dryRun?: boolean;
        targetStatus?: "backlog" | "todo";
      };

      const targetStatus = body.targetStatus === "todo" ? "todo" : "backlog";
      const report = await council.analyze(companyId, {
        goalId: body.goalId ?? undefined,
        maxProposals: body.maxProposals,
        ensureMacroPrograms: true,
      });

      if (!report.gating.shouldGenerate) {
        res.json({
          generated: 0,
          skipped: report.proposals.length,
          reason: report.gating.reason,
          dryRun: Boolean(body.dryRun),
          report,
        });
        return;
      }

      if (body.dryRun === true) {
        res.json({
          generated: 0,
          skipped: 0,
          dryRun: true,
          report,
          createdIssues: [],
          skippedProposals: [],
        });
        return;
      }

      const openRows = await db
        .select({
          id: issues.id,
          title: issues.title,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            sql`${issues.status} in ('backlog','todo','in_progress','in_review','blocked')`,
            sql`${issues.hiddenAt} is null`,
          ),
        )
        .limit(400);
      const openTitleSet = new Set(openRows.map((row) => row.title.trim().toLowerCase()));

      const createdIssues: Array<{ id: string; identifier: string; title: string }> = [];
      const skippedProposals: Array<{ proposalId: string; title: string; reason: string }> = [];

      for (const proposal of report.proposals) {
        const normalizedTitle = proposal.title.trim().toLowerCase();
        if (!normalizedTitle || openTitleSet.has(normalizedTitle)) {
          skippedProposals.push({
            proposalId: proposal.id,
            title: proposal.title,
            reason: "duplicate_open_title",
          });
          continue;
        }

        const definitionOfDone = proposal.definitionOfDone
          .map((item) => `- ${item}`)
          .join("\n");
        const issueDescription =
          `${proposal.description}\n\n` +
          `Suggested owner role: ${proposal.suggestedOwnerRole ?? "n/a"}\n` +
          `Suggested assignee: ${proposal.suggestedAssigneeName ?? "n/a"}\n\n` +
          "## Definition of Done\n" +
          `${definitionOfDone}\n\n` +
          `Generated by Product Council at ${report.timestamp}.`;

        const created = await issuesSvc.create(companyId, {
          title: proposal.title,
          description: issueDescription,
          status: targetStatus,
          priority: proposal.priority,
          goalId: report.goal?.id ?? null,
          originKind: "manual",
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        });

        openTitleSet.add(normalizedTitle);
        createdIssues.push({
          id: created.id,
          identifier: created.identifier ?? created.id,
          title: created.title,
        });

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.created",
          entityType: "issue",
          entityId: created.id,
          details: {
            title: created.title,
            identifier: created.identifier,
            source: "product_council",
            proposalId: proposal.id,
            sourceMilestoneId: proposal.sourceMilestoneId,
          },
        });
      }

      res.status(201).json({
        generated: createdIssues.length,
        skipped: skippedProposals.length,
        dryRun: false,
        reason: report.gating.reason,
        report,
        createdIssues,
        skippedProposals,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: errorMessage });
    }
  });

  /**
   * GET /api/dashboard/human
   * Human dashboard endpoint - returns actionable information for Gustavo
   * Uses x-company-id header for company identification
   * Cached for 5 minutes to avoid overload
   */
  router.get("/human", async (req, res) => {
    try {
      const companyId = req.header("x-company-id") as string;
      
      if (!companyId) {
        res.status(400).json({ error: "x-company-id header is required" });
        return;
      }

      assertCompanyAccess(req, companyId);

      // Check cache first
      const cacheKey = `human-dashboard:${companyId}`;
      const cached = getCached(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      // Gustavo's agent ID (human agent in the system)
      const gustavoAgentId = "e1550682-66b8-4273-80fb-169cb6ba3a6d";

      // 1. URGENT - Tasks requiring human action
      // - Assigned to Gustavo
      // - Status: in_progress, todo, or blocked
      // - Or any blocked task (might need human intervention)
      
      const urgentTasks = await db
        .select({
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          createdAt: issues.createdAt,
          startedAt: issues.startedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            or(
              // Tasks assigned to Gustavo that are not done
              and(
                eq(issues.assigneeAgentId, gustavoAgentId),
                or(
                  eq(issues.status, "in_progress"),
                  eq(issues.status, "todo"),
                  eq(issues.status, "blocked")
                )
              ),
              // Any blocked task (might need human intervention)
              eq(issues.status, "blocked")
            )
          )
        )
        .limit(20);

      const urgent = urgentTasks.map((task) => ({
        identifier: task.identifier,
        title: task.title,
        status: task.status,
        action: task.status === "blocked" ? "Desbloquear tarefa" : "Sua ação necessária",
        priority: task.priority,
      }));

      // 2. AUTOMATABLE - Outputs ready for automation
      const outputsDir = "/opt/paperclip/outputs";
      const automatable: Array<{ file: string; task: string; status: string; action: string }> = [];
      
      try {
        const today = new Date().toISOString().split("T")[0];
        const todayDir = join(outputsDir, today);
        
        if (existsSync(todayDir)) {
          const files = readdirSync(todayDir);
          for (const file of files) {
            if (file.endsWith(".md") || file.endsWith(".json") || file.endsWith(".csv")) {
              const match = file.match(/(VAL-\d+)/);
              automatable.push({
                file: join(today, file),
                task: match ? match[1] : "unknown",
                status: "ready",
                action: "Bot pode executar automaticamente",
              });
            }
          }
        }
      } catch {
        // Outputs directory doesn't exist or can't be read
      }

      // 3. RUNNING - Agent status
      const agentRows = await db
        .select({
          status: agents.status,
          count: sql<number>`count(*)`,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const agentCounts: Record<string, number> = {
        running: 0,
        idle: 0,
        paused: 0,
        error: 0,
      };
      
      for (const row of agentRows) {
        const count = Number(row.count);
        const status = row.status as string;
        if (status in agentCounts) {
          agentCounts[status] = count;
        }
      }

      // 4. METRICS - Tasks done today
      const doneToday = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            sql`${issues.completedAt}::date = CURRENT_DATE`
          )
        )
        .then((rows) => Number(rows[0]?.count ?? 0));

      // Calculate outputs size
      let outputsSize = 0;
      try {
        const today = new Date().toISOString().split("T")[0];
        const todayDir = join(outputsDir, today);
        if (existsSync(todayDir)) {
          const files = readdirSync(todayDir);
          for (const file of files) {
            const filePath = join(todayDir, file);
            const stats = statSync(filePath);
            if (stats.isFile()) {
              outputsSize += stats.size;
            }
          }
        }
      } catch {
        // Can't read outputs
      }

      const response = {
        timestamp: new Date().toISOString(),
        urgent,
        automatable,
        running: {
          agents_working: agentCounts.running,
          agents_idle: agentCounts.idle,
          agents_error: agentCounts.error,
          system_status: agentCounts.error > 0 ? "degraded" : "healthy",
        },
        metrics: {
          tasks_done_today: doneToday,
          outputs_generated: `${Math.round(outputsSize / 1024)}KB`,
          agents_active: agentCounts.running,
        },
      };

      // Cache the response
      setCache(cacheKey, response);

      res.json(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: errorMessage });
    }
  });

  // POST /api/dashboard/companies/:companyId/smart-assign — trigger smart assignment for a specific issue
  router.post("/companies/:companyId/smart-assign", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const { issueId } = req.body;

      assertCompanyAccess(req, companyId);

      if (!issueId) {
        res.status(400).json({ error: "issueId is required" });
        return;
      }

      const assigner = smartAssignerService(db);
      const agentId = await assigner.assignIssue(issueId, companyId);

      if (!agentId) {
        res.json({ assigned: false, reason: "No eligible agent found" });
        return;
      }

      res.json({ assigned: true, agentId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: errorMessage });
    }
  });

  // POST /api/dashboard/companies/:companyId/smart-assign/bulk — auto-assign all unassigned todo tasks
  router.post("/companies/:companyId/smart-assign/bulk", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      // Find all unassigned todo issues (no agent and no user assignee)
      const unassigned = await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "todo"),
            sql`${issues.assigneeAgentId} IS NULL`,
            sql`${issues.assigneeUserId} IS NULL`,
          )
        )
        .limit(50);

      if (unassigned.length === 0) {
        res.json({ assigned: 0, results: [], message: "No unassigned tasks found" });
        return;
      }

      const assigner = smartAssignerService(db);
      const results: Array<{ identifier: string; title: string; assigned: boolean; agentId?: string; reason?: string }> = [];
      let assignedCount = 0;

      for (const issue of unassigned) {
        const agentId = await assigner.assignIssue(issue.id, companyId);
        const identifier = issue.identifier ?? issue.id;
        if (agentId) {
          assignedCount++;
          results.push({ identifier, title: issue.title, assigned: true, agentId });
        } else {
          results.push({ identifier, title: issue.title, assigned: false, reason: "No eligible agent found" });
        }
      }

      res.json({ assigned: assignedCount, total: unassigned.length, results });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: errorMessage });
    }
  });

  return router;
}
