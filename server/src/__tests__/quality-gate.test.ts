import { describe, expect, it, vi, beforeEach } from "vitest";
import { qualityGateService } from "../services/quality-gate.ts";
import { DEFAULT_QUALITY_GATE_CONFIG } from "@paperclipai/shared";
import { issueComments, agents } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Mock DB — routes queries by table reference
// ---------------------------------------------------------------------------

function createMockDb(options?: {
  commentCount?: number;
  agentRow?: Record<string, unknown> | null;
}) {
  const commentCount = options?.commentCount ?? 1;
  const agentRow = options?.agentRow !== undefined
    ? options.agentRow
    : {
        totalCompleted: 5,
        totalReopened: 1,
        totalBlocked: 0,
        qualityScore: 80,
        qualityStreak: 3,
        lastReopenReasons: [],
      };

  // We identify which table is queried by checking the argument to from()
  function fromFn(table: unknown) {
    if (table === issueComments) {
      return {
        where: vi.fn().mockResolvedValue([{ count: String(commentCount) }]),
      };
    }
    // agents table or any other
    return {
      where: vi.fn().mockResolvedValue(agentRow ? [agentRow] : []),
    };
  }

  const mockDb = {
    select: vi.fn().mockReturnValue({ from: fromFn }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };

  return mockDb as unknown as Parameters<typeof qualityGateService>[0];
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function baseIssueContext(overrides?: Partial<{
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  executionLockedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}>) {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    executionRunId: "run-1",
    executionLockedAt: null,
    startedAt: new Date(Date.now() - 60_000),
    completedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Quality Gate Service", () => {
  describe("resolveConfig", () => {
    it("returns defaults when no config provided", () => {
      const gate = qualityGateService(createMockDb());
      const config = gate.resolveConfig();
      expect(config).toEqual(DEFAULT_QUALITY_GATE_CONFIG);
    });

    it("merges partial config with defaults", () => {
      const gate = qualityGateService(createMockDb());
      const config = gate.resolveConfig({ requireMinimumDuration: 30 });
      expect(config.enabled).toBe(true);
      expect(config.requireMinimumDuration).toBe(30);
      expect(config.requireComment).toBe(true);
    });

    it("allows disabling quality gates", () => {
      const gate = qualityGateService(createMockDb());
      const config = gate.resolveConfig({ enabled: false });
      expect(config.enabled).toBe(false);
    });
  });

  describe("runChecks", () => {
    it("passes all checks for a valid completion", async () => {
      const gate = qualityGateService(createMockDb({ commentCount: 2 }));
      const ctx = baseIssueContext();
      const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

      expect(result.passed).toBe(true);
      expect(result.checks.length).toBe(3);
      expect(result.checks.every((c) => c.pass)).toBe(true);
    });

    it("skips all checks when disabled", async () => {
      const gate = qualityGateService(createMockDb({ commentCount: 0 }));
      const ctx = baseIssueContext();
      const config = { ...DEFAULT_QUALITY_GATE_CONFIG, enabled: false };
      const result = await gate.runChecks(ctx, config);

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([]);
    });

    describe("comment required check", () => {
      it("fails when no comments exist", async () => {
        const gate = qualityGateService(createMockDb({ commentCount: 0 }));
        const ctx = baseIssueContext();
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const commentCheck = result.checks.find((c) => c.message.includes("comment"));
        expect(commentCheck).toBeDefined();
        expect(commentCheck!.pass).toBe(false);
        expect(commentCheck!.severity).toBe("blocker");
      });

      it("passes when comments exist", async () => {
        const gate = qualityGateService(createMockDb({ commentCount: 1 }));
        const ctx = baseIssueContext();
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const commentCheck = result.checks.find((c) => c.message.includes("comment"));
        expect(commentCheck!.pass).toBe(true);
      });

      it("is skipped when requireComment is false", async () => {
        const gate = qualityGateService(createMockDb({ commentCount: 0 }));
        const ctx = baseIssueContext();
        const config = { ...DEFAULT_QUALITY_GATE_CONFIG, requireComment: false };
        const result = await gate.runChecks(ctx, config);

        expect(result.checks.length).toBe(2);
      });
    });

    describe("duration sanity check", () => {
      it("fails when task completed too quickly", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({
          startedAt: new Date(Date.now() - 3_000),
        });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const durationCheck = result.checks.find((c) => c.message.includes("completed in"));
        expect(durationCheck).toBeDefined();
        expect(durationCheck!.pass).toBe(false);
        expect(durationCheck!.severity).toBe("blocker");
      });

      it("passes when task took sufficient time", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({
          startedAt: new Date(Date.now() - 60_000),
        });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const durationCheck = result.checks.find((c) => c.message.includes("Duration"));
        expect(durationCheck!.pass).toBe(true);
      });

      it("skips check when no startedAt timestamp", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({ startedAt: null });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const durationCheck = result.checks.find((c) => c.message.includes("startedAt"));
        expect(durationCheck).toBeDefined();
        expect(durationCheck!.pass).toBe(true);
        expect(durationCheck!.message).toContain("skipped");
      });
    });

    describe("stale lock check", () => {
      it("fails when execution lock is still held", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({ executionLockedAt: new Date() });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const lockCheck = result.checks.find((c) => c.message.includes("lock"));
        expect(lockCheck!.pass).toBe(false);
        expect(lockCheck!.severity).toBe("blocker");
      });

      it("passes when no execution lock", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({ executionLockedAt: null });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const lockCheck = result.checks.find((c) => c.message.includes("lock"));
        expect(lockCheck!.pass).toBe(true);
      });
    });

    describe("overall result", () => {
      it("marks as failed when any blocker fails", async () => {
        const gate = qualityGateService(createMockDb({ commentCount: 0 }));
        const ctx = baseIssueContext({
          startedAt: new Date(Date.now() - 3_000),
          executionLockedAt: new Date(),
        });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        expect(result.passed).toBe(false);
        const blockers = result.checks.filter((c) => !c.pass && c.severity === "blocker");
        expect(blockers.length).toBe(3);
      });
    });
  });

  describe("recordCompletion", () => {
    it("calls db.update on pass", async () => {
      const db = createMockDb();
      const gate = qualityGateService(db);
      await gate.recordCompletion("agent-1", true, []);

      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("calls db.update on failure", async () => {
      const db = createMockDb();
      const gate = qualityGateService(db);
      await gate.recordCompletion("agent-1", false, ["No comment", "Too fast"]);

      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("getAgentQualityScore", () => {
    it("returns quality data for existing agent", async () => {
      const db = createMockDb({
        agentRow: {
          totalCompleted: 10,
          totalReopened: 2,
          totalBlocked: 1,
          qualityScore: 80,
          qualityStreak: 5,
          lastReopenReasons: ["old reason"],
        },
      });
      const gate = qualityGateService(db);
      const score = await gate.getAgentQualityScore("agent-1");

      expect(score).toEqual({
        totalCompleted: 10,
        totalReopened: 2,
        totalBlocked: 1,
        qualityScore: 80,
        qualityStreak: 5,
        lastReopenReasons: ["old reason"],
      });
    });

    it("returns null for non-existent agent", async () => {
      const db = createMockDb({ agentRow: null });
      const gate = qualityGateService(db);
      const score = await gate.getAgentQualityScore("nonexistent");

      expect(score).toBeNull();
    });
  });
});
