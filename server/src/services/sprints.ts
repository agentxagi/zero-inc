import { and, eq, gte, lte, sql, desc, asc } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { sprints, issues, agents } from "@zeroinc/db";

type SprintRow = typeof sprints.$inferSelect;

export function sprintService(db: Db) {
  return {
    list: async (companyId: string): Promise<SprintRow[]> => {
      return db
        .select()
        .from(sprints)
        .where(eq(sprints.companyId, companyId))
        .orderBy(desc(sprints.createdAt));
    },

    getById: async (id: string): Promise<SprintRow | null> => {
      const rows = await db
        .select()
        .from(sprints)
        .where(eq(sprints.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    create: async (
      companyId: string,
      data: Omit<typeof sprints.$inferInsert, "companyId" | "id" | "createdAt" | "updatedAt">,
    ): Promise<SprintRow> => {
      const rows = await db
        .insert(sprints)
        .values({ ...data, companyId })
        .returning();
      return rows[0]!;
    },

    update: async (
      id: string,
      data: Partial<typeof sprints.$inferInsert>,
    ): Promise<SprintRow | null> => {
      const rows = await db
        .update(sprints)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(sprints.id, id))
        .returning();
      return rows[0] ?? null;
    },

    remove: async (id: string): Promise<SprintRow | null> => {
      const rows = await db
        .delete(sprints)
        .where(eq(sprints.id, id))
        .returning();
      return rows[0] ?? null;
    },

    getIssues: async (sprintId: string): Promise<typeof issues.$inferSelect[]> => {
      return db
        .select()
        .from(issues)
        .where(eq(issues.sprintId, sprintId))
        .orderBy(asc(issues.createdAt));
    },

    getBurndown: async (sprintId: string): Promise<Array<{ date: string; created: number; completed: number; remaining: number }>> => {
      const sprint = await db
        .select()
        .from(sprints)
        .where(eq(sprints.id, sprintId))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!sprint || !sprint.startDate || !sprint.endDate) return [];

      const startDate = new Date(sprint.startDate);
      const endDate = new Date(sprint.endDate);

      // Count issues created per day within sprint range
      const createdPerDay = await db
        .select({
          date: sql<string>`DATE(${issues.createdAt})`.as("date"),
          count: sql<number>`COUNT(*)`.as("count"),
        })
        .from(issues)
        .where(
          and(
            eq(issues.sprintId, sprintId),
            gte(issues.createdAt, startDate),
            lte(issues.createdAt, endDate),
          ),
        )
        .groupBy(sql`DATE(${issues.createdAt})`)
        .orderBy(sql`DATE(${issues.createdAt})`);

      // Count issues completed per day within sprint range
      const completedPerDay = await db
        .select({
          date: sql<string>`DATE(${issues.completedAt})`.as("date"),
          count: sql<number>`COUNT(*)`.as("count"),
        })
        .from(issues)
        .where(
          and(
            eq(issues.sprintId, sprintId),
            eq(issues.status, "done"),
            gte(issues.completedAt, startDate),
            lte(issues.completedAt, endDate),
          ),
        )
        .groupBy(sql`DATE(${issues.completedAt})`)
        .orderBy(sql`DATE(${issues.completedAt})`);

      const createdMap = new Map(createdPerDay.map((r) => [r.date, r.count]));
      const completedMap = new Map(completedPerDay.map((r) => [r.date, r.count]));

      const points: Array<{ date: string; created: number; completed: number; remaining: number }> = [];
      let remaining = 0;
      const cursor = new Date(startDate);

      while (cursor <= endDate) {
        const dateStr = cursor.toISOString().split("T")[0]!;
        const created = createdMap.get(dateStr) ?? 0;
        const completed = completedMap.get(dateStr) ?? 0;
        remaining = remaining + created - completed;
        if (remaining < 0) remaining = 0;
        points.push({ date: dateStr, created, completed, remaining });
        cursor.setDate(cursor.getDate() + 1);
      }

      return points;
    },

    getVelocity: async (sprintId: string): Promise<Array<{
      agentId: string;
      agentName: string;
      completedCount: number;
      avgCycleTimeHours: number | null;
    }>> => {
      const completed = await db
        .select({
          agentId: issues.assigneeAgentId,
          createdAt: issues.createdAt,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.sprintId, sprintId),
            eq(issues.status, "done"),
          ),
        );

      if (completed.length === 0) return [];

      const agentMap = new Map<string, { count: number; totalHours: number; name: string }>();
      const agentIds = [...new Set(completed.map((i) => i.agentId).filter(Boolean))] as string[];

      if (agentIds.length > 0) {
        const agentRows = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(sql`${agents.id} IN ${agentIds}`);
        const nameMap = new Map(agentRows.map((r) => [r.id, r.name]));

        for (const issue of completed) {
          if (!issue.agentId) continue;
          const name = nameMap.get(issue.agentId) ?? "Unknown";
          const existing = agentMap.get(issue.agentId);
          const cycleMs = issue.completedAt && issue.createdAt
            ? new Date(issue.completedAt).getTime() - new Date(issue.createdAt).getTime()
            : null;
          const cycleHours = cycleMs !== null ? cycleMs / (1000 * 60 * 60) : null;

          if (existing) {
            existing.count++;
            if (cycleHours !== null) existing.totalHours += cycleHours;
          } else {
            agentMap.set(issue.agentId, {
              count: 1,
              totalHours: cycleHours ?? 0,
              name,
            });
          }
        }
      }

      return Array.from(agentMap.entries()).map(([agentId, data]) => ({
        agentId,
        agentName: data.name,
        completedCount: data.count,
        avgCycleTimeHours: data.count > 0 ? Math.round((data.totalHours / data.count) * 10) / 10 : null,
      }));
    },
  };
}
