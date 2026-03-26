import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { goals, issueWorkProducts, issues } from "@zeroinc/db";

type GoalReader = Pick<Db, "select">;

export type MacroProgramKey = "open_source" | "enterprise" | "operating_model";

type MacroProgramDefinition = {
  key: MacroProgramKey;
  title: string;
  description: string;
  cycleTitle: string;
};

const MACRO_PROGRAM_DEFINITIONS: readonly MacroProgramDefinition[] = [
  {
    key: "open_source",
    title: "[PROGRAM] Open Source Evolution",
    description:
      "Programa permanente para melhorar experiência OSS, docs públicas, onboarding e adoção da comunidade.",
    cycleTitle: "Open Source Delivery Cycle",
  },
  {
    key: "enterprise",
    title: "[PROGRAM] Enterprise Evolution",
    description:
      "Programa permanente para endurecimento enterprise, governança, segurança e operação de produção.",
    cycleTitle: "Enterprise Delivery Cycle",
  },
  {
    key: "operating_model",
    title: "[PROGRAM] Operating Model Evolution",
    description:
      "Programa permanente para elevar autonomia, qualidade, fluxo e governança do sistema multiagente.",
    cycleTitle: "Operating Model Delivery Cycle",
  },
];

const MACRO_PROGRAM_MARKER_PREFIX = "zeroinc:macro_program=";
const MACRO_PROGRAM_CYCLE_MARKER_PREFIX = "zeroinc:program_cycle=";
const ENGINEERING_PREFIXES = new Set(["BUG", "FEATURE", "CODE", "INFRA", "SHIP", "ENTERPRISE", "OPEN SOURCE", "BUILD"]);
const QUALIFYING_WORK_PRODUCT_STATUSES = ["active", "ready_for_review", "approved", "merged", "closed"] as const;

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function extractPrefix(title: string): string | null {
  const match = title.match(/^\s*\[([^\]]+)\]/);
  return match ? match[1]!.trim().toUpperCase() : null;
}

function isEngineeringOutcomeTitle(title: string): boolean {
  const prefix = extractPrefix(title);
  return prefix != null && ENGINEERING_PREFIXES.has(prefix);
}

function macroProgramMarker(key: MacroProgramKey): string {
  return `<!-- ${MACRO_PROGRAM_MARKER_PREFIX}${key} -->`;
}

function macroProgramCycleMarker(cycleKey: string): string {
  return `<!-- ${MACRO_PROGRAM_CYCLE_MARKER_PREFIX}${cycleKey} -->`;
}

function hasMarker(value: string | null | undefined, marker: string): boolean {
  return normalizeText(value).includes(normalizeText(marker));
}

function isMacroProgramGoal(
  goal: Pick<typeof goals.$inferSelect, "description" | "title">,
  key: MacroProgramKey,
  expectedTitle: string,
): boolean {
  if (hasMarker(goal.description, macroProgramMarker(key))) return true;
  return normalizeText(goal.title) === normalizeText(expectedTitle);
}

function isMacroProgramCycleGoal(
  goal: Pick<typeof goals.$inferSelect, "description">,
  key: MacroProgramKey,
  cycleKey: string,
): boolean {
  return (
    hasMarker(goal.description, macroProgramMarker(key)) &&
    hasMarker(goal.description, macroProgramCycleMarker(cycleKey))
  );
}

function buildMacroProgramDescription(definition: MacroProgramDefinition): string {
  return `${definition.description}\n\n${macroProgramMarker(definition.key)}`;
}

function buildMacroProgramCycleDescription(definition: MacroProgramDefinition, cycleKey: string): string {
  return (
    `Quarterly cycle ${cycleKey} for macro program "${definition.title}".\n\n` +
    `${macroProgramMarker(definition.key)}\n` +
    `${macroProgramCycleMarker(cycleKey)}`
  );
}

export function quarterlyCycleKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

export interface MacroProgramState {
  key: MacroProgramKey;
  title: string;
  goalId: string | null;
  goalStatus: string | null;
  cycleKey: string;
  cycleGoalId: string | null;
  cycleGoalStatus: string | null;
}

export interface MacroProgramStateSummary {
  cycleKey: string;
  rootGoalId: string | null;
  programs: MacroProgramState[];
}

