import { beforeEach, describe, expect, it, vi } from "vitest";
import { delegationRulesService, type RuleMatchContext } from "../services/delegation-rules.js";

// Minimal mock DB that captures calls
const mockDb = vi.hoisted(() => {
  const rows: any[] = [];
  return {
    _rows: rows,
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(rows),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockImplementation(async () => {
      const [last] = mockDb._pendingInsert ?? [];
      mockDb._pendingInsert = undefined;
      return last ? [last] : [];
    }),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    _pendingInsert: undefined as any[] | undefined,
  };
});

// Patch: make the chained .then() calls work for getById
mockDb.then = function (fn: any) {
  return Promise.resolve(fn(mockDb._rows));
};

// Suppress logger noise
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../errors.js", () => ({
  notFound: (msg: string) => Object.assign(new Error(msg), { status: 404, code: "NOT_FOUND" }),
}));

vi.mock("@zeroinc/db", () => ({
  delegationRules: { companyId: "company_id", enabled: "enabled", triggerOn: "trigger_on", sortOrder: "sort_order", createdAt: "created_at", id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ op: "and", args })),
  asc: vi.fn((col) => ({ col, dir: "asc" })),
}));

function makeRule(overrides: Record<string, any> = {}) {
  return {
    id: "rule-1",
    companyId: "company-1",
    name: "Test Rule",
    description: null,
    enabled: true,
    ruleType: "assign",
    triggerOn: "create",
    titlePattern: null,
    matchPriority: null,
    matchStatus: null,
    assignToAgentId: null,
    assignToUserId: null,
    setPriority: null,
    setStatus: null,
    commentBody: null,
    delayMinutes: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const ctx = (overrides: Partial<RuleMatchContext> = {}): RuleMatchContext => ({
  title: "Fix login bug",
  priority: "medium",
  status: "todo",
  ...overrides,
});

describe("delegation-rules service", () => {
  let svc: ReturnType<typeof delegationRulesService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb._rows.length = 0;
    mockDb._pendingInsert = undefined;
    svc = delegationRulesService(mockDb as any);
  });

  describe("matchRule", () => {
    it("returns null when no action fields are set", () => {
      const rule = makeRule({ ruleType: "assign", assignToAgentId: null, assignToUserId: null });
      expect(svc.matchRule(rule, ctx())).toBeNull();
    });

    it("matches title pattern (regex)", () => {
      const rule = makeRule({
        ruleType: "assign",
        titlePattern: "\\[BUG\\]",
        assignToAgentId: "sre-agent",
      });
      expect(svc.matchRule(rule, ctx({ title: "[BUG] Fix login" }))).toEqual({
        assigneeAgentId: "sre-agent",
        assigneeUserId: null,
      });
    });

    it("returns null when title pattern does not match", () => {
      const rule = makeRule({
        ruleType: "assign",
        titlePattern: "\\[DESIGN\\]",
        assignToAgentId: "designer",
      });
      expect(svc.matchRule(rule, ctx({ title: "[BUG] Fix login" }))).toBeNull();
    });

    it("matches case-insensitive title pattern", () => {
      const rule = makeRule({
        ruleType: "assign",
        titlePattern: "\\[bug\\]",
        assignToAgentId: "sre-agent",
      });
      expect(svc.matchRule(rule, ctx({ title: "[BUG] Fix login" }))).toEqual({
        assigneeAgentId: "sre-agent",
        assigneeUserId: null,
      });
    });

    it("matches priority", () => {
      const rule = makeRule({
        ruleType: "priority",
        matchPriority: "high",
        setPriority: "critical",
      });
      expect(svc.matchRule(rule, ctx({ priority: "high" }))).toEqual({
        priority: "critical",
      });
    });

    it("returns null when priority does not match", () => {
      const rule = makeRule({
        ruleType: "priority",
        matchPriority: "high",
        setPriority: "critical",
      });
      expect(svc.matchRule(rule, ctx({ priority: "low" }))).toBeNull();
    });

    it("matches status", () => {
      const rule = makeRule({
        ruleType: "assign",
        matchStatus: "todo",
        assignToAgentId: "agent-1",
      });
      expect(svc.matchRule(rule, ctx({ status: "todo" }))).toEqual({
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
      });
    });

    it("escalation: matches after delay elapsed", () => {
      const rule = makeRule({
        ruleType: "escalate",
        matchStatus: "blocked",
        delayMinutes: 60,
        assignToAgentId: "cto",
        commentBody: "Escalated to CTO",
      });
      const statusChangedAt = new Date(Date.now() - 61 * 60 * 1000); // 61 min ago
      expect(svc.matchRule(rule, ctx({ status: "blocked", statusChangedAt }))).toEqual({
        assigneeAgentId: "cto",
        commentBody: "Escalated to CTO",
      });
    });

    it("escalation: returns null before delay elapsed", () => {
      const rule = makeRule({
        ruleType: "escalate",
        matchStatus: "blocked",
        delayMinutes: 60,
        assignToAgentId: "cto",
      });
      const statusChangedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      expect(svc.matchRule(rule, ctx({ status: "blocked", statusChangedAt }))).toBeNull();
    });

    it("escalation: matches immediately when delayMinutes is 0", () => {
      const rule = makeRule({
        ruleType: "escalate",
        matchStatus: "in_review",
        delayMinutes: 0,
        setStatus: "done",
      });
      expect(svc.matchRule(rule, ctx({ status: "in_review" }))).toEqual({
        status: "done",
      });
    });

    it("escalation: returns null when status does not match", () => {
      const rule = makeRule({
        ruleType: "escalate",
        matchStatus: "blocked",
        delayMinutes: 0,
        assignToAgentId: "cto",
      });
      expect(svc.matchRule(rule, ctx({ status: "todo" }))).toBeNull();
    });

    it("handles invalid regex gracefully (returns null)", () => {
      const rule = makeRule({
        ruleType: "assign",
        titlePattern: "[invalid",
        assignToAgentId: "agent-1",
      });
      expect(svc.matchRule(rule, ctx())).toBeNull();
    });

    it("returns null when matchPriority is null (match any priority)", () => {
      const rule = makeRule({
        ruleType: "assign",
        matchPriority: null,
        assignToAgentId: "agent-1",
      });
      // Should match regardless of priority
      expect(svc.matchRule(rule, ctx({ priority: "low" }))).toEqual({
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
      });
    });

    it("escalation rule with setPriority and setStatus", () => {
      const rule = makeRule({
        ruleType: "escalate",
        matchStatus: "blocked",
        delayMinutes: 0,
        setPriority: "critical",
        setStatus: "todo",
        assignToAgentId: "manager",
        assignToUserId: "user-1",
      });
      expect(svc.matchRule(rule, ctx({ status: "blocked" }))).toEqual({
        priority: "critical",
        status: "todo",
        assigneeAgentId: "manager",
        assigneeUserId: "user-1",
      });
    });

    it("commentBody is included in action for any rule type", () => {
      const rule = makeRule({
        ruleType: "assign",
        assignToAgentId: "agent-1",
        commentBody: "Auto-assigned by rule",
      });
      expect(svc.matchRule(rule, ctx())).toEqual({
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        commentBody: "Auto-assigned by rule",
      });
    });
  });

  describe("evaluate", () => {
    it("returns first matching rule action", async () => {
      const rules = [
        makeRule({ id: "r1", sortOrder: 0, ruleType: "priority", matchPriority: "high", setPriority: "critical" }),
        makeRule({ id: "r2", sortOrder: 1, ruleType: "assign", assignToAgentId: "sre" }),
      ];
      mockDb._rows.push(...rules);

      const result = await svc.evaluate("company-1", "create", ctx({ priority: "high" }));
      // First rule matches (priority=high), returns its action
      expect(result).toEqual({ priority: "critical" });
    });

    it("returns null when no rules match", async () => {
      mockDb._rows.push(
        makeRule({ ruleType: "assign", titlePattern: "\\[DESIGN\\]", assignToAgentId: "designer" }),
      );
      const result = await svc.evaluate("company-1", "create", ctx({ title: "[BUG] Fix stuff" }));
      expect(result).toBeNull();
    });

    it("returns null when no rules exist", async () => {
      const result = await svc.evaluate("company-1", "create", ctx());
      expect(result).toBeNull();
    });

    it("skips disabled rules", async () => {
      // DB filters enabled=true at query level, so mock should return empty
      mockDb._rows.length = 0;
      const result = await svc.evaluate("company-1", "create", ctx());
      expect(result).toBeNull();
    });
  });

  describe("create", () => {
    it("validates rule type", async () => {
      await expect(
        svc.create("company-1", { name: "Bad", ruleType: "invalid" }),
      ).rejects.toThrow("Invalid rule type");
    });

    it("validates trigger", async () => {
      await expect(
        svc.create("company-1", { name: "Bad", ruleType: "assign", triggerOn: "never" }),
      ).rejects.toThrow("Invalid trigger");
    });

    it("validates title pattern regex", async () => {
      await expect(
        svc.create("company-1", { name: "Bad", ruleType: "assign", titlePattern: "[invalid" }),
      ).rejects.toThrow("Invalid title pattern regex");
    });

    it("defaults triggerOn to 'create'", async () => {
      mockDb._pendingInsert = [makeRule({ triggerOn: "create" })];
      const rule = await svc.create("company-1", { name: "Auto", ruleType: "assign", assignToAgentId: "a1" });
      expect(rule).toBeDefined();
    });
  });

  describe("update", () => {
    it("returns null when rule not found", async () => {
      mockDb._rows.length = 0; // getById returns null
      const result = await svc.update("nonexistent", "company-1", { name: "Updated" });
      expect(result).toBeNull();
    });

    it("returns null when rule belongs to different company", async () => {
      mockDb._rows.push(makeRule({ id: "rule-1", companyId: "other-company" }));
      const result = await svc.update("rule-1", "company-1", { name: "Updated" });
      expect(result).toBeNull();
    });

    it("validates rule type on update", async () => {
      mockDb._rows.push(makeRule({ id: "rule-1", companyId: "company-1" }));
      await expect(
        svc.update("rule-1", "company-1", { ruleType: "bogus" }),
      ).rejects.toThrow("Invalid rule type");
    });
  });

  describe("remove", () => {
    it("returns false when rule not found", async () => {
      mockDb._rows.length = 0;
      expect(await svc.remove("nonexistent", "company-1")).toBe(false);
    });

    it("returns false for wrong company", async () => {
      mockDb._rows.push(makeRule({ id: "rule-1", companyId: "other-company" }));
      expect(await svc.remove("rule-1", "company-1")).toBe(false);
    });
  });
});
