import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { instanceSettings, agents, issues } from "@zeroinc/db";
import { logger } from "../middleware/logger.js";

const GOVERNANCE_SINGLETON_KEY = "governance";

export interface GovernanceSettings {
  wipLimitDefault: number;
  staleInProgressWarnMinutes: number;
  staleInProgressBlockMinutes: number;
  staleBlockedEscalateMinutes: number;
  staleInReviewPingMinutes: number;
  staleDoneNoQualityMinutes: number;
}

export interface AgentGovernanceSettings {
  wipLimit?: number | null;
  staleOverrides?: Partial<Omit<GovernanceSettings, "wipLimitDefault">> | null;
}

export const DEFAULT_GOVERNANCE_SETTINGS: GovernanceSettings = {
  wipLimitDefault: 3,
  staleInProgressWarnMinutes: 120,
  staleInProgressBlockMinutes: 480,
  staleBlockedEscalateMinutes: 120,
  staleInReviewPingMinutes: 60,
  staleDoneNoQualityMinutes: 60,
};

function normalizeGovernanceSettings(raw: unknown): GovernanceSettings {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return {
      wipLimitDefault: typeof obj.wipLimitDefault === "number" && obj.wipLimitDefault > 0
        ? obj.wipLimitDefault
        : DEFAULT_GOVERNANCE_SETTINGS.wipLimitDefault,
      staleInProgressWarnMinutes: typeof obj.staleInProgressWarnMinutes === "number" && obj.staleInProgressWarnMinutes > 0
        ? obj.staleInProgressWarnMinutes
        : DEFAULT_GOVERNANCE_SETTINGS.staleInProgressWarnMinutes,
      staleInProgressBlockMinutes: typeof obj.staleInProgressBlockMinutes === "number" && obj.staleInProgressBlockMinutes > 0
        ? obj.staleInProgressBlockMinutes
        : DEFAULT_GOVERNANCE_SETTINGS.staleInProgressBlockMinutes,
      staleBlockedEscalateMinutes: typeof obj.staleBlockedEscalateMinutes === "number" && obj.staleBlockedEscalateMinutes > 0
        ? obj.staleBlockedEscalateMinutes
        : DEFAULT_GOVERNANCE_SETTINGS.staleBlockedEscalateMinutes,
      staleInReviewPingMinutes: typeof obj.staleInReviewPingMinutes === "number" && obj.staleInReviewPingMinutes > 0
        ? obj.staleInReviewPingMinutes
        : DEFAULT_GOVERNANCE_SETTINGS.staleInReviewPingMinutes,
      staleDoneNoQualityMinutes: typeof obj.staleDoneNoQualityMinutes === "number" && obj.staleDoneNoQualityMinutes > 0
        ? obj.staleDoneNoQualityMinutes
        : DEFAULT_GOVERNANCE_SETTINGS.staleDoneNoQualityMinutes,
    };
  }
  return { ...DEFAULT_GOVERNANCE_SETTINGS };
}

function normalizeAgentGovernanceOverrides(raw: unknown): AgentGovernanceSettings {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return {
      wipLimit: typeof obj.wipLimit === "number" ? obj.wipLimit : null,
      staleOverrides: typeof obj.staleOverrides === "object" && obj.staleOverrides !== null
        ? obj.staleOverrides as Partial<Omit<GovernanceSettings, "wipLimitDefault">>
        : null,
    };
  }
  return { wipLimit: null, staleOverrides: null };
}

export function governanceSettingsService(db: Db) {
  async function getOrCreateRow() {
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, GOVERNANCE_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({
        singletonKey: GOVERNANCE_SINGLETON_KEY,
        general: { ...DEFAULT_GOVERNANCE_SETTINGS },
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: { updatedAt: now },
      })
      .returning();
    return created;
  }

  async function get(): Promise<GovernanceSettings> {
    const row = await getOrCreateRow();
    return normalizeGovernanceSettings(row.general);
  }

  async function update(patch: Partial<GovernanceSettings>): Promise<GovernanceSettings> {
    const current = await getOrCreateRow();
    const currentSettings = normalizeGovernanceSettings(current.general);
    const next = { ...currentSettings, ...patch };
    const now = new Date();
    await db
      .update(instanceSettings)
      .set({ general: { ...next }, updatedAt: now })
      .where(eq(instanceSettings.id, current.id));
    return next;
  }

  async function getAgentSettings(agentId: string): Promise<AgentGovernanceSettings> {
    const agent = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent?.metadata) return { wipLimit: null, staleOverrides: null };
    const meta = agent.metadata as Record<string, unknown>;
    return normalizeAgentGovernanceOverrides(meta.governance);
  }

  async function updateAgentSettings(agentId: string, patch: Partial<AgentGovernanceSettings>): Promise<AgentGovernanceSettings> {
    const agent = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw new Error("Agent not found");

    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    const current = normalizeAgentGovernanceOverrides(meta.governance);
    const next = { ...current, ...patch };
    meta.governance = next;

    await db
      .update(agents)
      .set({ metadata: meta, updatedAt: new Date() })
      .where(eq(agents.id, agentId));
    return next;
  }

  async function getWipLimitForAgent(agentId: string): Promise<number> {
    const agentSettings = await getAgentSettings(agentId);
    if (agentSettings.wipLimit && agentSettings.wipLimit > 0) {
      return agentSettings.wipLimit;
    }
    const global = await get();
    return global.wipLimitDefault;
  }

  async function countInProgressForAgent(agentId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(issues)
      .where(
        sql`${issues.assigneeAgentId} = ${agentId} AND ${issues.status} = 'in_progress' AND ${issues.hiddenAt} IS NULL`,
      )
      .then((rows) => rows[0]);
    return result?.count ?? 0;
  }

  return {
    get,
    update,
    getAgentSettings,
    updateAgentSettings,
    getWipLimitForAgent,
    countInProgressForAgent,
  };
}

export type GovernanceSettingsService = ReturnType<typeof governanceSettingsService>;
