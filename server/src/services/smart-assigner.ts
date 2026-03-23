import { eq, sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agents, issues } from "@zeroinc/db";
import { governanceSettingsService } from "./governance-settings.js";
import { logger } from "../middleware/logger.js";

/**
 * Maps label names to preferred agent roles.
 * Used by the smart assigner when delegation rules produce no match.
 */
const LABEL_TO_ROLE_MAP: Record<string, string[]> = {
  bug: ["engineer", "devops"],
  infrastructure: ["devops"],
  frontend: ["engineer"],
  backend: ["engineer"],
  design: ["designer"],
  research: ["researcher", "pm"],
  operations: ["pm"],
};

interface AgentCandidate {
  id: string;
  name: string;
  role: string;
  qualityScore: number | null;
  qualityAutoAssign: boolean;
  inProgressCount: number;
}

export function smartAssignerService(db: Db) {
  const govSvc = governanceSettingsService(db);

  /**
   * Find the best agent for an issue based on labels, quality, and workload.
   * Returns null only if no eligible agent exists at all.
   */
  async function assign(companyId: string, opts: {
    labelNames?: string[];
    excludeAgentIds?: string[];
  }): Promise<AgentCandidate | null> {
    const labels = (opts.labelNames ?? []).map((l) => l.toLowerCase());

    // Determine target roles from labels
    const targetRoles = new Set<string>();
    for (const label of labels) {
      const roles = LABEL_TO_ROLE_MAP[label];
      if (roles) {
        for (const r of roles) targetRoles.add(r);
      }
    }

    // Fetch all active agents in the company
    const agentRows = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        qualityScore: agents.qualityScore,
        qualityAutoAssign: agents.qualityAutoAssign,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    // Filter eligible candidates
    const candidates: AgentCandidate[] = [];
    for (const row of agentRows) {
      if (row.status !== "active") continue;
      if (opts.excludeAgentIds?.includes(row.id)) continue;
      if (!row.qualityAutoAssign) continue;
      if ((row.qualityScore ?? 0) < 40) continue;
      if (targetRoles.size > 0 && !targetRoles.has(row.role ?? "")) continue;

      const inProgressCount = await govSvc.countInProgressForAgent(row.id);
      const wipLimit = await govSvc.getWipLimitForAgent(row.id);
      if (inProgressCount >= wipLimit) continue;

      candidates.push({
        id: row.id,
        name: row.name,
        role: row.role ?? "",
        qualityScore: row.qualityScore,
        qualityAutoAssign: row.qualityAutoAssign,
        inProgressCount,
      });
    }

    // Fallback: if no label-based candidates found, try any active agent with auto-assign
    // (ignoring role match but still requiring quality >= 40)
    if (candidates.length === 0 && targetRoles.size > 0) {
      for (const row of agentRows) {
        if (row.status !== "active") continue;
        if (opts.excludeAgentIds?.includes(row.id)) continue;
        if (!row.qualityAutoAssign) continue;
        if ((row.qualityScore ?? 0) < 40) continue;
        // Skip agents that already failed the role filter above
        if (targetRoles.has(row.role ?? "")) continue;

        const inProgressCount = await govSvc.countInProgressForAgent(row.id);
        const wipLimit = await govSvc.getWipLimitForAgent(row.id);
        if (inProgressCount >= wipLimit) continue;

        candidates.push({
          id: row.id,
          name: row.name,
          role: row.role ?? "",
          qualityScore: row.qualityScore,
          qualityAutoAssign: row.qualityAutoAssign,
          inProgressCount,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Sort: highest quality first, then lowest workload
    candidates.sort((a, b) => {
      const scoreDiff = (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return a.inProgressCount - b.inProgressCount;
    });

    return candidates[0];
  }

  /**
   * Assign a specific issue to the best agent.
   * Returns the agent ID that was assigned, or null.
   */
  async function assignIssue(issueId: string, companyId: string): Promise<string | null> {
    // Get issue labels
    const labelRows = await db
      .select({ name: sql<string>`l.name` })
      .from(sql`issue_labels il`)
      .innerJoin(sql`labels l`, sql`il.label_id = l.id`)
      .where(sql`il.issue_id = ${issueId}`);

    const labelNames = labelRows.map((r) => r.name);

    // Get current assignee to exclude
    const [issue] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));

    const excludeIds = issue?.assigneeAgentId ? [issue.assigneeAgentId] : [];

    const candidate = await assign(companyId, { labelNames, excludeAgentIds: excludeIds });
    if (!candidate) {
      logger.info(`[smart-assigner] No eligible agent found for issue ${issueId}`);
      return null;
    }

    // Assign the issue
    await db
      .update(issues)
      .set({
        assigneeAgentId: candidate.id,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    logger.info(`[smart-assigner] Assigned issue ${issueId} to ${candidate.name} (role=${candidate.role}, score=${candidate.qualityScore})`);
    return candidate.id;
  }

  return { assign, assignIssue };
}

export type SmartAssignerService = ReturnType<typeof smartAssignerService>;
