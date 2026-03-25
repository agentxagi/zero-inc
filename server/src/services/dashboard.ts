import { and, eq, gte, isNotNull, lte, sql, desc } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agents, approvals, companies, costEvents, issues, sprints, goals } from "@zeroinc/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {

    /**
     * Machine-readable dashboard for agents.
     * Returns system state optimized for proactive monitoring.
     */
    agentSummary: async (companyId: string) => {
      // 1. Agent statuses
      const agentRows = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          status: agents.status,
          qualityScore: agents.qualityScore,
          qualityAutoAssign: agents.qualityAutoAssign,
          lastHeartbeatAt: agents.lastHeartbeatAt,
          totalCompleted: agents.totalCompleted,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const agentList = agentRows.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        status: a.status,
        qualityScore: a.qualityScore,
        qualityAutoAssign: a.qualityAutoAssign,
        lastHeartbeatAt: a.lastHeartbeatAt?.toISOString() ?? null,
        totalCompleted: a.totalCompleted,
      }));

      const agentsByStatus = {
        running: agentList.filter((a) => a.status === "running"),
        idle: agentList.filter((a) => a.status === "idle"),
        error: agentList.filter((a) => a.status === "error"),
        paused: agentList.filter((a) => a.status === "paused"),
      };

      // 2. Tasks by status and assignee
      const now = new Date();
      const staleThreshold = new Date(now.getTime() - 4 * 60 * 60 * 1000); // 4h stale

      const taskRows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          reviewerAgentId: issues.reviewerAgentId,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          updatedAt: issues.updatedAt,
          goalId: issues.goalId,
          sprintId: issues.sprintId,
          parentId: issues.parentId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            sql`${issues.status} != 'cancelled'`,
          ),
        )
        .orderBy(desc(issues.updatedAt));

      // Build agent name map
      const agentNameMap: Record<string, string> = {};
      for (const a of agentRows) {
        agentNameMap[a.id] = a.name;
      }

      const tasksByStatus = {
        todo: taskRows.filter((t) => t.status === "todo"),
        in_progress: taskRows.filter((t) => t.status === "in_progress"),
        blocked: taskRows.filter((t) => t.status === "blocked"),
        in_review: taskRows.filter((t) => t.status === "in_review"),
        done: taskRows.filter((t) => t.status === "done"),
      };

      // 3. Stale tasks (in_progress > 4h without update)
      const staleTasks = taskRows.filter(
        (t) =>
          (t.status === "in_progress" || t.status === "blocked") &&
          t.updatedAt &&
          new Date(t.updatedAt) < staleThreshold,
      );

      // 4. Blocked tasks
      const blockedTasks = tasksByStatus.blocked.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        title: t.title,
        assignee: t.assigneeAgentId ? agentNameMap[t.assigneeAgentId] ?? null : null,
        updatedAt: t.updatedAt?.toISOString() ?? null,
      }));

      // 5. Tasks in review waiting for action
      const reviewTasks = tasksByStatus.in_review.map((t) => ({
        id: t.id,
        identifier: t.identifier,
        title: t.title,
        assignee: t.assigneeAgentId ? agentNameMap[t.assigneeAgentId] ?? null : null,
        reviewer: t.reviewerAgentId ? agentNameMap[t.reviewerAgentId] ?? null : null,
        startedAt: t.startedAt?.toISOString() ?? null,
      }));

      // 6. Unassigned todo tasks
      const unassignedTasks = tasksByStatus.todo.filter(
        (t) => !t.assigneeAgentId && !t.assigneeUserId,
      ).map((t) => ({
        id: t.id,
        identifier: t.identifier,
        title: t.title,
        priority: t.priority,
      }));

      // 7. Recent completions (last 24h)
      const recentDone = taskRows.filter(
        (t) => t.status === "done" && t.completedAt && new Date(t.completedAt) > new Date(now.getTime() - 24 * 60 * 60 * 1000),
      ).map((t) => ({
        identifier: t.identifier,
        title: t.title,
        assignee: t.assigneeAgentId ? agentNameMap[t.assigneeAgentId] ?? null : null,
        completedAt: t.completedAt?.toISOString() ?? null,
      }));

      // 8. Active sprint summary
      const [activeSprint] = await db
        .select()
        .from(sprints)
        .where(
          and(
            eq(sprints.companyId, companyId),
            eq(sprints.status, "active"),
          ),
        )
        .limit(1);

      let sprintSummary = null;
      if (activeSprint) {
        const sprintIssues = taskRows.filter((t) => t.sprintId === activeSprint.id);
        sprintSummary = {
          id: activeSprint.id,
          name: activeSprint.name,
          goal: activeSprint.goal,
          totalIssues: sprintIssues.length,
          completed: sprintIssues.filter((t) => t.status === "done").length,
          inProgress: sprintIssues.filter((t) => t.status === "in_progress").length,
          blocked: sprintIssues.filter((t) => t.status === "blocked").length,
          todo: sprintIssues.filter((t) => t.status === "todo").length,
        };
      }

      // 9. Tasks without goal linkage
      const tasksWithoutGoal = taskRows.filter(
        (t) => !t.goalId && t.status !== "done" && t.status !== "cancelled",
      ).length;

      return {
        timestamp: now.toISOString(),
        agents: {
          byStatus: {
            running: agentsByStatus.running.length,
            idle: agentsByStatus.idle.length,
            error: agentsByStatus.error.length,
            paused: agentsByStatus.paused.length,
          },
          errorAgents: agentsByStatus.error.map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            lastHeartbeatAt: a.lastHeartbeatAt,
          })),
          disabledAutoAssign: agentList.filter((a) => !a.qualityAutoAssign).map((a) => ({
            id: a.id,
            name: a.name,
            qualityScore: a.qualityScore,
          })),
        },
        tasks: {
          byStatus: {
            todo: tasksByStatus.todo.length,
            in_progress: tasksByStatus.in_progress.length,
            blocked: tasksByStatus.blocked.length,
            in_review: tasksByStatus.in_review.length,
            done: tasksByStatus.done.length,
          },
          blocked: blockedTasks,
          inReview: reviewTasks,
          stale: staleTasks.map((t) => ({
            id: t.id,
            identifier: t.identifier,
            title: t.title,
            status: t.status,
            assignee: t.assigneeAgentId ? agentNameMap[t.assigneeAgentId] ?? null : null,
            updatedAt: t.updatedAt?.toISOString() ?? null,
          })),
          unassigned: unassignedTasks,
          recentCompletions: recentDone,
          withoutGoal: tasksWithoutGoal,
        },
        sprint: sprintSummary,
      };
    },

    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
      };
    },
  };
}