export interface EnsuredMacroProgramStateSummary extends MacroProgramStateSummary {
  rootCreated: boolean;
  createdProgramKeys: MacroProgramKey[];
  createdCycleKeys: MacroProgramKey[];
}

export async function listMacroProgramState(
  db: GoalReader,
  companyId: string,
  now: Date = new Date(),
): Promise<MacroProgramStateSummary> {
  const cycleKey = quarterlyCycleKey(now);
  const rootGoal = await getDefaultCompanyGoal(db, companyId);
  if (!rootGoal) {
    return {
      cycleKey,
      rootGoalId: null,
      programs: MACRO_PROGRAM_DEFINITIONS.map((definition) => ({
        key: definition.key,
        title: definition.title,
        goalId: null,
        goalStatus: null,
        cycleKey,
        cycleGoalId: null,
        cycleGoalStatus: null,
      })),
    };
  }

  const allGoals = await db
    .select()
    .from(goals)
    .where(eq(goals.companyId, companyId));
  const programGoals = allGoals.filter((goal) => goal.parentId === rootGoal.id);

  const programs = MACRO_PROGRAM_DEFINITIONS.map((definition) => {
    const program = programGoals.find((goal) =>
      isMacroProgramGoal(goal, definition.key, definition.title));
    const cycleGoals = program
      ? allGoals.filter((goal) => goal.parentId === program.id)
      : [];
    const currentCycleGoal = cycleGoals.find((goal) =>
      isMacroProgramCycleGoal(goal, definition.key, cycleKey));
    return {
      key: definition.key,
      title: definition.title,
      goalId: program?.id ?? null,
      goalStatus: program?.status ?? null,
      cycleKey,
      cycleGoalId: currentCycleGoal?.id ?? null,
      cycleGoalStatus: currentCycleGoal?.status ?? null,
    } satisfies MacroProgramState;
  });

  return {
    cycleKey,
    rootGoalId: rootGoal.id,
    programs,
  };
}

