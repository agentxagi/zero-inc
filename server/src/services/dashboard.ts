import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issueWorkProducts, issues, sprints } from "@zeroinc/db";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import {
  inferReviewLaneForIssue,
  reviewSlaDueAtForLane,
  reviewSlaHoursForLane,
  reviewSlaStateForDueAt,
} from "./review-pipeline.js";
import { isOperationalNoiseIssue } from "./product-council.js";

const READINESS_WINDOW_DAYS = 30;
const READINESS_WEEKLY_SERIES_WEEKS = 4;
const READINESS_OUTPUT_ROOT = "/opt/paperclip/outputs";
const OPS_SHARE_TARGET_PERCENT = 20;
const CANCELLATION_TARGET_PERCENT = 15;
const RUNNING_LOCAL_PROCESSES_PASS_LIMIT = 40;
const RUNNING_LOCAL_PROCESSES_WARN_LIMIT = 80;

type ReadinessIssueRow = {
  title: string;
  originKind: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
};

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function countOutputFilesByDay(startDayUtc: Date, totalDays: number, root = READINESS_OUTPUT_ROOT) {
  const counts = new Map<string, number>();
  for (let i = 0; i < totalDays; i += 1) {
    const day = addDays(startDayUtc, i);
    const key = dayKey(day);
    const dayDir = join(root, key);
    if (!existsSync(dayDir)) {
      counts.set(key, 0);
      continue;
    }
    let fileCount = 0;
    for (const entry of readdirSync(dayDir, { withFileTypes: true })) {
      if (entry.isFile()) fileCount += 1;
    }
    counts.set(key, fileCount);
  }
  return counts;
}

function makeReadinessCheck<TDetails extends Record<string, unknown>>(
  status: "pass" | "warning" | "fail",
  title: string,
  description: string,
  details: TDetails,
) {
  return {
    status,
    pass: status === "pass",
    title,
    description,
    details,
  };
}

function isProductIssue(issue: Pick<ReadinessIssueRow, "title" | "originKind">): boolean {
  return !isOperationalNoiseIssue(issue);
}

function hasExecutionCoverageProxy(
  issue: Pick<ReadinessIssueRow, "status" | "createdAt" | "startedAt" | "completedAt" | "cancelledAt">,
  dayStart: Date,
  dayEndExclusive: Date,
): boolean {
  if (issue.createdAt >= dayEndExclusive) return false;
  if (issue.completedAt && issue.completedAt < dayStart) return false;
  if (issue.cancelledAt && issue.cancelledAt < dayStart) return false;
  if (issue.startedAt) return issue.startedAt < dayEndExclusive;
  return issue.status === "todo" || issue.status === "in_progress";
}

