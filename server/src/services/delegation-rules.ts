import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { delegationRules } from "@zeroinc/db";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

const VALID_RULE_TYPES = ["assign", "priority", "escalate"] as const;
const VALID_TRIGGERS = ["create", "status_change"] as const;

export interface RuleMatchContext {
  title: string;
  priority: string;
  status: string;
  statusChangedAt?: Date | null;
  previousStatus?: string;
}

export interface RuleAction {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  priority?: string | null;
  status?: string | null;
  commentBody?: string | null;
}

export function delegationRulesService(db: Db) {
  /**
   * Evaluate all enabled rules for a company against a given issue context.
   * Returns the first matching rule's action (rules are sorted by sortOrder, lower first).
   */
  async function evaluate(companyId: string, trigger: "create" | "status_change", ctx: RuleMatchContext): Promise<RuleAction | null> {
    const rules = await db
      .select()
      .from(delegationRules)
      .where(
        and(
          eq(delegationRules.companyId, companyId),
          eq(delegationRules.enabled, true),
          eq(delegationRules.triggerOn, trigger),
        ),
      )
      .orderBy(asc(delegationRules.sortOrder), asc(delegationRules.createdAt));

    for (const rule of rules) {
      const action = matchRule(rule, ctx);
      if (action) {
        logger.info(`[delegation] Rule "${rule.name}" (${rule.id}) matched for company ${companyId}`);
        return action;
      }
    }

    return null;
  }

  function matchRule(rule: typeof delegationRules.$inferSelect, ctx: RuleMatchContext): RuleAction | null {
    // Title pattern match (regex)
    if (rule.titlePattern) {
      try {
        const re = new RegExp(rule.titlePattern, "i");
        if (!re.test(ctx.title)) return null;
      } catch {
        logger.warn(`[delegation] Invalid regex in rule "${rule.name}": ${rule.titlePattern}`);
        return null;
      }
    }

    // Priority match
    if (rule.matchPriority && rule.matchPriority !== ctx.priority) {
      return null;
    }

    // Status match
    if (rule.matchStatus) {
      if (rule.ruleType === "escalate") {
        // For escalate rules, matchStatus is the status we're watching
        if (rule.matchStatus !== ctx.status) return null;
        // Check delay
        if (rule.delayMinutes && rule.delayMinutes > 0 && ctx.statusChangedAt) {
          const elapsed = Date.now() - ctx.statusChangedAt.getTime();
          const delayMs = rule.delayMinutes * 60 * 1000;
          if (elapsed < delayMs) return null;
        }
      } else {
        if (rule.matchStatus !== ctx.status) return null;
      }
    }

    // Build action
    const action: RuleAction = {};
    if (rule.ruleType === "assign") {
      action.assigneeAgentId = rule.assignToAgentId ?? null;
      action.assigneeUserId = rule.assignToUserId ?? null;
    }
    if (rule.ruleType === "priority" && rule.setPriority) {
      action.priority = rule.setPriority;
    }
    if (rule.ruleType === "escalate") {
      if (rule.setPriority) action.priority = rule.setPriority;
      if (rule.setStatus) action.status = rule.setStatus;
      if (rule.assignToAgentId) action.assigneeAgentId = rule.assignToAgentId;
      if (rule.assignToUserId) action.assigneeUserId = rule.assignToUserId;
    }
    if (rule.commentBody) {
      action.commentBody = rule.commentBody;
    }

    // Ensure at least one action field is set
    if (!action.assigneeAgentId && !action.assigneeUserId && !action.priority && !action.status && !action.commentBody) {
      return null;
    }

    return action;
  }

  // --- CRUD ---

  async function list(companyId: string) {
    return db
      .select()
      .from(delegationRules)
      .where(eq(delegationRules.companyId, companyId))
      .orderBy(asc(delegationRules.sortOrder), asc(delegationRules.createdAt));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(delegationRules)
      .where(eq(delegationRules.id, id))
      .then((rows) => rows[0] ?? null);
    return row ?? null;
  }

  async function create(companyId: string, data: {
    name: string;
    description?: string | null;
    ruleType: string;
    triggerOn?: string;
    titlePattern?: string | null;
    matchPriority?: string | null;
    matchStatus?: string | null;
    assignToAgentId?: string | null;
    assignToUserId?: string | null;
    setPriority?: string | null;
    setStatus?: string | null;
    commentBody?: string | null;
    delayMinutes?: number | null;
    sortOrder?: number;
  }) {
    if (!VALID_RULE_TYPES.includes(data.ruleType as any)) {
      throw notFound(`Invalid rule type: ${data.ruleType}. Must be one of: ${VALID_RULE_TYPES.join(", ")}`);
    }
    const triggerOn = data.triggerOn ?? "create";
    if (!VALID_TRIGGERS.includes(triggerOn as any)) {
      throw notFound(`Invalid trigger: ${triggerOn}. Must be one of: ${VALID_TRIGGERS.join(", ")}`);
    }

    // Validate regex if provided
    if (data.titlePattern) {
      try {
        new RegExp(data.titlePattern, "i");
      } catch {
        throw notFound(`Invalid title pattern regex: ${data.titlePattern}`);
      }
    }

    const [rule] = await db
      .insert(delegationRules)
      .values({
        companyId,
        name: data.name,
        description: data.description ?? null,
        ruleType: data.ruleType,
        triggerOn,
        titlePattern: data.titlePattern ?? null,
        matchPriority: data.matchPriority ?? null,
        matchStatus: data.matchStatus ?? null,
        assignToAgentId: data.assignToAgentId ?? null,
        assignToUserId: data.assignToUserId ?? null,
        setPriority: data.setPriority ?? null,
        setStatus: data.setStatus ?? null,
        commentBody: data.commentBody ?? null,
        delayMinutes: data.delayMinutes ?? null,
        sortOrder: data.sortOrder ?? 0,
      })
      .returning();
    return rule;
  }

  async function update(id: string, companyId: string, data: {
    name?: string;
    description?: string | null;
    enabled?: boolean;
    ruleType?: string;
    triggerOn?: string;
    titlePattern?: string | null;
    matchPriority?: string | null;
    matchStatus?: string | null;
    assignToAgentId?: string | null;
    assignToUserId?: string | null;
    setPriority?: string | null;
    setStatus?: string | null;
    commentBody?: string | null;
    delayMinutes?: number | null;
    sortOrder?: number;
  }) {
    const existing = await getById(id);
    if (!existing || existing.companyId !== companyId) {
      return null;
    }

    if (data.ruleType && !VALID_RULE_TYPES.includes(data.ruleType as any)) {
      throw notFound(`Invalid rule type: ${data.ruleType}`);
    }
    if (data.triggerOn && !VALID_TRIGGERS.includes(data.triggerOn as any)) {
      throw notFound(`Invalid trigger: ${data.triggerOn}`);
    }
    if (data.titlePattern) {
      try {
        new RegExp(data.titlePattern, "i");
      } catch {
        throw notFound(`Invalid title pattern regex: ${data.titlePattern}`);
      }
    }

    const [updated] = await db
      .update(delegationRules)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(delegationRules.id, id), eq(delegationRules.companyId, companyId)))
      .returning();
    return updated ?? null;
  }

  async function remove(id: string, companyId: string) {
    const existing = await getById(id);
    if (!existing || existing.companyId !== companyId) {
      return false;
    }
    await db
      .delete(delegationRules)
      .where(and(eq(delegationRules.id, id), eq(delegationRules.companyId, companyId)));
    return true;
  }

  return {
    evaluate,
    list,
    getById,
    create,
    update,
    remove,
    matchRule,
  };
}

export type DelegationRulesService = ReturnType<typeof delegationRulesService>;