export async function ensureEvergreenMacroPrograms(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<EnsuredMacroProgramStateSummary> {
  const cycleKey = quarterlyCycleKey(now);
  let rootGoal = await getDefaultCompanyGoal(db, companyId);
  let rootCreated = false;
  const createdProgramKeys: MacroProgramKey[] = [];
  const createdCycleKeys: MacroProgramKey[] = [];

  if (!rootGoal) {
    const [createdRoot] = await db
      .insert(goals)
      .values({
        companyId,
        title: "ZeroInc Open Source & Enterprise",
        description:
          "Goal raiz permanente da companhia para evolução contínua de Open Source, Enterprise e Operating Model.",
        level: "company",
        status: "active",
        parentId: null,
      })
      .returning();
    rootGoal = createdRoot ?? null;
    rootCreated = Boolean(createdRoot);
  }

  if (!rootGoal) {
    return {
      cycleKey,
      rootGoalId: null,
      rootCreated,
      createdProgramKeys,
      createdCycleKeys,
      programs: MACRO_PROGRAM_DEFINITIONS.map((definition) => ({
        key: definition.key,
        title: definition.title,
        goalId: null,
        goalStatus: null,
        cycleKey,
        cycleGoalId: null,
        cycleGoalStatus: null,
      })),
    };
  }

  const allGoals = await db
    .select()
    .from(goals)
    .where(eq(goals.companyId, companyId));

  const mutableGoals = [...allGoals];
  const ensureProgramGoal = async (definition: MacroProgramDefinition) => {
    const existing = mutableGoals.find((goal) =>
      goal.parentId === rootGoal!.id &&
      isMacroProgramGoal(goal, definition.key, definition.title));
    if (existing) return existing;

    const [created] = await db
      .insert(goals)
      .values({
        companyId,
        title: definition.title,
        description: buildMacroProgramDescription(definition),
        level: "team",
        status: "active",
        parentId: rootGoal!.id,
      })
      .returning();

    if (created) {
      mutableGoals.push(created);
      createdProgramKeys.push(definition.key);
      return created;
    }
    return null;
  };

  const ensureCycleGoal = async (
    definition: MacroProgramDefinition,
    programGoal: typeof goals.$inferSelect | null,
  ) => {
    if (!programGoal) return null;
    const existingCycle = mutableGoals.find((goal) =>
      goal.parentId === programGoal.id &&
      isMacroProgramCycleGoal(goal, definition.key, cycleKey));
    if (existingCycle) return existingCycle;

    const [createdCycle] = await db
      .insert(goals)
      .values({
        companyId,
        title: `[CYCLE ${cycleKey}] ${definition.cycleTitle}`,
        description: buildMacroProgramCycleDescription(definition, cycleKey),
        level: "task",
        status: "active",
        parentId: programGoal.id,
      })
      .returning();

    if (createdCycle) {
      mutableGoals.push(createdCycle);
      createdCycleKeys.push(definition.key);
      return createdCycle;
    }
    return null;
  };

  const programs: MacroProgramState[] = [];
  for (const definition of MACRO_PROGRAM_DEFINITIONS) {
    const programGoal = await ensureProgramGoal(definition);
    const cycleGoal = await ensureCycleGoal(definition, programGoal);
    const currentCycleGoal = cycleGoal ?? mutableGoals.find((goal) =>
      goal.parentId === programGoal?.id &&
      isMacroProgramCycleGoal(goal, definition.key, cycleKey));
    programs.push({
      key: definition.key,
      title: definition.title,
      goalId: programGoal?.id ?? null,
      goalStatus: programGoal?.status ?? null,
      cycleKey,
      cycleGoalId: currentCycleGoal?.id ?? null,
      cycleGoalStatus: currentCycleGoal?.status ?? null,
    });
  }

  return {
    cycleKey,
    rootGoalId: rootGoal.id,
    rootCreated,
    createdProgramKeys,
    createdCycleKeys,
    programs,
  };
}

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
    listMacroPrograms: (companyId: string, now?: Date) => listMacroProgramState(db, companyId, now),
    ensureEvergreenMacroPrograms: (companyId: string, now?: Date) => ensureEvergreenMacroPrograms(db, companyId, now),

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
     * completionPercent and velocity are evidence-based:
     * a done issue only counts when it has a qualifying work product and required review.
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
      for (const row of statusRows) {
        const count = Number(row.count);
        byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
        total += count;
      }

      const doneIssues = await db
        .select({
          id: issues.id,
          title: issues.title,
          reviewCount: issues.reviewCount,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(
          and(
            inArray(issues.goalId, allGoalIds),
            eq(issues.status, "done"),
          ),
        );
      const doneIssueIds = doneIssues.map((issue) => issue.id);
      const qualifyingProducts = doneIssueIds.length === 0
        ? []
        : await db
          .select({
            issueId: issueWorkProducts.issueId,
          })
          .from(issueWorkProducts)
          .where(
            and(
              inArray(issueWorkProducts.issueId, doneIssueIds),
              inArray(issueWorkProducts.status, [...QUALIFYING_WORK_PRODUCT_STATUSES]),
            ),
          );
      const qualifyingIssueIdSet = new Set(qualifyingProducts.map((row) => row.issueId));
      const verifiedDoneIssues = doneIssues.filter((issue) => {
        const requiresReview = isEngineeringOutcomeTitle(issue.title);
        const hasRequiredReview = !requiresReview || issue.reviewCount > 0;
        return qualifyingIssueIdSet.has(issue.id) && hasRequiredReview;
      });

      const rawDone = doneIssues.length;
      const done = verifiedDoneIssues.length;
      const unverifiedDone = Math.max(0, rawDone - done);
      const rawCompletionPercent = total > 0 ? Math.round((rawDone / total) * 100) : 0;
      const completionPercent = total > 0 ? Math.round((done / total) * 100) : 0;

      // Velocity: issues completed per day over last 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const rawCompletedLast7Days = doneIssues.filter(
        (issue) => issue.completedAt && issue.completedAt >= sevenDaysAgo,
      ).length;
      const completedLast7Days = verifiedDoneIssues.filter(
        (issue) => issue.completedAt && issue.completedAt >= sevenDaysAgo,
      ).length;
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
        rawDone,
        unverifiedDone,
        remaining,
        completionPercent,
        rawCompletionPercent,
        velocityPerDay: Math.round(velocityPerDay * 100) / 100,
        completedLast7Days,
        rawCompletedLast7Days,
        estimatedDaysToComplete,
      };
    },
  };
}