async function buildOperationalReadinessSummary(db: Db, companyId: string, now = new Date()) {
  const todayUtc = startOfUtcDay(now);
  const weeklyStartUtc = addDays(todayUtc, -(READINESS_WEEKLY_SERIES_WEEKS * 7 - 1));
  const windowStart = addDays(todayUtc, -(READINESS_WINDOW_DAYS - 1));
  const sevenDaysAgo = addDays(todayUtc, -6);

  const issueRows = await db
    .select({
      title: issues.title,
      originKind: issues.originKind,
      status: issues.status,
      createdAt: issues.createdAt,
      startedAt: issues.startedAt,
      completedAt: issues.completedAt,
      cancelledAt: issues.cancelledAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        sql`${issues.hiddenAt} is null`,
        sql`(
          ${issues.createdAt} >= ${windowStart}
          or ${issues.updatedAt} >= ${windowStart}
          or ${issues.completedAt} >= ${windowStart}
          or ${issues.cancelledAt} >= ${windowStart}
          or ${issues.status} in ('todo', 'in_progress')
        )`,
      ),
    );

  const workProductRows = await db
    .select({ createdAt: issueWorkProducts.createdAt })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, companyId),
        gte(issueWorkProducts.createdAt, weeklyStartUtc),
      ),
    );

  const runRowsLast7Days = await db
    .select({
      processPid: heartbeatRuns.processPid,
      processLossRetryCount: heartbeatRuns.processLossRetryCount,
      errorCode: heartbeatRuns.errorCode,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        gte(heartbeatRuns.createdAt, sevenDaysAgo),
      ),
    );

  const runningLocalProcesses = await db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "running"),
        sql`${heartbeatRuns.processPid} is not null`,
      ),
    )
    .then((rows) => Number(rows[0]?.count ?? 0));

  const outputsByDay = countOutputFilesByDay(weeklyStartUtc, READINESS_WEEKLY_SERIES_WEEKS * 7);
  const workProductsByDay = new Map<string, number>();
  for (const row of workProductRows) {
    const key = dayKey(row.createdAt);
    workProductsByDay.set(key, (workProductsByDay.get(key) ?? 0) + 1);
  }

  const weeklySeries = [];
  for (let weekOffset = READINESS_WEEKLY_SERIES_WEEKS - 1; weekOffset >= 0; weekOffset -= 1) {
    const start = addDays(todayUtc, -(weekOffset * 7 + 6));
    const endExclusive = addDays(start, 7);
    let outputs = 0;
    let workProducts = 0;
    for (let cursor = new Date(start.getTime()); cursor < endExclusive; cursor = addDays(cursor, 1)) {
      const key = dayKey(cursor);
      outputs += outputsByDay.get(key) ?? 0;
      workProducts += workProductsByDay.get(key) ?? 0;
    }
    const endInclusive = addDays(endExclusive, -1);
    weeklySeries.push({
      label: `${start.toISOString().slice(5, 10)}..${endInclusive.toISOString().slice(5, 10)}`,
      outputs,
      workProducts,
      total: outputs + workProducts,
    });
  }

  let transitionsNonDecreasing = 0;
  for (let i = 1; i < weeklySeries.length; i += 1) {
    if (weeklySeries[i]!.total >= weeklySeries[i - 1]!.total) transitionsNonDecreasing += 1;
  }
  const latestWeeklyTotal = weeklySeries[weeklySeries.length - 1]?.total ?? 0;
  const deliverablesGrowthStatus =
    latestWeeklyTotal === 0
      ? "fail"
      : transitionsNonDecreasing >= 2
        ? "pass"
        : "warning";
  const deliverablesGrowth = makeReadinessCheck(
    deliverablesGrowthStatus,
    "Weekly Deliverables Growth",
    deliverablesGrowthStatus === "pass"
      ? "Entregáveis semanais com tendência de crescimento consistente."
      : deliverablesGrowthStatus === "warning"
        ? "Entregáveis ativos, porém com crescimento inconsistente entre semanas."
        : "Sem sinal de entregáveis recentes em outputs/work products.",
    {
      transitionsNonDecreasing,
      latestWeeklyTotal,
      series: weeklySeries,
    },
  );

  const productIssues = issueRows.filter((issue) => isProductIssue(issue));
  let daysWithExecutionProxy = 0;
  for (let i = 0; i < READINESS_WINDOW_DAYS; i += 1) {
    const dayStart = addDays(windowStart, i);
    const dayEndExclusive = addDays(dayStart, 1);
    const hasCoverage = productIssues.some((issue) =>
      hasExecutionCoverageProxy(issue, dayStart, dayEndExclusive));
    if (hasCoverage) daysWithExecutionProxy += 1;
  }
  const daysWithoutExecutionProxy = READINESS_WINDOW_DAYS - daysWithExecutionProxy;
  const currentTodoOrInProgressProduct = productIssues.filter(
    (issue) => issue.status === "todo" || issue.status === "in_progress",
  ).length;
  const executionContinuityStatus =
    daysWithoutExecutionProxy === 0
      ? "pass"
      : daysWithoutExecutionProxy <= 2
        ? "warning"
        : "fail";
  const executionContinuity = makeReadinessCheck(
    executionContinuityStatus,
    "Product Execution Continuity",
    executionContinuityStatus === "pass"
      ? "Sem lacunas de execução de produto detectadas na janela."
      : executionContinuityStatus === "warning"
        ? "Pequenas lacunas de continuidade detectadas na janela."
        : "Lacunas relevantes de continuidade de execução de produto.",
    {
      daysWithExecutionProxy,
      daysWithoutExecutionProxy,
      totalDays: READINESS_WINDOW_DAYS,
      currentTodoOrInProgressProduct,
    },
  );

  const doneLast30Days = issueRows.filter(
    (issue) => issue.status === "done" && issue.completedAt && issue.completedAt >= windowStart,
  );
  const opsDoneLast30Days = doneLast30Days.filter((issue) => isOperationalNoiseIssue(issue));
  const opsSharePercent = doneLast30Days.length > 0
    ? Math.round((opsDoneLast30Days.length / doneLast30Days.length) * 100)
    : 0;
  const opsNoiseShareStatus =
    doneLast30Days.length === 0
      ? "warning"
      : opsSharePercent <= OPS_SHARE_TARGET_PERCENT
        ? "pass"
        : opsSharePercent <= 30
          ? "warning"
          : "fail";
  const opsNoiseShare = makeReadinessCheck(
    opsNoiseShareStatus,
    "OPS Meta-Task Share",
    opsNoiseShareStatus === "pass"
      ? "Share de tarefas OPS/meta dentro do alvo."
      : opsNoiseShareStatus === "warning"
        ? "Share de OPS/meta acima do ideal, mas ainda controlável."
        : "Share de OPS/meta alto demais para o objetivo de produto.",
    {
      opsSharePercent,
      thresholdPercent: OPS_SHARE_TARGET_PERCENT,
      totalDoneLast30Days: doneLast30Days.length,
      opsDoneLast30Days: opsDoneLast30Days.length,
    },
  );

  const cancelledLast30Days = issueRows.filter(
    (issue) => issue.status === "cancelled" && issue.cancelledAt && issue.cancelledAt >= windowStart,
  );
  const terminalIssuesLast30Days = doneLast30Days.length + cancelledLast30Days.length;
  const cancellationRatePercent = terminalIssuesLast30Days > 0
    ? Number(((cancelledLast30Days.length / terminalIssuesLast30Days) * 100).toFixed(1))
    : 0;
  const cancellationRateStatus =
    terminalIssuesLast30Days === 0
      ? "warning"
      : cancellationRatePercent < CANCELLATION_TARGET_PERCENT
        ? "pass"
        : cancellationRatePercent < 25
          ? "warning"
          : "fail";
  const cancellationRate = makeReadinessCheck(
    cancellationRateStatus,
    "Cancellation Rate",
    cancellationRateStatus === "pass"
      ? "Taxa de cancelamento dentro da meta."
      : cancellationRateStatus === "warning"
        ? "Taxa de cancelamento pede ajuste de priorização/discovery."
        : "Taxa de cancelamento alta para operação estável.",
    {
      cancellationRatePercent,
      thresholdPercent: CANCELLATION_TARGET_PERCENT,
      doneLast30Days: doneLast30Days.length,
      cancelledLast30Days: cancelledLast30Days.length,
    },
  );

  const detachedTimeoutRunsLast7Days = runRowsLast7Days.filter(
    (row) => row.errorCode === "process_detached_timeout",
  ).length;
  const processLossRetriesLast7Days = runRowsLast7Days.reduce(
    (sum, row) => sum + Math.max(0, Number(row.processLossRetryCount ?? 0)),
    0,
  );
  const localRunsLast7Days = runRowsLast7Days.filter((row) => row.processPid != null).length;
  const localProcessHealthStatus =
    detachedTimeoutRunsLast7Days === 0 && runningLocalProcesses <= RUNNING_LOCAL_PROCESSES_PASS_LIMIT
      ? "pass"
      : detachedTimeoutRunsLast7Days <= 2 && runningLocalProcesses <= RUNNING_LOCAL_PROCESSES_WARN_LIMIT
        ? "warning"
        : "fail";
  const localProcessHealth = makeReadinessCheck(
    localProcessHealthStatus,
    "Local Process Health",
    localProcessHealthStatus === "pass"
      ? "Sem recorrência relevante de órfãos/detached nas últimas execuções."
      : localProcessHealthStatus === "warning"
        ? "Sinais leves de pressão em processos locais; manter vigilância."
        : "Risco operacional elevado de processos locais órfãos/pressionando memória.",
    {
      runningLocalProcesses,
      detachedTimeoutRunsLast7Days,
      processLossRetriesLast7Days,
      localRunsLast7Days,
    },
  );

  const checks = [
    deliverablesGrowth.status,
    executionContinuity.status,
    opsNoiseShare.status,
    cancellationRate.status,
    localProcessHealth.status,
  ];
  const passedChecks = checks.filter((status) => status === "pass").length;
  const warningChecks = checks.filter((status) => status === "warning").length;
  const failedChecks = checks.filter((status) => status === "fail").length;
  const totalChecks = checks.length;
  const score = Math.round(((passedChecks + warningChecks * 0.5) / totalChecks) * 100);
  const status = failedChecks > 0 ? "critical" : warningChecks > 0 ? "warning" : "healthy";

  return {
    generatedAt: now.toISOString(),
    windowDays: READINESS_WINDOW_DAYS,
    status,
    score,
    checks: {
      deliverablesGrowth,
      executionContinuity,
      opsNoiseShare,
      cancellationRate,
      localProcessHealth,
    },
    summary: {
      passedChecks,
      warningChecks,
      failedChecks,
      totalChecks,
    },
  };
}

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
          reviewRequestedAt: issues.reviewRequestedAt,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          updatedAt: issues.updatedAt,
          description: issues.description,
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
        reviewLane: inferReviewLaneForIssue({ title: t.title, description: t.description }),
        id: t.id,
        identifier: t.identifier,
        title: t.title,
        assignee: t.assigneeAgentId ? agentNameMap[t.assigneeAgentId] ?? null : null,
        reviewer: t.reviewerAgentId ? agentNameMap[t.reviewerAgentId] ?? null : null,
        reviewRequestedAt: t.reviewRequestedAt?.toISOString() ?? null,
        startedAt: t.startedAt?.toISOString() ?? null,
      })).map((row) => {
        const slaHours = reviewSlaHoursForLane(row.reviewLane);
        const reviewRequestedAt = row.reviewRequestedAt ? new Date(row.reviewRequestedAt) : null;
        const slaDueAt = reviewSlaDueAtForLane(row.reviewLane, reviewRequestedAt);
        return {
          ...row,
          reviewSlaHours: slaHours,
          reviewSlaDueAt: slaDueAt?.toISOString() ?? null,
          reviewSlaState: reviewSlaStateForDueAt(slaDueAt, now),
        };
      });

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
      const operationalReadiness = await buildOperationalReadinessSummary(db, companyId, now);

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
        operationalReadiness,
      };
    },
  };
}
