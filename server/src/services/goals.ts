import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { goals, issues } from "@zeroinc/db";

type GoalReader = Pick<Db, "select">;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) =>
      db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof goals.$inferInsert>) =>
      db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    /**
     * Get progress for a goal based on linked issues.
     * Returns counts by status, completion %, velocity, and estimated completion.
     */
    getProgress: async (goalId: string) => {
      const goal = await db
        .select()
        .from(goals)
        .where(eq(goals.id, goalId))
        .then((rows) => rows[0] ?? null);
      if (!goal) return null;

      // Count issues by status for this goal (including child goals' issues)
      const childGoalIds = await db
        .select({ id: goals.id })
        .from(goals)
        .where(eq(goals.parentId, goalId))
        .then((rows) => rows.map((r) => r.id));

      const allGoalIds = [goalId, ...childGoalIds];

      const statusRows = await db
        .select({
          status: issues.status,
          count: sql<number>`count(*)`,
        })
        .from(issues)
        .where(
          and(
            inArray(issues.goalId, allGoalIds),
            sql`${issues.status} != 'cancelled'`,
          ),
        )
        .groupBy(issues.status);

      const byStatus: Record<string, number> = {
        backlog: 0, todo: 0, in_progress: 0, blocked: 0,
        in_review: 0, done: 0,
      };
      let total = 0;
      let done = 0;
      for (const row of statusRows) {
        const count = Number(row.count);
        byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
        total += count;
        if (row.status === "done") done += count;
      }

      const completionPercent = total > 0 ? Math.round((done / total) * 100) : 0;

      // Velocity: issues completed per day over last 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [velocityRow] = await db
        .select({
          count: sql<number>`count(*)`,
        })
        .from(issues)
        .where(
          and(
            inArray(issues.goalId, allGoalIds),
            eq(issues.status, "done"),
            gte(issues.completedAt, sevenDaysAgo),
          ),
        );

      const completedLast7Days = Number(velocityRow?.count ?? 0);
      const velocityPerDay = completedLast7Days / 7;

      // Estimated completion (remaining issues / velocity)
      const remaining = total - done;
      let estimatedDaysToComplete: number | null = null;
      if (velocityPerDay > 0 && remaining > 0) {
        estimatedDaysToComplete = Math.ceil(remaining / velocityPerDay);
      }

      return {
        goalId,
        goalTitle: goal.title,
        goalLevel: goal.level,
        goalStatus: goal.status,
        totalIssues: total,
        byStatus,
        done,
        remaining,
        completionPercent,
        velocityPerDay: Math.round(velocityPerDay * 100) / 100,
        completedLast7Days,
        estimatedDaysToComplete,
      };
    },
  };
}
